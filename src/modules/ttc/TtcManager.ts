import { ArcType, BoundingSphere, Cartesian3, Color, JulianDate } from "@cesium/core";
import { BoxGraphics, CallbackProperty, CustomDataSource, Entity, PolylineGlowMaterialProperty, PolylineGraphics, VelocityOrientationProperty, type PositionProperty } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";
import { watch, type WatchStopHandle } from "vue";

import type { CesiumController } from "@/modules/CesiumController";
import { useControlCenterStore, type InterSatelliteLink, type ModelChoice } from "@/stores/controlCenter";
import { useSatStore } from "@/stores/sat";

import { TTC_HIGHLIGHT_COLORS, type TtcHighlightColor } from "./highlight";
import { groundLinkStats, interSatelliteStats } from "./linkGeometry";
import { OffsetOrientationProperty } from "./OffsetOrientationProperty";
import { attitudeQuaternionOf, clearAttitudeAngles, clearModelOverride, modelOverrideOf, setAttitudeAngles, setModelOverride, setPanelAngle } from "./state";

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
/** The highlight box keeps at least this many drawing-buffer pixels across: visible
 *  from the global view, but small enough not to swamp the satellite. */
const HIGHLIGHT_MIN_SCREEN_PIXELS = 32;
/** A tight fit around the model's bounding sphere, which the 2× diameter would enclose. */
const HIGHLIGHT_MODEL_SCALE = 2.05;
/** One yellow pulse crosses the inter-satellite line per period, tail included. */
const INTERLINK_PULSE_MS = 1200;
const INTERLINK_PULSE_FRACTION = 0.18;
const BLINK_HALF_MS = 300;

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

  /** The highlight box around the locked satellite's model, and what it was built for. */
  #highlightEntity: Entity | undefined;

  #highlightName = "";

  #highlightColorKey = "";

  #highlightRetryAt = 0;

  #highlightSelectionStop: (() => void) | undefined;

  /** Whether the lock in progress should start tracking; an implicit HTTP lock must not. */
  #followNextLock = true;

  /** The boxes and lines a pick should not select; it belongs to a satellite or nothing. */
  readonly #overlayEntities = new Set<Entity>();

  #interlinkBoxFrom: Entity | undefined;

  #interlinkBoxTo: Entity | undefined;

  #interlinkBase: Entity | undefined;

  #interlinkPulse: Entity | undefined;

  #interlinkFromName = "";

  #interlinkToName = "";

  #interlinkRetryAt = 0;

  readonly #pulseStart = new Cartesian3();

  readonly #pulseEnd = new Cartesian3();

  readonly #highlightSphere = new BoundingSphere();

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
        () => [this.#store.lockedName, this.#store.hasModel, this.#store.highlightColor, this.#store.highlightEffect, this.#store.highlightUntil] as const,
        () => this.#syncHighlight(),
        { immediate: true },
      ),
      watch(
        () => [this.#store.interlinkFrom, this.#store.interlinkTo, this.#store.interlinkUntil] as const,
        () => this.#syncInterlink(),
        { immediate: true },
      ),
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

    // A pick on a highlight box or an inter-satellite line should keep acting on the
    // satellite, not select a transparent overlay the info panel cannot resolve.
    this.#highlightSelectionStop = this.viewer.selectedEntityChanged.addEventListener(() => {
      const selected = this.viewer.selectedEntity;
      if (selected !== undefined && this.#overlayEntities.has(selected)) {
        const satellite = this.#store.lockedName === "" ? undefined : this.#cc.sats.getSatellite(this.#store.lockedName);
        this.viewer.selectedEntity = satellite?.defaultEntity;
      }
    });

    this.viewer.clock.onTick.addEventListener(this.#tick);
    this.#applyAttitude();
  }

  /** `follow: false` locks without starting the camera follow, for an HTTP-named action. */
  lock(name: string, follow = true): void {
    this.#followNextLock = follow;
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
    this.#highlightSelectionStop?.();
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
      // An implicit HTTP lock leaves the camera exactly where it was, tracking included.
      if ((name === "" || this.#followNextLock) && this.#satStore.trackedSatellite === previous) {
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
        // Tracking starts after the model exists, and only when this lock asked to
        // follow: an HTTP action's implicit lock must not move the operator's view.
        const follow = this.#followNextLock;
        this.#followNextLock = true;
        if (follow && this.#store.follow && this.#satStore.trackedSatellite !== name) {
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

  /** Builds, replaces, or drops the semi-transparent box around the locked model. */
  #syncHighlight(): void {
    const store = this.#store;
    const name = store.lockedName;
    const colorKey = store.highlightColor;
    const active = name !== "" && colorKey !== "" && store.highlightUntil > Date.now();
    if (!active) {
      this.#removeHighlight();
      return;
    }
    if (this.#highlightEntity !== undefined && this.#highlightName === name && this.#highlightColorKey === colorKey) {
      this.#requestRender();
      return;
    }
    this.#removeHighlight();
    const position = this.#cc.sats.getSatellite(name)?.props.trajectory.entityPosition;
    if (!position) {
      // The satellite may still be building; #onTick retries while the highlight is live.
      return;
    }
    this.#createHighlight(name, position, colorKey);
  }

  #createHighlight(name: string, position: PositionProperty, colorKey: string): void {
    const css = TTC_HIGHLIGHT_COLORS[colorKey as TtcHighlightColor] ?? TTC_HIGHLIGHT_COLORS.white;
    const entity = this.#createBoxEntity(name, position, Color.fromCssColorString(css), "高亮框", () => this.#highlightVisible());
    this.#links.entities.add(entity);
    this.#overlayEntities.add(entity);
    this.#highlightEntity = entity;
    this.#highlightName = name;
    this.#highlightColorKey = colorKey;
    this.#requestRender();
  }

  /** A model-sized translucent box; `visible` drives steady/blinking and the expiry. */
  #createBoxEntity(name: string, position: PositionProperty, color: Color, label: string, visible: () => boolean): Entity {
    const entity = new Entity({
      name: `TT&C ${label} ${name}`,
      box: new BoxGraphics({
        // The model's measured radius, and its LOD as that loads, but never smaller on
        // screen than a readable marker: the global view still shows it.
        dimensions: new CallbackProperty((time?: JulianDate, result?: Cartesian3) => {
          const radius = this.#cc.sats.getSatellite(name)?.model.radius() ?? 2.5;
          let side = HIGHLIGHT_MODEL_SCALE * radius;
          const world = position.getValue(time ?? this.viewer.clock.currentTime);
          const scene = this.viewer.scene;
          if (world && scene.drawingBufferWidth > 0 && scene.drawingBufferHeight > 0) {
            Cartesian3.clone(world, this.#highlightSphere.center);
            this.#highlightSphere.radius = radius;
            const metresPerPixel = scene.camera.getPixelSize(this.#highlightSphere, scene.drawingBufferWidth, scene.drawingBufferHeight);
            if (Number.isFinite(metresPerPixel) && metresPerPixel > 0) {
              side = Math.max(side, HIGHLIGHT_MIN_SCREEN_PIXELS * metresPerPixel);
            }
          }
          return Cartesian3.fromElements(side, side, side, result ?? new Cartesian3());
        }, false),
        material: color.withAlpha(0.25),
        outline: true,
        outlineColor: color.withAlpha(0.95),
        outlineWidth: 2,
        show: new CallbackProperty(() => visible(), false),
      }),
    });
    entity.position = position as typeof entity.position;
    const velocity = new VelocityOrientationProperty(position);
    entity.orientation = new OffsetOrientationProperty(velocity, () => attitudeQuaternionOf(name)) as unknown as typeof entity.orientation;
    return entity;
  }

  #removeHighlight(): void {
    if (this.#highlightEntity !== undefined) {
      this.#links.entities.remove(this.#highlightEntity);
      this.#overlayEntities.delete(this.#highlightEntity);
      this.#highlightEntity = undefined;
    }
    this.#highlightName = "";
    this.#highlightColorKey = "";
    this.#requestRender();
  }

  /** 300 ms on, 300 ms off while blinking; wall clock, so a paused clock still blinks. */
  #highlightVisible(): boolean {
    const store = this.#store;
    if (store.highlightColor === "" || store.highlightUntil <= Date.now()) {
      return false;
    }
    if (store.highlightEffect === "steady") {
      return true;
    }
    return Math.floor(Date.now() / BLINK_HALF_MS) % 2 === 0;
  }

  /**
   * The two-satellite demo, named by HTTP: green blinking at `from`, red blinking at
   * `to`, and a yellow pulse crossing the line between them. It locks nothing and does
   * not touch the camera; both satellites are activated so their positions exist.
   */
  setInterlink(from: string, to: string, durationSeconds: number): void {
    if (from === "" || to === "" || from === to) {
      this.#warn("星间通信演示需要两个不同的卫星名称");
      return;
    }
    const catalog = this.#cc.sats.catalog;
    const missing = !catalog.getByName(from) ? from : !catalog.getByName(to) ? to : "";
    if (missing !== "") {
      this.#warn(`星间通信演示：未找到卫星 ${missing}`);
      return;
    }
    this.#satStore.activateSatellite(from, catalog);
    this.#satStore.activateSatellite(to, catalog);
    this.#store.setInterlink(from, to, durationSeconds);
  }

  clearInterlink(): void {
    this.#store.clearInterlink();
  }

  #syncInterlink(): void {
    const store = this.#store;
    if (!this.#interlinkActive()) {
      this.#removeInterlink();
      return;
    }
    if (this.#interlinkBase !== undefined && this.#interlinkFromName === store.interlinkFrom && this.#interlinkToName === store.interlinkTo) {
      this.#requestRender();
      return;
    }
    const from = this.#cc.sats.getSatellite(store.interlinkFrom);
    const to = this.#cc.sats.getSatellite(store.interlinkTo);
    const fromPosition = from?.props.trajectory.entityPosition;
    const toPosition = to?.props.trajectory.entityPosition;
    if (!from || !to || !fromPosition || !toPosition) {
      // The pair may still be building; #onTick retries while the demo is live.
      return;
    }
    this.#removeInterlink();
    this.#createInterlink(store.interlinkFrom, store.interlinkTo, fromPosition, toPosition);
  }

  #createInterlink(from: string, to: string, fromPosition: PositionProperty, toPosition: PositionProperty): void {
    const green = Color.fromCssColorString(TTC_HIGHLIGHT_COLORS.green);
    const red = Color.fromCssColorString(TTC_HIGHLIGHT_COLORS.red);
    const yellow = Color.fromCssColorString(TTC_HIGHLIGHT_COLORS.yellow);
    const fromBox = this.#createBoxEntity(from, fromPosition, green, "星间通信起点", () => this.#interlinkBlink());
    const toBox = this.#createBoxEntity(to, toPosition, red, "星间通信终点", () => this.#interlinkBlink());
    const base = new Entity({
      name: `TT&C 星间通信 ${from} → ${to}`,
      polyline: new PolylineGraphics({
        positions: new CallbackProperty((time?: JulianDate) => this.#interlinkPositions(time as JulianDate), false),
        width: 2,
        arcType: ArcType.NONE,
        material: new PolylineGlowMaterialProperty({ glowPower: 0.35, color: yellow.withAlpha(0.75) }),
        show: new CallbackProperty(() => this.#interlinkActive(), false),
      }),
    });
    const pulse = new Entity({
      name: `TT&C 星间流光 ${from} → ${to}`,
      polyline: new PolylineGraphics({
        positions: new CallbackProperty((time?: JulianDate) => this.#interlinkPulsePositions(time as JulianDate), false),
        width: 4,
        arcType: ArcType.NONE,
        material: new PolylineGlowMaterialProperty({ glowPower: 0.6, color: yellow }),
        show: new CallbackProperty(() => this.#interlinkActive(), false),
      }),
    });
    for (const entity of [fromBox, toBox, base, pulse]) {
      this.#links.entities.add(entity);
      this.#overlayEntities.add(entity);
    }
    this.#interlinkBoxFrom = fromBox;
    this.#interlinkBoxTo = toBox;
    this.#interlinkBase = base;
    this.#interlinkPulse = pulse;
    this.#interlinkFromName = from;
    this.#interlinkToName = to;
    this.#requestRender();
  }

  #removeInterlink(): void {
    for (const entity of [this.#interlinkBoxFrom, this.#interlinkBoxTo, this.#interlinkBase, this.#interlinkPulse]) {
      if (entity !== undefined) {
        this.#links.entities.remove(entity);
        this.#overlayEntities.delete(entity);
      }
    }
    this.#interlinkBoxFrom = undefined;
    this.#interlinkBoxTo = undefined;
    this.#interlinkBase = undefined;
    this.#interlinkPulse = undefined;
    this.#interlinkFromName = "";
    this.#interlinkToName = "";
    this.#requestRender();
  }

  #interlinkActive(): boolean {
    const store = this.#store;
    return store.interlinkFrom !== "" && store.interlinkTo !== "" && store.interlinkUntil > Date.now();
  }

  #interlinkBlink(): boolean {
    return this.#interlinkActive() && Math.floor(Date.now() / BLINK_HALF_MS) % 2 === 0;
  }

  #interlinkPositions(time: JulianDate): Cartesian3[] | undefined {
    const from = this.#cc.sats.getSatellite(this.#interlinkFromName)?.props.trajectory.position(time);
    const to = this.#cc.sats.getSatellite(this.#interlinkToName)?.props.trajectory.position(time);
    return from && to ? [from, to] : undefined;
  }

  /** A short bright segment travelling from `from` to `to`, looping each period. */
  #interlinkPulsePositions(time: JulianDate): Cartesian3[] | undefined {
    const from = this.#cc.sats.getSatellite(this.#interlinkFromName)?.props.trajectory.position(time);
    const to = this.#cc.sats.getSatellite(this.#interlinkToName)?.props.trajectory.position(time);
    if (!from || !to) {
      return undefined;
    }
    const phase = (Date.now() % INTERLINK_PULSE_MS) / INTERLINK_PULSE_MS;
    const tail = Math.max(0, phase - INTERLINK_PULSE_FRACTION);
    return [Cartesian3.lerp(from, to, tail, this.#pulseStart), Cartesian3.lerp(from, to, phase, this.#pulseEnd)];
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

    if (this.#store.highlightColor !== "") {
      if (Date.now() > this.#store.highlightUntil) {
        this.#store.clearHighlight();
      } else {
        // Keeps the blink animating and the expiry noticed even with a paused clock.
        this.#requestRender();
        if (this.#highlightEntity === undefined && now - this.#highlightRetryAt > 500) {
          this.#highlightRetryAt = now;
          this.#syncHighlight();
        }
      }
    }

    if (this.#store.interlinkFrom !== "" && this.#store.interlinkTo !== "") {
      if (Date.now() > this.#store.interlinkUntil) {
        this.#store.clearInterlink();
      } else {
        // The pulse is wall-clock driven, so a paused clock still flows.
        this.#requestRender();
        if (this.#interlinkBase === undefined && now - this.#interlinkRetryAt > 500) {
          this.#interlinkRetryAt = now;
          this.#syncInterlink();
        }
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
    // Deleting the current entry while iterating a Set is safe; no copy is needed.
    for (const name of this.#modelNames) {
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
