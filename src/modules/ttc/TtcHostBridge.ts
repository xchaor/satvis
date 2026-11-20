import { JulianDate } from "@cesium/core";
import { watchEffect, type WatchStopHandle } from "vue";

import type { CesiumController } from "@/modules/CesiumController";
import { activeTargetEntries } from "@/modules/satelliteActivation";
import type { CatalogEntry } from "@/modules/SatelliteCatalog";
import { useControlCenterStore } from "@/stores/controlCenter";
import { useSatStore } from "@/stores/sat";

import type { TtcFleetState, TtcModelSelection, TtcStateSnapshot } from "./console";
import { TTC_DEMO_LABEL, ttcDemoModelUrl } from "./demoModel";
import { TTC_CHANNEL_NAME, type TtcConsoleMessage, type TtcHostMessage } from "./protocol";
import { getTtcManager } from "./TtcManager";

const PUBLISH_DELAY_MS = 100;
const FLEET_DELAY_MS = 400;
const HEARTBEAT_MS = 1000;
const FLEET_ROWS = 60;
const HTTP_POLL_MS = 400;
const HTTP_RETRY_MS = 5000;
const HTTP_MESSAGES = 20;
/** Actions whose HTTP form takes an optional `name` and locks it before acting. */
const HTTP_TARGETABLE_ACTIONS = new Set(["attitude", "reset-attitude", "spin", "panels", "command", "uplink", "downlink", "model", "highlight"]);
const HTTP_READY_INTERVAL_MS = 300;
const HTTP_READY_ATTEMPTS = 20;

/**
 * The satellite view's side of the TT&C console: it owns the scene, publishes its state
 * and fleet over a BroadcastChannel, and executes what the console window asks. Started
 * from app.ts, like startSceneSync, so closing the console leaves it idle.
 */
export class TtcHostBridge {
  readonly #cc: CesiumController;

  readonly #store: ReturnType<typeof useControlCenterStore>;

  readonly #satStore: ReturnType<typeof useSatStore>;

  readonly #channel = new BroadcastChannel(TTC_CHANNEL_NAME);

  readonly #stops: WatchStopHandle[] = [];

  #publishTimer: ReturnType<typeof setTimeout> | undefined;

  #fleetTimer: ReturnType<typeof setTimeout> | undefined;

  #heartbeat: ReturnType<typeof setInterval> | undefined;

  #httpTimer: ReturnType<typeof setInterval> | undefined;

  #httpNextAt = 0;

  #httpPolling = false;

  #lastMessageId = -1;

  #query = "";

  #searching = false;

  #searchSeq = 0;

  #disposed = false;

  constructor(cc: CesiumController) {
    this.#cc = cc;
    this.#store = useControlCenterStore();
    this.#satStore = useSatStore();
    this.#channel.onmessage = (event: MessageEvent<TtcConsoleMessage>) => this.#onMessage(event.data);

    this.#stops.push(
      watchEffect(() => {
        const store = this.#store;
        void store.lockedName;
        void store.hasModel;
        void store.follow;
        void store.roll;
        void store.pitch;
        void store.yaw;
        void store.spinRate;
        void store.panelAngle;
        void store.panelTarget;
        void store.autoTelemetry;
        void store.stationIndex;
        void store.groundStats;
        void store.interSatelliteLinks;
        void store.islStats;
        void store.messages.length;
        void store.modelOverrides;
        void store.highlightColor;
        void store.highlightEffect;
        void store.highlightUntil;
        void store.interlinkFrom;
        void store.interlinkTo;
        void store.interlinkUntil;
        void this.#satStore.enabledComponents.length;
        void this.#satStore.groundStations.length;
        this.#schedulePublish();
      }),
      watchEffect(() => {
        void this.#satStore.catalogRevision;
        void this.#satStore.enabledTags.length;
        void this.#satStore.enabledSatellites.length;
        void this.#satStore.disabledSatellites.length;
        void this.#satStore.trackedSatellite;
        this.#scheduleFleet();
      }),
    );

    // Also the liveness signal: a console that hears nothing for 4 s says offline.
    this.#heartbeat = setInterval(() => this.#publishState(), HEARTBEAT_MS);
    // The dev server's HTTP interface: leave the state, take whatever an operator posted.
    this.#httpTimer = setInterval(() => void this.#pollHttp(), HTTP_POLL_MS);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#publishTimer !== undefined) {
      clearTimeout(this.#publishTimer);
    }
    if (this.#fleetTimer !== undefined) {
      clearTimeout(this.#fleetTimer);
    }
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
    }
    if (this.#httpTimer !== undefined) {
      clearInterval(this.#httpTimer);
    }
    this.#stops.forEach((stop) => stop());
    this.#channel.close();
  }

  #onMessage(message: TtcConsoleMessage): void {
    const store = this.#store;
    switch (message.type) {
      case "hello":
        this.#publishState(true);
        this.#publishFleet();
        break;
      case "search":
        void this.#search(message.query);
        break;
      case "lock":
        getTtcManager().lock(message.name);
        break;
      case "unlock":
        getTtcManager().unlock();
        break;
      case "setAttitude":
        store.setAttitude(message.patch);
        break;
      case "resetAttitude":
        store.resetAttitude();
        break;
      case "setSpin":
        store.setSpin(message.rate);
        break;
      case "setPanelTarget":
        store.setPanelTarget(message.degrees);
        break;
      case "setModel":
        this.#applyModel(message.selection);
        break;
      case "sendCommand":
        getTtcManager().sendCommand(message.kind);
        break;
      case "addLink":
        this.#addLink(message.a, message.b);
        break;
      case "removeLink":
        store.removeInterSatelliteLink(message.id);
        break;
      case "sendPacket":
        getTtcManager().sendInterSatellitePacket(message.id);
        break;
      case "setStation":
        store.setStationIndex(message.index);
        break;
      case "addStation":
        this.#satStore.addGroundStation(message.station);
        store.setStationIndex(this.#satStore.groundStations.length - 1);
        break;
      case "setAutoTelemetry":
        store.setAutoTelemetry(message.on);
        break;
      case "clearMessages":
        store.clearMessages();
        break;
      case "setFollow":
        store.follow = message.on;
        break;
      case "setGlobal3D":
        this.#setGlobal3D(message.on);
        break;
      case "setHighlight":
        store.setHighlight(message.color, message.effect, message.duration);
        break;
      case "clearHighlight":
        store.clearHighlight();
        break;
    }
  }

  #applyModel(selection: TtcModelSelection): void {
    const name = this.#store.lockedName;
    if (name === "") {
      return;
    }
    const manager = getTtcManager();
    if (selection.kind === "default") {
      manager.setModel(name, undefined);
    } else if (selection.kind === "demo") {
      // Resolved here: the blob URL belongs to the page that draws the model.
      manager.setModel(name, { url: ttcDemoModelUrl(), label: TTC_DEMO_LABEL, panels: true });
    } else {
      manager.setModel(name, { url: selection.url, label: selection.label });
    }
  }

  #addLink(a: string, b: string): void {
    if (this.#store.addInterSatelliteLink(a, b) !== undefined) {
      return;
    }
    this.#store.log({
      at: JulianDate.toDate(this.#cc.viewer.clock.currentTime).toISOString().slice(11, 19),
      channel: "isl",
      direction: "warn",
      from: a,
      to: b,
      text: "星间链路未建立：已达 6 条上限、两星相同，或链路已存在",
    });
  }

  #setGlobal3D(on: boolean): void {
    const current = this.#satStore.enabledComponents;
    this.#satStore.enabledComponents = on ? [...new Set([...current, "3D model"])] : current.filter((name) => name !== "3D model");
  }

  /**
   * The dev server's HTTP queue: the satellite state goes up, commands come down. A built
   * site has no `/ttc-api`, so a 404 stops the poll instead of retrying forever.
   */
  async #pollHttp(): Promise<void> {
    if (this.#disposed || this.#httpPolling || Date.now() < this.#httpNextAt) {
      return;
    }
    this.#httpPolling = true;
    try {
      const response = await fetch("/ttc-api/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: { ...this.#snapshot(), messages: this.#store.messages.slice(-HTTP_MESSAGES).map((entry) => ({ ...entry })) },
        }),
      });
      if (response.status === 404) {
        this.#httpNextAt = Number.POSITIVE_INFINITY;
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = (await response.json()) as { commands?: { command?: Record<string, unknown> }[] };
      this.#httpNextAt = 0;
      for (const item of body.commands ?? []) {
        if (item.command) {
          this.#applyHttpCommand(item.command);
        }
      }
    } catch {
      // The endpoint only exists under `pnpm dev`; back off instead of spamming the console.
      this.#httpNextAt = Date.now() + HTTP_RETRY_MS;
    } finally {
      this.#httpPolling = false;
    }
  }

  #applyHttpCommand(command: Record<string, unknown>): void {
    const store = this.#store;
    const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const action = typeof command.action === "string" ? command.action : "";
    // A named action locks its satellite first, so it also works before any lock.
    if (HTTP_TARGETABLE_ACTIONS.has(action)) {
      this.#ensureTarget(command);
    }
    const needsLock = (): boolean => {
      if (store.lockedName !== "") {
        return true;
      }
      this.#httpWarn(`HTTP ${action} 指令被忽略：未锁定卫星`);
      return false;
    };
    const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

    switch (action) {
      case "attitude": {
        if (!needsLock()) {
          return;
        }
        const roll = number(command.roll);
        const pitch = number(command.pitch);
        const yaw = number(command.yaw);
        if (roll !== undefined && pitch !== undefined && yaw !== undefined) {
          store.setAttitude({ roll, pitch, yaw });
        }
        break;
      }
      case "reset-attitude":
        if (needsLock()) {
          store.resetAttitude();
        }
        break;
      case "spin": {
        if (!needsLock()) {
          return;
        }
        const rate = number(command.rate);
        if (rate !== undefined) {
          store.setSpin(rate);
        }
        break;
      }
      case "panels": {
        if (!needsLock()) {
          return;
        }
        const angle = number(command.angle);
        if (angle !== undefined) {
          store.setPanelTarget(angle);
        }
        break;
      }
      case "lock": {
        const name = text(command.name);
        if (name) {
          getTtcManager().lock(name);
        }
        break;
      }
      case "unlock":
        getTtcManager().unlock();
        break;
      case "command": {
        const kind = command.kind;
        if ((kind === "telemetry" || kind === "attitude" || kind === "panels-deploy" || kind === "panels-stow") && needsLock()) {
          const target = store.lockedName;
          this.#runWhenReady(target, () => getTtcManager().sendCommand(kind));
        }
        break;
      }
      case "uplink": {
        const payload = text(command.text);
        if (payload && needsLock()) {
          const target = store.lockedName;
          this.#runWhenReady(target, () => getTtcManager().sendUplink(payload));
        }
        break;
      }
      case "downlink": {
        const payload = text(command.text);
        if (payload && needsLock()) {
          getTtcManager().sendDownlink(payload);
        }
        break;
      }
      case "model": {
        const file = text(command.file);
        if (file && needsLock()) {
          const manager = getTtcManager();
          if (file === "demo") {
            manager.setModel(store.lockedName, { url: ttcDemoModelUrl(), label: TTC_DEMO_LABEL, panels: true });
          } else if (file.endsWith(".glb")) {
            manager.setModel(store.lockedName, { url: `./data/models/${file}`, label: file });
          }
        }
        break;
      }
      case "highlight": {
        const color = text(command.color);
        if (color && needsLock()) {
          const effect = command.effect === "blink" ? "blink" : "steady";
          const duration = number(command.duration) ?? 30;
          store.setHighlight(color, effect, duration);
        }
        break;
      }
      case "highlight-clear":
        store.clearHighlight();
        break;
      case "interlink": {
        const from = text(command.fromName);
        const to = text(command.toName);
        if (from && to) {
          const duration = number(command.duration) ?? 30;
          getTtcManager().setInterlink(from, to, duration);
        }
        break;
      }
      case "interlink-clear":
        getTtcManager().clearInterlink();
        break;
    }
  }

  /** Locks the HTTP action's named satellite without touching the camera or tracking. */
  #ensureTarget(command: Record<string, unknown>): void {
    const requested = typeof command.name === "string" ? command.name.trim() : "";
    if (requested !== "" && requested !== this.#store.lockedName) {
      getTtcManager().lock(requested, false);
    }
  }

  /**
   * Ground commands need the trajectory; a satellite named just now is still being
   * activated and built, so run the command once it appears instead of losing it.
   */
  #runWhenReady(name: string, run: () => void): void {
    if (this.#cc.sats.getSatellite(name)) {
      run();
      return;
    }
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (this.#disposed || this.#store.lockedName !== name) {
        clearInterval(timer);
        return;
      }
      if (this.#cc.sats.getSatellite(name)) {
        clearInterval(timer);
        run();
        return;
      }
      if (attempts >= HTTP_READY_ATTEMPTS) {
        clearInterval(timer);
        this.#httpWarn(`HTTP 指令超时：${name} 的卫星数据尚未就绪`);
      }
    }, HTTP_READY_INTERVAL_MS);
  }

  #httpWarn(text: string): void {
    this.#store.log({
      at: JulianDate.toDate(this.#cc.viewer.clock.currentTime).toISOString().slice(11, 19),
      channel: "ground",
      direction: "warn",
      from: "HTTP",
      to: this.#store.lockedName || "—",
      text,
    });
  }

  async #search(query: string): Promise<void> {
    this.#query = query;
    const sequence = ++this.#searchSeq;
    this.#searching = query.trim() !== "";
    this.#publishFleet();
    if (!this.#searching) {
      return;
    }
    try {
      // The whole catalog, as the Satellites panel's search does.
      await this.#cc.sats.catalog.ensureAll();
    } catch {
      // A group that failed after its retries simply contributes no rows.
    }
    if (this.#disposed || sequence !== this.#searchSeq) {
      return;
    }
    this.#searching = false;
    this.#publishFleet();
  }

  #schedulePublish(): void {
    if (this.#publishTimer !== undefined) {
      return;
    }
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = undefined;
      this.#publishState();
    }, PUBLISH_DELAY_MS);
  }

  #scheduleFleet(): void {
    if (this.#fleetTimer !== undefined) {
      return;
    }
    this.#fleetTimer = setTimeout(() => {
      this.#fleetTimer = undefined;
      this.#publishFleet();
    }, FLEET_DELAY_MS);
  }

  #publishState(includeMessages = false): void {
    if (this.#disposed) {
      return;
    }
    const messages = this.#store.messages;
    const lastId = messages.length > 0 ? messages[messages.length - 1]!.id : -1;
    const sendMessages = includeMessages || lastId !== this.#lastMessageId;
    this.#lastMessageId = lastId;
    const message: TtcHostMessage = {
      type: "state",
      state: this.#snapshot(),
      ...(sendMessages && { messages: messages.map((entry) => ({ ...entry })) }),
    };
    this.#channel.postMessage(message);
  }

  #publishFleet(): void {
    if (this.#disposed) {
      return;
    }
    this.#channel.postMessage({ type: "fleet", fleet: this.#fleetState() } satisfies TtcHostMessage);
  }

  #snapshot(): TtcStateSnapshot {
    const store = this.#store;
    const name = store.lockedName;
    const override = store.modelOverrides[name];
    return {
      lockedName: name,
      lockedSatnum: name === "" ? "" : (this.#cc.sats.catalog.getByName(name)?.satnum ?? ""),
      hasModel: store.hasModel,
      modelUrl: override?.url ?? "",
      modelLabel: override?.label ?? "",
      modelDemo: override?.panels === true,
      follow: store.follow,
      modelsOn: this.#satStore.enabledComponents.includes("3D model"),
      roll: store.roll,
      pitch: store.pitch,
      yaw: store.yaw,
      spinRate: store.spinRate,
      panelAngle: store.panelAngle,
      panelTarget: store.panelTarget,
      autoTelemetry: store.autoTelemetry,
      stationIndex: store.stationIndex,
      groundStats: { ...store.groundStats },
      interSatelliteLinks: store.interSatelliteLinks.map((link) => ({ id: link.id, a: link.a, b: link.b })),
      islStats: Object.fromEntries(Object.entries(store.islStats).map(([id, stats]) => [id, { ...stats }])) as TtcStateSnapshot["islStats"],
      highlightColor: store.highlightColor,
      highlightEffect: store.highlightEffect,
      highlightUntil: store.highlightUntil,
      interlinkFrom: store.interlinkFrom,
      interlinkTo: store.interlinkTo,
      interlinkUntil: store.interlinkUntil,
      stations: this.#satStore.groundStations.map((station) => ({ lat: station.lat, lon: station.lon, ...(station.name !== undefined && { name: station.name }) })),
      // A picker list, not a census: 200 is more than an operator picks from, and keeps
      // the once-a-second snapshot small when a whole constellation is active.
      activeNames: this.#cc.sats.activeSatellites
        .map((satellite) => satellite.props.name)
        .filter((candidate) => candidate !== name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 200),
    };
  }

  #fleetState(): TtcFleetState {
    void this.#satStore.catalogRevision;
    const catalog = this.#cc.sats.catalog;
    const active = [...activeTargetEntries({
      entries: catalog.entries,
      enabledTags: this.#satStore.enabledTags,
      enabledSatellites: this.#satStore.enabledSatellites,
      disabledSatellites: this.#satStore.disabledSatellites,
      trackedName: this.#satStore.trackedSatellite || undefined,
    }).values()];
    const activeNames = new Set(active.map((entry) => entry.name));
    const row = (entry: CatalogEntry) => ({
      name: entry.name,
      satnum: entry.satnum,
      orbitClass: entry.orbitClass,
      active: activeNames.has(entry.name),
      hasModel: Boolean(entry.metadata.model || entry.metadata.modelFile),
    });

    const query = this.#query.trim().toLowerCase();
    if (query !== "") {
      const matches = catalog.entries.filter((entry) => entry.name.toLowerCase().includes(query) || entry.satnum.includes(query));
      return {
        rows: matches.slice(0, FLEET_ROWS).map(row).sort((a, b) => a.name.localeCompare(b.name)),
        total: matches.length,
        activeCount: active.length,
        query: this.#query,
        searching: this.#searching,
      };
    }
    const list = active.length > 0 ? active : catalog.entries;
    return {
      rows: list.slice(0, FLEET_ROWS).map(row).sort((a, b) => a.name.localeCompare(b.name)),
      total: list.length,
      activeCount: active.length,
      query: this.#query,
      searching: false,
    };
  }
}

let host: TtcHostBridge | undefined;

/** One per satellite view page, started from app.ts after Pinia and the TT&C manager. */
export function startTtcHost(cc: CesiumController): TtcHostBridge {
  host?.dispose();
  host = new TtcHostBridge(cc);
  return host;
}
