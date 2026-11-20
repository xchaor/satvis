// The highlight box's palette and vocabulary, shared by the console UI, the satellite
// view and the dev-server HTTP validation. No Cesium imports: the Vite config bundles
// this module on the server.

export const TTC_HIGHLIGHT_COLORS = {
  red: "#ff4d4f",
  orange: "#ff9f43",
  yellow: "#ffd93d",
  green: "#4ade80",
  cyan: "#22d3ee",
  blue: "#409eff",
  purple: "#a855f7",
  white: "#ffffff",
} as const;

export type TtcHighlightColor = keyof typeof TTC_HIGHLIGHT_COLORS;

export const TTC_HIGHLIGHT_COLOR_KEYS = Object.keys(TTC_HIGHLIGHT_COLORS) as TtcHighlightColor[];

export type TtcHighlightEffect = "steady" | "blink";

export const TTC_HIGHLIGHT_EFFECTS: TtcHighlightEffect[] = ["steady", "blink"];

export const HIGHLIGHT_DEFAULT_SECONDS = 30;
export const HIGHLIGHT_MIN_SECONDS = 1;
export const HIGHLIGHT_MAX_SECONDS = 3600;

/** The inter-satellite demo's default duration; it shares the highlight's bounds. */
export const TTC_INTERLINK_DEFAULT_SECONDS = 30;
