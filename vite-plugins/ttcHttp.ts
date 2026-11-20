// The TT&C center's HTTP interface, served by the Vite dev server. An external system
// posts a command here; the satellite view polls it and executes it against the locked
// satellite. Dev only: a built site has no server to expose these endpoints.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUE = 200;
const COMMAND_ACTIONS = new Set(["attitude", "reset-attitude", "spin", "panels", "lock", "unlock", "command", "uplink", "downlink", "model"]);
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
    default:
      // reset-attitude and unlock carry nothing.
      return { ok: true, command };
  }
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
              examples: [
                "GET /ttc-api/command?action=attitude&roll=20&pitch=-10&yaw=45",
                'POST /ttc-api/command {"action":"panels","angle":0}',
                'POST /ttc-api/command {"action":"uplink","text":"HELLO SAT"}',
                'POST /ttc-api/command {"action":"lock","name":"ISS (ZARYA)"}',
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
            const id = enqueue(normalized.command);
            logger.info(`[ttc-api] #${id} ${JSON.stringify(normalized.command)}`);
            sendJson(res, 202, { ok: true, id, command: normalized.command });
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
