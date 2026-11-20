import { reactive } from "vue";

import type { TtcConsoleApi, TtcConsoleState, TtcFleetState } from "./console";
import { TTC_CHANNEL_NAME, type TtcConsoleMessage, type TtcHostMessage } from "./protocol";

const DISCONNECT_AFTER_MS = 4000;
const HELLO_RETRY_MS = 2000;

/**
 * The console window's side: mirrors the satellite view's snapshots and sends it what the
 * operator does. It holds no scene state of its own, so a closed or reloaded opener only
 * makes it offline until the next hello lands.
 */
export function createTtcConsoleApi(): TtcConsoleApi {
  const state = reactive<TtcConsoleState>({
    connected: false,
    lockedName: "",
    lockedSatnum: "",
    hasModel: false,
    modelUrl: "",
    modelLabel: "",
    modelDemo: false,
    follow: true,
    modelsOn: false,
    roll: 0,
    pitch: 0,
    yaw: 0,
    spinRate: 0,
    panelAngle: 0,
    panelTarget: 0,
    autoTelemetry: false,
    stationIndex: 0,
    groundStats: { visible: false },
    interSatelliteLinks: [],
    islStats: {},
    messages: [],
    stations: [],
    activeNames: [],
    highlightColor: "",
    highlightEffect: "steady",
    highlightUntil: 0,
    interlinkFrom: "",
    interlinkTo: "",
    interlinkUntil: 0,
  });
  const fleet = reactive<TtcFleetState>({ rows: [], total: 0, activeCount: 0, query: "", searching: false });

  const channel = new BroadcastChannel(TTC_CHANNEL_NAME);
  let lastHeard = 0;

  channel.onmessage = (event: MessageEvent<TtcHostMessage>) => {
    const message = event.data;
    if (message.type === "state") {
      lastHeard = Date.now();
      state.connected = true;
      Object.assign(state, message.state);
      if (message.messages) {
        state.messages = message.messages;
      }
    } else if (message.type === "fleet") {
      lastHeard = Date.now();
      state.connected = true;
      Object.assign(fleet, message.fleet);
    }
  };

  const send = (message: TtcConsoleMessage): void => channel.postMessage(message);
  const hello = (): void => send({ type: "hello" });

  hello();
  // Not tied to pagehide: entering the back/forward cache must not silence a restored
  // console, so the channel closes only when the page is actually gone.
  setInterval(() => {
    state.connected = Date.now() - lastHeard < DISCONNECT_AFTER_MS;
    // The satellite view may have opened after this window, or reloaded; ask again.
    if (!state.connected) {
      hello();
    }
  }, HELLO_RETRY_MS);

  return {
    state,
    fleet,
    search: (query) => send({ type: "search", query }),
    lock: (name) => send({ type: "lock", name }),
    unlock: () => send({ type: "unlock" }),
    setAttitude: (patch) => send({ type: "setAttitude", patch }),
    resetAttitude: () => send({ type: "resetAttitude" }),
    setSpin: (rate) => send({ type: "setSpin", rate }),
    setPanelTarget: (degrees) => send({ type: "setPanelTarget", degrees }),
    setModel: (selection) => send({ type: "setModel", selection }),
    sendCommand: (kind) => send({ type: "sendCommand", kind }),
    addLink: (a, b) => send({ type: "addLink", a, b }),
    removeLink: (id) => send({ type: "removeLink", id }),
    sendPacket: (id) => send({ type: "sendPacket", id }),
    setStation: (index) => send({ type: "setStation", index }),
    addStation: (station) => send({ type: "addStation", station }),
    setAutoTelemetry: (on) => send({ type: "setAutoTelemetry", on }),
    clearMessages: () => send({ type: "clearMessages" }),
    setFollow: (on) => send({ type: "setFollow", on }),
    setGlobal3D: (on) => send({ type: "setGlobal3D", on }),
    setHighlight: (color, effect, duration) => send({ type: "setHighlight", color, effect, duration }),
    clearHighlight: () => send({ type: "clearHighlight" }),
    reconnect: hello,
  };
}
