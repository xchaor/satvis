import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { panelAngleOf } from "@/modules/ttc/state";

export type TtcTab = "fleet" | "attitude" | "links" | "log";
export type TtcChannel = "ground" | "isl";
export type TtcDirection = "uplink" | "downlink" | "warn" | "sys";

export interface TtcMessage {
  id: number;
  /** Simulation time, HH:MM:SS. */
  at: string;
  channel: TtcChannel;
  direction: TtcDirection;
  from: string;
  to: string;
  text: string;
}

export interface InterSatelliteLink {
  id: number;
  a: string;
  b: string;
}

export interface TtcLinkStats {
  distanceKm?: number;
  latencyMs?: number;
  elevationDeg?: number;
  visible: boolean;
  updatedAt?: string;
}

export interface ModelChoice {
  url: string;
  label: string;
  /** The demo model's panels are nodes; every other model is baked into one primitive. */
  panels?: boolean;
}

/** Bounded: a telemetry heartbeat would otherwise grow it for as long as the page is open. */
const MESSAGE_LIMIT = 300;
const LINK_LIMIT = 6;

/**
 * TT&C panel state. Deliberately not in the url: sliders, the log and panel tabs would
 * push a history entry each time they move (docs/adr/0001-url-parameter-specification.md).
 */
export const useControlCenterStore = defineStore("controlCenter", () => {
  const tab = ref<TtcTab>("fleet");
  const lockedName = ref("");
  const follow = ref(true);
  const roll = ref(0);
  const pitch = ref(0);
  const yaw = ref(0);
  /** Degrees per second around the velocity axis; 0 stops the spin. */
  const spinRate = ref(0);
  /** Degrees from deployed (0) to stowed (90), mirrored from the scene's animation. */
  const panelAngle = ref(0);
  const panelTarget = ref(0);
  const stationIndex = ref(0);
  const autoTelemetry = ref(false);
  const hasModel = ref(false);
  const messages = ref<TtcMessage[]>([]);
  const interSatelliteLinks = ref<InterSatelliteLink[]>([]);
  const groundStats = ref<TtcLinkStats>({ visible: false });
  const islStats = ref<Record<number, TtcLinkStats>>({});
  const modelOverrides = ref<Record<string, ModelChoice>>({});

  let nextMessageId = 0;
  let nextLinkId = 0;

  const isLocked = computed(() => lockedName.value !== "");
  const lockedModel = computed(() => modelOverrides.value[lockedName.value]);

  function lock(name: string): void {
    if (name === "" || name === lockedName.value) {
      return;
    }
    lockedName.value = name;
    roll.value = 0;
    pitch.value = 0;
    yaw.value = 0;
    spinRate.value = 0;
    // A solar panel keeps the configuration it was left in.
    const angle = panelAngleOf(name);
    panelAngle.value = angle;
    panelTarget.value = angle;
    groundStats.value = { visible: false };
    hasModel.value = false;
  }

  function unlock(): void {
    lockedName.value = "";
    spinRate.value = 0;
    groundStats.value = { visible: false };
    hasModel.value = false;
  }

  function setAttitude(next: Partial<{ roll: number; pitch: number; yaw: number }>): void {
    if (next.roll !== undefined) {
      roll.value = Math.max(-180, Math.min(180, next.roll));
    }
    if (next.pitch !== undefined) {
      pitch.value = Math.max(-90, Math.min(90, next.pitch));
    }
    if (next.yaw !== undefined) {
      yaw.value = Math.max(-180, Math.min(180, next.yaw));
    }
  }

  function resetAttitude(): void {
    roll.value = 0;
    pitch.value = 0;
    yaw.value = 0;
    spinRate.value = 0;
  }

  function setSpin(rate: number): void {
    spinRate.value = rate;
  }

  function setPanelTarget(degrees: number): void {
    panelTarget.value = Math.max(0, Math.min(90, degrees));
  }

  function setPanelAngle(degrees: number): void {
    panelAngle.value = degrees;
  }

  function setModelOverride(name: string, choice: ModelChoice): void {
    modelOverrides.value = { ...modelOverrides.value, [name]: choice };
  }

  function clearModelOverride(name: string): void {
    const next = { ...modelOverrides.value };
    delete next[name];
    modelOverrides.value = next;
  }

  function setStationIndex(index: number): void {
    stationIndex.value = Math.max(0, index);
  }

  function setAutoTelemetry(on: boolean): void {
    autoTelemetry.value = on;
  }

  function setHasModel(has: boolean): void {
    hasModel.value = has;
  }

  function log(entry: Omit<TtcMessage, "id">): void {
    const next = [...messages.value, { ...entry, id: nextMessageId++ }];
    messages.value = next.length > MESSAGE_LIMIT ? next.slice(next.length - MESSAGE_LIMIT) : next;
  }

  function clearMessages(): void {
    messages.value = [];
  }

  /** Undefined when the pair is invalid, duplicates one, or is over the limit. */
  function addInterSatelliteLink(a: string, b: string): number | undefined {
    if (a === "" || b === "" || a === b) {
      return undefined;
    }
    const duplicates = interSatelliteLinks.value.some((link) => (link.a === a && link.b === b) || (link.a === b && link.b === a));
    if (duplicates || interSatelliteLinks.value.length >= LINK_LIMIT) {
      return undefined;
    }
    const id = nextLinkId++;
    interSatelliteLinks.value = [...interSatelliteLinks.value, { id, a, b }];
    return id;
  }

  function removeInterSatelliteLink(id: number): void {
    interSatelliteLinks.value = interSatelliteLinks.value.filter((link) => link.id !== id);
    const next = { ...islStats.value };
    delete next[id];
    islStats.value = next;
  }

  /** Whether a pair would be accepted, so the button can say why it does nothing. */
  function canAddInterSatelliteLink(a: string, b: string): boolean {
    if (a === "" || b === "" || a === b) {
      return false;
    }
    if (interSatelliteLinks.value.length >= LINK_LIMIT) {
      return false;
    }
    return !interSatelliteLinks.value.some((link) => (link.a === a && link.b === b) || (link.a === b && link.b === a));
  }

  function setGroundStats(stats: TtcLinkStats): void {
    groundStats.value = stats;
  }

  function setIslStats(id: number, stats: TtcLinkStats): void {
    islStats.value = { ...islStats.value, [id]: stats };
  }

  return {
    tab,
    lockedName,
    follow,
    roll,
    pitch,
    yaw,
    spinRate,
    panelAngle,
    panelTarget,
    stationIndex,
    autoTelemetry,
    hasModel,
    messages,
    interSatelliteLinks,
    groundStats,
    islStats,
    modelOverrides,
    isLocked,
    lockedModel,
    lock,
    unlock,
    setAttitude,
    resetAttitude,
    setSpin,
    setPanelTarget,
    setPanelAngle,
    setModelOverride,
    clearModelOverride,
    setStationIndex,
    setAutoTelemetry,
    setHasModel,
    log,
    clearMessages,
    addInterSatelliteLink,
    removeInterSatelliteLink,
    canAddInterSatelliteLink,
    setGroundStats,
    setIslStats,
  };
});
