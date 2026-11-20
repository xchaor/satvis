// The contract between the TT&C console window and the satellite view that owns the scene.
// The console renders from this reactive state and calls these actions; who fulfils them
// (the same window or the opener over a BroadcastChannel) is the implementation's business.

import { inject, type InjectionKey } from "vue";

import type { InterSatelliteLink, TtcLinkStats, TtcMessage } from "@/stores/controlCenter";

export type TtcConsoleTab = "fleet" | "attitude" | "links" | "log";

export type TtcCommandKind = "telemetry" | "attitude" | "panels-deploy" | "panels-stow";

export interface TtcFleetRow {
  name: string;
  satnum: string;
  /** Orbit class, for the coloured dot. */
  orbitClass: string;
  active: boolean;
  hasModel: boolean;
}

export interface TtcFleetState {
  rows: TtcFleetRow[];
  total: number;
  activeCount: number;
  query: string;
  searching: boolean;
}

export interface TtcStation {
  lat: number;
  lon: number;
  name?: string;
}

export interface TtcConsoleState {
  /** The console's own read of the link to the satellite view; false until its first snapshot. */
  connected: boolean;
  lockedName: string;
  lockedSatnum: string;
  hasModel: boolean;
  modelUrl: string;
  modelLabel: string;
  modelDemo: boolean;
  follow: boolean;
  modelsOn: boolean;
  /** Degrees, the same values the scene applies. */
  roll: number;
  pitch: number;
  yaw: number;
  spinRate: number;
  panelAngle: number;
  panelTarget: number;
  autoTelemetry: boolean;
  stationIndex: number;
  groundStats: TtcLinkStats;
  interSatelliteLinks: InterSatelliteLink[];
  islStats: Record<number, TtcLinkStats>;
  messages: TtcMessage[];
  stations: TtcStation[];
  /** Active satellites other than the locked one, for the inter-satellite link picker. */
  activeNames: string[];
}

/** The satellite view's state, without what the console keeps itself (`connected`, messages). */
export type TtcStateSnapshot = Omit<TtcConsoleState, "connected" | "messages">;

/** "demo" is resolved in the satellite view, so the blob URL belongs to the page that draws it. */
export type TtcModelSelection = { kind: "default" } | { kind: "demo" } | { kind: "file"; url: string; label: string };

export interface TtcConsoleApi {
  readonly state: TtcConsoleState;
  readonly fleet: TtcFleetState;
  search(query: string): void;
  lock(name: string): void;
  unlock(): void;
  setAttitude(patch: Partial<{ roll: number; pitch: number; yaw: number }>): void;
  resetAttitude(): void;
  setSpin(rate: number): void;
  setPanelTarget(degrees: number): void;
  setModel(selection: TtcModelSelection): void;
  sendCommand(kind: TtcCommandKind): void;
  addLink(a: string, b: string): void;
  removeLink(id: number): void;
  sendPacket(id: number): void;
  setStation(index: number): void;
  addStation(station: TtcStation): void;
  setAutoTelemetry(on: boolean): void;
  clearMessages(): void;
  setFollow(on: boolean): void;
  setGlobal3D(on: boolean): void;
  /** Asks the satellite view for a snapshot again; the button for a closed/reopened view. */
  reconnect(): void;
}

export const ttcConsoleKey: InjectionKey<TtcConsoleApi> = Symbol("satvis-ttc-console");

export function useTtcConsole(): TtcConsoleApi {
  const api = inject(ttcConsoleKey);
  if (!api) {
    throw new Error("The TT&C console API is not provided");
  }
  return api;
}
