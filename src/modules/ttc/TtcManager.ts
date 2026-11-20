import { ArcType, Cartesian3, Color, JulianDate } from "@cesium/core";
import { CallbackProperty, CustomDataSource, Entity, PolylineGlowMaterialProperty, PolylineGraphics } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { watch, type WatchStopHandle } from "vue";

import type { CesiumController } from "@/modules/CesiumController";
import { useControlCenterStore, type InterSatelliteLink, type ModelChoice } from "@/stores/controlCenter";
import { useSatStore } from "@/stores/sat";

import { groundLinkStats, interSatelliteStats } from "./linkGeometry";
import { clearAttitudeAngles, clearModelOverride, modelOverrideOf, setAttitudeAngles, setModelOverride, setPanelAngle } from "./state";

export type TtcCommand = "telemetry" | "attitude" | "panels-deploy" | "panels-stow";

const COMMAND_TEXT: Record<TtcCommand, string> = {
  telemetry: "遥测查询 (TLM-REQ)",
  attitude: "姿态参数查询 (ATT-REQ)",
  "panels-deploy": "太阳翼展开指令 (CMD-PANEL-DEPLOY)",
  "panels-stow": "太阳翼收拢指令 (CMD-PANEL-STOW)",
};

const PANEL_DEGREES_PER_SECOND = 70;
const STATS_INTERVAL_MS = 500;
const HEARTBEAT_MS = 5000;
const MIRROR_INTERVAL_MS = 120;

/**
 * The TT&C panel's scene side: the ground and inter-satellite links, the attitude and
 * solar-panel animation, and the simulated command and telemetry traffic. Started once
 * from app.ts, like startSceneSync, so it outlives the panel.
 */
export class TtcManager {
  readonly viewer: Viewer;

  readonly #cc: CesiumController;

  readonly #store: ReturnType<typeof useControlCenterStore>;

  readonly #satStore: ReturnType<typeof useSatStore>;

  readonly #links = new CustomDataSource("ttc-links");

  readonly #stops: WatchStopHandle[] = [];

  readonly #islEntities = new Map<number, Entity>();

  readonly #modelNames = new Set<string>();

  #lockTimer: ReturnType<typeof setInterval> | undefined;

  readonly #tick = (): void => this.#onTick();

  #statsAt = 0;

  #telemetryAt = 0;

  #spinWriteAt = 0;

  #panelWriteAt = 0;

  #liveSpinYaw = 0;

  #livePanel = 0;

  #lastFrame = 0;

  #disposed = false;

  constructor(cc: CesiumController) {
    this.#cc = cc;
    this.viewer = cc.viewer;
    this.#store = useControlCenterStore();
    this.#satStore = useSatStore();

    void this.viewer.dataSources.add(this.#links);
    this.#createGroundLink();

    this.#stops.push(
      watch(
        () => [this.#store.roll, this.#store.pitch, this.#store.yaw] as const,
        () => this.#applyAttitude(),
      ),
      watch(
        () => this.#store.lockedName,
        (name, previous) => this.#onLockChanged(name, previous),
      ),
      // The angle itself is animated in #onTick: writing the target here would snap the
      // panel to its destination for a frame before the animation started.
      watch(
        () => this.#store.panelTarget,
        () => this.#requestRender(),
      ),
      watch(() => this.#store.modelOverrides, () => this.#syncModels(), { deep: true }),
      watch(() => this.#store.interSatelliteLinks, (links) => this.#syncInterSatelliteLinks(links), { deep: true, immediate: true }),
      watch(
        () => this.#store.follow,
        (follow) => {
          const name = this.#store.lockedName;
          if (name === "") {
            return;
          }
          if (follow) {
            this.#satStore.trackedSatellite = name;
          } else if (this.#satStore.trackedSatellite === name) {
            this.#satStore.trackedSatellite = "";
          }
        },
      ),
    );

    this.viewer.clock.onTick.addEventListener(this.#tick);
    this.#applyAttitude();
  }

  lock(name: string): void {
    this.#store.lock(name);
  }

  unlock(): void {
    this.#store.unlock();
  }

  /** Applies a chosen model to the satellite, or its manifest model when undefined. */
  setModel(name: string, choice: ModelChoice | undefined): void {
    if (name === "") {
      return;
    }
    if (choice) {
      this.#store.setModelOverride(name, choice);
    } else {
      this.#store.clearModelOverride(name);
    }
  }

  /** A simulated ground command: uplink frame now, acknowledgement after the light time. */
  sendCommand(kind: TtcCommand): void {
    const store = this.#store;
    const name = store.lockedName;
    if (name === "") {
      this.#warn("未锁定卫星：请先在「清单」中锁定一颗卫星");
      return;
    }
    const time = this.viewer.clock.currentTime;
    const at = this.#timeLabel(time);
    const satellite = this.#cc.sats.getSatellite(name)?.props.trajectory.position(time);
    const station = this.#station();
    if (!satellite) {
      this.#warn("等待卫星轨迹加载…", at);
      return;
    }
    if (!station) {
      this.#warn("未配置地面站：请在「链路」页添加一个地面站", at);
      return;
    }
    const stats = groundLinkStats(satellite, station.position);
    store.setGroundStats({ ...stats, updatedAt: at });
    if (!stats.visible) {
      this.#warn(`上行不可达：当前仰角 ${stats.elevationDeg.toFixed(1)}°，卫星在地平线以下（可在时钟面板调整时间等待过境）`, at);
      return;
    }
    const text = COMMAND_TEXT[kind];
    store.log({ at, channel: "ground", direction: "uplink", from: station.name, to: name, text });
    const delay = Math.max(400, Math.round(stats.latencyMs));
    setTimeout(() => {
      if (this.#disposed) {
        return;
      }
      store.log({
        at: this.#timeLabel(this.viewer.clock.currentTime),
        channel: "ground",
        direction: "downlink",
        from: name,
        to: station.name,
        text: `ACK「${text}」· 卫星已执行`,
      });
      this.#applyCommand(kind, name);
      if (kind === "telemetry" || kind === "attitude") {
        this.#logTelemetry(name, station.name);
      }
    }, delay);
    this.#requestRender();
  }

  /** An external HTTP uplink frame: the same link guard as a command, with the caller's text. */
  sendUplink(text: string): void {
    const store = this.#store;
    const name = store.lockedName;
    const time = this.viewer.clock.currentTime;
    const at = this.#timeLabel(time);
    if (name === "") {
      this.#warn("外部上行被忽略：未锁定卫星", at);
      return;
    }
    const station = this.#station();
    if (!station) {
      this.#warn("外部上行被忽略：未配置地面站", at);
      return;
    }
    const satellite = this.#cc.sats.getSatellite(name)?.props.trajectory.position(time);
    if (!satellite) {
      this.#warn("外部上行等待卫星轨迹加载…", at);
      return;
    }
    const stats = groundLinkStats(satellite, station.position);
    store.setGroundStats({ ...stats, updatedAt: at });
    if (!stats.visible) {
      this.#warn(`外部上行不可达：当前仰角 ${stats.elevationDeg.toFixed(1)}°，卫星在地平线以下`, at);
      return;
    }
    store.log({ at, channel: "ground", direction: "uplink", from: station.name, to: name, text: `外部 HTTP 上行 · ${text}` });
    setTimeout(() => {
      if (this.#disposed) {
        return;
      }
      store.log({
        at: this.#timeLabel(this.viewer.clock.currentTime),
        channel: "ground",
        direction: "downlink",
        from: name,
        to: station.name,
        text: `DATA-ACK · 已接收 ${new TextEncoder().encode(text).length} B`,
      });
    }, Math.max(400, Math.round(stats.latencyMs)));
    this.#requestRender();
  }

  /** An external HTTP downlink frame, logged as arriving from the satellite. */
  sendDownlink(text: string): void {
    const store = this.#store;
    const name = store.lockedName;
    const at = this.#timeLabel(this.viewer.clock.currentTime);
    if (name === "") {
      this.#warn("外部下行被忽略：未锁定卫星", at);
      return;
    }
    const station = this.#station();
    store.log({ at, channel: "ground", direction: "downlink", from: name, to: station?.name ?? "地面站", text: `外部 HTTP 下行 · ${text}` });
  }

  /** A simulated inter-satellite packet across `id`. */
  sendInterSatellitePacket(id: number): void {
    const link = this.#store.interSatelliteLinks.find((candidate) => candidate.id === id);
    if (!link) {
      return;
    }
    const time = this.viewer.clock.currentTime;
    const at = this.#timeLabel(time);
    const a = this.#cc.sats.getSatellite(link.a)?.props.trajectory.position(time);
    const b = this.#cc.sats.getSatellite(link.b)?.props.trajectory.position(time);
    if (!a || !b) {
      this.#warn("等待星间链路两端的轨迹加载…", at);
      return;
    }
    const stats = interSatelliteStats(a, b);
    this.#store.setIslStats(id, { ...stats, updatedAt: at });
    if (!stats.visible) {
      this.#store.log({ at, channel: "isl", direction: "warn", from: link.a, to: link.b, text: "星间链路被地球遮挡，数据包无法送达" });
      return;
    }
    this.#store.log({ at, channel: "isl", direction: "uplink", from: link.a, to: link.b, text: `ISL 数据包 512 B · 距离 ${stats.distanceKm.toFixed(0)} km` });
    setTimeout(() => {
      if (this.#disposed) {
        return;
      }
      this.#store.log({
        at: this.#timeLabel(this.viewer.clock.currentTime),
        channel: "isl",
        direction: "downlink",
        from: link.b,
        to: link.a,
        text: `ISL ACK · 单向时延 ${Math.round(stats.latencyMs)} ms`,
      });
    }, Math.max(300, Math.round(stats.latencyMs)));
    this.#requestRender();
  }

  dispose(): void {
    this.#disposed = true;
    this.viewer.clock.onTick.removeEventListener(this.#tick);
    if (this.#lockTimer !== undefined) {
      clearInterval(this.#lockTimer);
    }
    this.#stops.forEach((stop) => stop());
    void this.viewer.dataSources.remove(this.#links, true);
  }

  #applyAttitude(): void {
    const name = this.#store.lockedName;
    if (name === "") {
      return;
    }
    this.#liveSpinYaw = this.#store.yaw;
    setAttitudeAngles(name, { roll: this.#store.roll, pitch: this.#store.pitch, yaw: this.#store.yaw });
    this.#requestRender();
  }

  #onLockChanged(name: string, previous: string): void {
    if (previous !== "") {
      clearAttitudeAngles(previous);
      if (this.#satStore.trackedSatellite === previous) {
        this.#satStore.trackedSatellite = "";
      }
    }
    if (name === "") {
      this.#store.setHasModel(false);
      this.#requestRender();
      return;
    }
    this.#satStore.activateSatellite(name, this.#cc.sats.catalog);
    this.#liveSpinYaw = this.#store.yaw;
    this.#livePanel = this.#store.panelAngle;
    setAttitudeAngles(name, { roll: this.#store.roll, pitch: this.#store.pitch, yaw: this.#store.yaw });
    setPanelAngle(name, this.#store.panelAngle);
    this.#ensureModel(name);
    this.#requestRender();
  }

  /** Activates the satellite in the store; the manager builds it asynchronously. */
  #ensureModel(name: string): void {
    const attempt = (): boolean => {
      const satellite = this.#cc.sats.getSatellite(name);
      if (!satellite) {
        return false;
      }
      if (!("3D model" in satellite.components)) {
        satellite.enableComponent("3D model");
        this.#requestRender();
      }
      const hasModel = "3D model" in satellite.components;
      if (this.#store.lockedName === name) {
        this.#store.setHasModel(hasModel);
        // Tracking starts after the model exists: the camera frames the model, not the
        // point that stood in for it while the satellite was building.
        if (this.#store.follow && this.#satStore.trackedSatellite !== name) {
          this.#satStore.trackedSatellite = name;
        }
      }
      return true;
    };
    if (attempt()) {
      return;
    }
    if (this.#lockTimer !== undefined) {
      clearInterval(this.#lockTimer);
    }
    let tries = 0;
    this.#lockTimer = setInterval(() => {
      tries += 1;
      if (this.#disposed || this.#store.lockedName !== name || attempt() || tries > 40) {
        if (this.#lockTimer !== undefined) {
          clearInterval(this.#lockTimer);
        }
        this.#lockTimer = undefined;
      }
    }, 250);
  }

  #onTick(): void {
    const now = performance.now();
    const delta = this.#lastFrame === 0 ? 0 : Math.min(0.1, (now - this.#lastFrame) / 1000);
    this.#lastFrame = now;
    const store = this.#store;
    const name = store.lockedName;

    if (name !== "") {
      if (store.spinRate !== 0) {
        this.#liveSpinYaw = ((this.#liveSpinYaw + store.spinRate * delta + 180) % 360) - 180;
        setAttitudeAngles(name, { roll: store.roll, pitch: store.pitch, yaw: this.#liveSpinYaw });
        if (now - this.#spinWriteAt > MIRROR_INTERVAL_MS) {
          this.#spinWriteAt = now;
          store.setAttitude({ yaw: this.#liveSpinYaw });
        }
        this.#requestRender();
      }
      if (Math.abs(this.#livePanel - store.panelTarget) > 0.05) {
        const remaining = store.panelTarget - this.#livePanel;
        const step = Math.sign(remaining) * PANEL_DEGREES_PER_SECOND * delta;
        this.#livePanel = Math.abs(step) >= Math.abs(remaining) ? store.panelTarget : this.#livePanel + step;
        setPanelAngle(name, this.#livePanel);
        if (now - this.#panelWriteAt > MIRROR_INTERVAL_MS) {
          this.#panelWriteAt = now;
          store.setPanelAngle(this.#livePanel);
        }
        this.#requestRender();
      }
    }

    if (now - this.#statsAt > STATS_INTERVAL_MS) {
      this.#statsAt = now;
      this.#updateStats(now);
    }
  }

  #updateStats(now: number): void {
    const time = this.viewer.clock.currentTime;
    const at = this.#timeLabel(time);
    const name = this.#store.lockedName;
    const station = this.#station();
    const satellite = name === "" ? undefined : this.#cc.sats.getSatellite(name)?.props.trajectory.position(time);

    if (satellite && station) {
      this.#store.setGroundStats({ ...groundLinkStats(satellite, station.position), updatedAt: at });
    } else {
      this.#store.setGroundStats({ visible: false, updatedAt: at });
    }

    for (const link of this.#store.interSatelliteLinks) {
      const a = this.#cc.sats.getSatellite(link.a)?.props.trajectory.position(time);
      const b = this.#cc.sats.getSatellite(link.b)?.props.trajectory.position(time);
      this.#store.setIslStats(link.id, a && b ? { ...interSatelliteStats(a, b), updatedAt: at } : { visible: false, updatedAt: at });
    }

    if (this.#store.autoTelemetry && this.#store.groundStats.visible && name !== "" && station) {
      if (now - this.#telemetryAt > HEARTBEAT_MS) {
        this.#telemetryAt = now;
        this.#logTelemetry(name, station.name);
      }
    }
    this.#requestRender();
  }

  #applyCommand(kind: TtcCommand, name: string): void {
    if (this.#store.lockedName !== name) {
      return;
    }
    if (kind === "panels-deploy") {
      this.#store.setPanelTarget(0);
    } else if (kind === "panels-stow") {
      this.#store.setPanelTarget(90);
    }
    this.#requestRender();
  }

  #logTelemetry(name: string, to: string): void {
    const store = this.#store;
    const battery = (82 + Math.random() * 12).toFixed(1);
    const temperature = (18 + Math.random() * 8).toFixed(1);
    store.log({
      at: this.#timeLabel(this.viewer.clock.currentTime),
      channel: "ground",
      direction: "downlink",
      from: name,
      to,
      text: `TLM 电池 ${battery}% · 温度 ${temperature}°C · 姿态 R${store.roll.toFixed(0)}° P${store.pitch.toFixed(0)}° Y${store.yaw.toFixed(0)}° · 太阳翼 ${store.panelAngle.toFixed(0)}°`,
    });
  }

  #warn(text: string, at?: string): void {
    this.#store.log({
      at: at ?? this.#timeLabel(this.viewer.clock.currentTime),
      channel: "ground",
      direction: "warn",
      from: "测运控",
      to: this.#store.lockedName || "—",
      text,
    });
  }

  #station(): { position: Cartesian3; name: string } | undefined {
    const stations = this.#satStore.groundStations;
    if (stations.length === 0) {
      return undefined;
    }
    const index = Math.min(this.#store.stationIndex, stations.length - 1);
    const station = stations[index];
    if (!station) {
      return undefined;
    }
    return { position: Cartesian3.fromDegrees(station.lon, station.lat, 0), name: station.name ?? `站点 ${index + 1}` };
  }

  #createGroundLink(): void {
    this.#links.entities.add(
      new Entity({
        name: "TT&C 星地链路",
        polyline: new PolylineGraphics({
          positions: new CallbackProperty((time?: JulianDate) => this.#groundPositions(time as JulianDate), false),
          width: 2,
          arcType: ArcType.NONE,
          material: new PolylineGlowMaterialProperty({
            glowPower: 0.35,
            color: new CallbackProperty(() => (this.#store.groundStats.visible ? Color.LIME : Color.ORANGERED), false),
          }),
          show: new CallbackProperty((time?: JulianDate) => this.#groundPositions(time as JulianDate) !== undefined, false),
        }),
      }),
    );
  }

  #groundPositions(time: JulianDate): Cartesian3[] | undefined {
    const name = this.#store.lockedName;
    if (name === "") {
      return undefined;
    }
    const satellite = this.#cc.sats.getSatellite(name)?.props.trajectory.position(time);
    const station = this.#station()?.position;
    return satellite && station ? [station, satellite] : undefined;
  }

  #syncInterSatelliteLinks(links: InterSatelliteLink[]): void {
    const kept = new Set(links.map((link) => link.id));
    for (const [id, entity] of this.#islEntities) {
      if (!kept.has(id)) {
        this.#links.entities.remove(entity);
        this.#islEntities.delete(id);
      }
    }
    for (const link of links) {
      if (this.#islEntities.has(link.id)) {
        continue;
      }
      const entity = new Entity({
        name: `TT&C 星间链路 ${link.a} ↔ ${link.b}`,
        polyline: new PolylineGraphics({
          positions: new CallbackProperty((time?: JulianDate) => this.#islPositions(link, time as JulianDate), false),
          width: 2,
          arcType: ArcType.NONE,
          material: new PolylineGlowMaterialProperty({
            glowPower: 0.3,
            color: new CallbackProperty(() => (this.#store.islStats[link.id]?.visible ? Color.CYAN : Color.ORANGERED), false),
          }),
        }),
      });
      this.#islEntities.set(link.id, entity);
      this.#links.entities.add(entity);
    }
    this.#requestRender();
  }

  #islPositions(link: InterSatelliteLink, time: JulianDate): Cartesian3[] | undefined {
    const a = this.#cc.sats.getSatellite(link.a)?.props.trajectory.position(time);
    const b = this.#cc.sats.getSatellite(link.b)?.props.trajectory.position(time);
    return a && b ? [a, b] : undefined;
  }

  /** Keeps the render-loop registry in step with the store's reactive mirror. */
  #syncModels(): void {
    const overrides = this.#store.modelOverrides;
    for (const [name, choice] of Object.entries(overrides)) {
      const current = modelOverrideOf(name);
      if (!current || current.url !== choice.url) {
        setModelOverride(name, choice);
        this.#modelNames.add(name);
        this.#recreateModel(name);
      }
    }
    for (const name of [...this.#modelNames]) {
      if (!(name in overrides)) {
        clearModelOverride(name);
        this.#modelNames.delete(name);
        this.#recreateModel(name);
      }
    }
  }

  #recreateModel(name: string): void {
    const satellite = this.#cc.sats.getSatellite(name);
    if (!satellite) {
      return;
    }
    if ("3D model" in satellite.components) {
      satellite.disableComponent("3D model");
    }
    satellite.enableComponent("3D model");
    if (this.#store.lockedName === name) {
      this.#store.setHasModel("3D model" in satellite.components);
    }
    this.#requestRender();
  }

  #timeLabel(time: JulianDate): string {
    return JulianDate.toDate(time).toISOString().slice(11, 19);
  }

  #requestRender(): void {
    this.viewer.scene.requestRender();
  }
}

let manager: TtcManager | undefined;

/** One per page, started from app.ts after Pinia: the watches read its stores. */
export function startTtc(cc: CesiumController): TtcManager {
  manager?.dispose();
  manager = new TtcManager(cc);
  return manager;
}

export function getTtcManager(): TtcManager {
  if (!manager) {
    throw new Error("The TT&C manager has not been started");
  }
  return manager;
}
