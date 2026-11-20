// The TT&C center's HTTP interface, served by the Vite dev server. An external system
// posts a command here; the satellite view polls it and executes it against the locked
// satellite. Dev only: a built site has no server to expose these endpoints.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

import {
  HIGHLIGHT_DEFAULT_SECONDS,
  HIGHLIGHT_MAX_SECONDS,
  HIGHLIGHT_MIN_SECONDS,
  TTC_HIGHLIGHT_COLOR_KEYS,
  TTC_HIGHLIGHT_EFFECTS,
  TTC_INTERLINK_DEFAULT_SECONDS,
} from "../src/modules/ttc/highlight.ts";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUE = 200;
const COMMAND_ACTIONS = new Set([
  "attitude",
  "reset-attitude",
  "spin",
  "panels",
  "lock",
  "unlock",
  "command",
  "uplink",
  "downlink",
  "model",
  "highlight",
  "highlight-clear",
  "interlink",
  "interlink-clear",
]);

/** Actions that take an optional `name`: it implicitly locks that satellite first. */
const TARGETABLE_ACTIONS = new Set(["attitude", "reset-attitude", "spin", "panels", "command", "uplink", "downlink", "model", "highlight"]);
const SATELLITE_COMMANDS = new Set(["telemetry", "attitude", "panels-deploy", "panels-stow"]);
const MODEL_FILE = /^[A-Za-z0-9 ._()+-]+(\/[A-Za-z0-9 ._()+-]+)?\.glb$/;

interface QueuedCommand {
  id: number;
  receivedAt: string;
  command: Record<string, unknown>;
}

type Normalized = { ok: true; command: Record<string, unknown> } | { ok: false; error: string };

function numberFrom(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** A whitelisted command, so an HTTP caller cannot push arbitrary shapes into the page. */
function normalize(raw: Record<string, unknown>): Normalized {
  const action = typeof raw.action === "string" ? raw.action : "";
  if (!COMMAND_ACTIONS.has(action)) {
    return { ok: false, error: `action must be one of ${[...COMMAND_ACTIONS].join(", ")}` };
  }
  const command: Record<string, unknown> = { action };

  switch (action) {
    case "attitude": {
      const roll = numberFrom(raw.roll);
      const pitch = numberFrom(raw.pitch);
      const yaw = numberFrom(raw.yaw);
      if (roll === undefined || pitch === undefined || yaw === undefined) {
        return { ok: false, error: "attitude needs numeric roll, pitch and yaw" };
      }
      if (Math.abs(roll) > 180 || Math.abs(pitch) > 90 || Math.abs(yaw) > 180) {
        return { ok: false, error: "attitude out of range: roll/yaw ±180, pitch ±90" };
      }
      return { ok: true, command: { ...command, roll, pitch, yaw } };
    }
    case "spin": {
      const rate = numberFrom(raw.rate);
      if (rate === undefined || Math.abs(rate) > 120) {
        return { ok: false, error: "spin needs a numeric rate within ±120 °/s" };
      }
      return { ok: true, command: { ...command, rate } };
    }
    case "panels": {
      const angle = numberFrom(raw.angle);
      if (angle === undefined || angle < 0 || angle > 90) {
        return { ok: false, error: "panels needs a numeric angle within 0–90" };
      }
      return { ok: true, command: { ...command, angle } };
    }
    case "lock": {
      const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 200) : "";
      if (name === "") {
        return { ok: false, error: "lock needs the satellite name in `name`" };
      }
      return { ok: true, command: { ...command, name } };
    }
    case "command": {
      const kind = typeof raw.kind === "string" ? raw.kind : "";
      if (!SATELLITE_COMMANDS.has(kind)) {
        return { ok: false, error: `kind must be one of ${[...SATELLITE_COMMANDS].join(", ")}` };
      }
      return { ok: true, command: { ...command, kind } };
    }
    case "uplink":
    case "downlink": {
      const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 1000) : "";
      if (text === "") {
        return { ok: false, error: `${action} needs non-empty \`text\`` };
      }
      return { ok: true, command: { ...command, text } };
    }
    case "model": {
      const file = typeof raw.file === "string" ? raw.file.trim() : "";
      if (file !== "demo" && (!MODEL_FILE.test(file) || file.includes("..") || file.startsWith("/"))) {
        return { ok: false, error: "model needs `file`: a .glb path under data/models, or \"demo\"" };
      }
      return { ok: true, command: { ...command, file } };
    }
    case "highlight": {
      const color = typeof raw.color === "string" ? raw.color : "";
      if (!(TTC_HIGHLIGHT_COLOR_KEYS as readonly string[]).includes(color)) {
        return { ok: false, error: `highlight needs color: ${TTC_HIGHLIGHT_COLOR_KEYS.join(", ")}` };
      }
      const effect = typeof raw.effect === "string" ? raw.effect : "steady";
      if (!(TTC_HIGHLIGHT_EFFECTS as readonly string[]).includes(effect)) {
        return { ok: false, error: "effect must be steady or blink" };
      }
      const duration = numberFrom(raw.duration) ?? HIGHLIGHT_DEFAULT_SECONDS;
      if (duration < HIGHLIGHT_MIN_SECONDS || duration > HIGHLIGHT_MAX_SECONDS) {
        return { ok: false, error: `duration must be ${HIGHLIGHT_MIN_SECONDS}–${HIGHLIGHT_MAX_SECONDS} seconds` };
      }
      return { ok: true, command: { ...command, color, effect, duration } };
    }
    case "interlink": {
      const fromName = typeof raw.fromName === "string" ? raw.fromName.trim().slice(0, 200) : "";
      const toName = typeof raw.toName === "string" ? raw.toName.trim().slice(0, 200) : "";
      if (fromName === "" || toName === "") {
        return { ok: false, error: "interlink needs fromName and toName" };
      }
      if (fromName === toName) {
        return { ok: false, error: "fromName and toName must be different satellites" };
      }
      const duration = numberFrom(raw.duration) ?? TTC_INTERLINK_DEFAULT_SECONDS;
      if (duration < HIGHLIGHT_MIN_SECONDS || duration > HIGHLIGHT_MAX_SECONDS) {
        return { ok: false, error: `duration must be ${HIGHLIGHT_MIN_SECONDS}–${HIGHLIGHT_MAX_SECONDS} seconds` };
      }
      return { ok: true, command: { ...command, fromName, toName, duration } };
    }
    default:
      // reset-attitude, unlock and highlight-clear carry nothing.
      return { ok: true, command };
  }
}

/** Adds the optional target satellite to an action that can name one. */
function attachTarget(command: Record<string, unknown>, raw: Record<string, unknown>): Normalized {
  const action = typeof command.action === "string" ? command.action : "";
  if (!TARGETABLE_ACTIONS.has(action) || raw.name === undefined) {
    return { ok: true, command };
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    return { ok: false, error: "name must be a non-empty string" };
  }
  return { ok: true, command: { ...command, name: raw.name.trim().slice(0, 200) } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  cors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function parseJson(text: string): Record<string, unknown> {
  if (text.trim() === "") {
    return {};
  }
  const value = JSON.parse(text) as unknown;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Dev-only: `apply: "serve"` keeps it out of the build, where no server serves /ttc-api. */
export function ttcHttpApi(): Plugin {
  const queue: QueuedCommand[] = [];
  let latestState: unknown = null;
  let nextId = 1;

  return {
    name: "satvis-ttc-http",
    apply: "serve",
    configureServer(server) {
      const logger = server.config.logger;

      const enqueue = (command: Record<string, unknown>): number => {
        const id = nextId++;
        queue.push({ id, receivedAt: new Date().toISOString(), command });
        if (queue.length > MAX_QUEUE) {
          queue.shift();
        }
        return id;
      };

      server.middlewares.use("/ttc-api", async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        // Connect strips the mount, but tolerate a server that leaves it on.
        const pathname = url.pathname.startsWith("/ttc-api") ? url.pathname.slice("/ttc-api".length) : url.pathname;
        const path = pathname.replace(/\/+$/, "") || "/";
        try {
          if (req.method === "OPTIONS") {
            cors(res);
            res.statusCode = 204;
            res.end();
            return;
          }

          if (path === "/" && req.method === "GET") {
            sendJson(res, 200, {
              ok: true,
              endpoints: {
                "GET /ttc-api/state": "the satellite view's last state snapshot",
                "GET /ttc-api/command?action=...": "enqueue a command from query parameters",
                "POST /ttc-api/command": "enqueue a command from a JSON body",
              },
              actions: [...COMMAND_ACTIONS],
              targetable: [...TARGETABLE_ACTIONS],
              note: "A targetable action accepts an optional name; it locks that satellite first, without moving the camera, so it also works before any lock.",
              examples: [
                "GET /ttc-api/command?action=attitude&roll=20&pitch=-10&yaw=45",
                "GET /ttc-api/command?action=attitude&name=ISS+(ZARYA)&roll=20&pitch=-10&yaw=45",
                'POST /ttc-api/command {"action":"panels","name":"ISS (ZARYA)","angle":0}',
                'POST /ttc-api/command {"action":"uplink","name":"ISS (ZARYA)","text":"HELLO SAT"}',
                'POST /ttc-api/command {"action":"lock","name":"ISS (ZARYA)"}',
                "GET /ttc-api/command?action=highlight&color=red&effect=blink&duration=30",
                'POST /ttc-api/command {"action":"highlight","color":"green","effect":"steady","duration":60}',
                'POST /ttc-api/command {"action":"highlight-clear"}',
                "GET /ttc-api/command?action=interlink&fromName=ISS+(ZARYA)&toName=CSS+(TIANHE)&duration=60",
                'POST /ttc-api/command {"action":"interlink","fromName":"ISS (ZARYA)","toName":"CSS (TIANHE)","duration":60}',
                'POST /ttc-api/command {"action":"interlink-clear"}',
              ],
            });
            return;
          }

          if (path === "/state" && req.method === "GET") {
            sendJson(res, latestState === null ? 503 : 200, latestState ?? { ok: false, error: "the satellite view has not polled yet" });
            return;
          }

          if (path === "/command" && (req.method === "GET" || req.method === "POST")) {
            const raw = req.method === "POST" ? parseJson(await readBody(req)) : Object.fromEntries(url.searchParams);
            const normalized = normalize(raw);
            if (!normalized.ok) {
              sendJson(res, 400, { ok: false, error: normalized.error });
              return;
            }
            const targeted = attachTarget(normalized.command, raw);
            if (!targeted.ok) {
              sendJson(res, 400, { ok: false, error: targeted.error });
              return;
            }
            const id = enqueue(targeted.command);
            logger.info(`[ttc-api] #${id} ${JSON.stringify(targeted.command)}`);
            sendJson(res, 202, { ok: true, id, command: targeted.command });
            return;
          }

          // The satellite view's poll: it leaves its state and takes the queued commands.
          if (path === "/poll" && req.method === "POST") {
            const body = parseJson(await readBody(req));
            if ("state" in body) {
              latestState = body.state;
            }
            sendJson(res, 200, { ok: true, commands: queue.splice(0, queue.length) });
            return;
          }

          sendJson(res, 404, { ok: false, error: `unknown endpoint ${path}` });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}
