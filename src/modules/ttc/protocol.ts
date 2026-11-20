// The BroadcastChannel protocol between the satellite view (host) and the TT&C console
// window (client). Plain data only: structured clone rejects Vue's reactive proxies.

import type { TtcMessage } from "@/stores/controlCenter";

import type { TtcCommandKind, TtcFleetState, TtcModelSelection, TtcStation, TtcStateSnapshot } from "./console";

export const TTC_CHANNEL_NAME = "satvis-ttc-console";

export type TtcConsoleMessage =
  | { type: "hello" }
  | { type: "search"; query: string }
  | { type: "lock"; name: string }
  | { type: "unlock" }
  | { type: "setAttitude"; patch: Partial<{ roll: number; pitch: number; yaw: number }> }
  | { type: "resetAttitude" }
  | { type: "setSpin"; rate: number }
  | { type: "setPanelTarget"; degrees: number }
  | { type: "setModel"; selection: TtcModelSelection }
  | { type: "sendCommand"; kind: TtcCommandKind }
  | { type: "addLink"; a: string; b: string }
  | { type: "removeLink"; id: number }
  | { type: "sendPacket"; id: number }
  | { type: "setStation"; index: number }
  | { type: "addStation"; station: TtcStation }
  | { type: "setAutoTelemetry"; on: boolean }
  | { type: "clearMessages" }
  | { type: "setFollow"; on: boolean }
  | { type: "setGlobal3D"; on: boolean };

export type TtcHostMessage =
  | { type: "state"; state: TtcStateSnapshot; messages?: TtcMessage[] }
  | { type: "fleet"; fleet: TtcFleetState };
