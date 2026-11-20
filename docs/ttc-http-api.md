# TT&C HTTP interface

An HTTP interface for driving the satellite view from an external system: attitude,
solar-panel actions, satellite commands, and uplink/downlink data. It is served by the
Vite dev server (`pnpm dev`), so the page and the API share one origin and port.

```
http://localhost:5174/ttc-api
```

The satellite view page (the one drawing the globe) polls the queue every 400 ms. Keep it
open; commands sent while it is closed wait in the queue (up to 200) and run when it
polls again. The interface is **dev only**: a built site has no server to expose it, and
it has no authentication. Vite binds to localhost by default; use `pnpm dev:host` only on
a trusted network.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/ttc-api` | Discovery: actions and examples |
| GET | `/ttc-api/state` | The satellite view's last state snapshot (503 until the page has polled) |
| GET | `/ttc-api/command?action=...` | Enqueue a command from query parameters |
| POST | `/ttc-api/command` | Enqueue a command from a JSON body |

`/command` answers `202 { "ok": true, "id": 7, "command": {...} }`; an invalid command is
`400 { "ok": false, "error": "..." }`. CORS is open (`Access-Control-Allow-Origin: *`).

## Actions

| `action` | Parameters | Effect on the satellite view |
|---|---|---|
| `attitude` | `roll` (−180…180), `pitch` (−90…90), `yaw` (−180…180) | Sets the locked satellite's body-frame rotation, in degrees |
| `reset-attitude` | — | Roll, pitch, yaw and spin back to zero |
| `spin` | `rate` (−120…120 °/s) | Continuous spin about the velocity axis; `0` stops it |
| `panels` | `angle` (0…90) | Solar-panel target angle; 0 deployed, 90 stowed. Animates only on the demo model |
| `lock` | `name` | Locks a catalog satellite by name, enables its 3D model, and follows it with the camera |
| `unlock` | — | Releases the lock |
| `command` | `kind`: `telemetry`, `attitude`, `panels-deploy`, `panels-stow` | The simulated ground command with the usual link and elevation checks |
| `uplink` | `text` (≤ 1000 chars) | Logs an external uplink once the satellite is above the horizon, then a `DATA-ACK` downlink after the light time |
| `downlink` | `text` (≤ 1000 chars) | Logs an external downlink frame from the satellite to the ground station |
| `model` | `file`: a `.glb` under `data/models`, or `"demo"` | Switches the locked satellite's model |

Attitude, spin, panels and model need a locked satellite; without one the request is
acknowledged but the satellite view logs a warning and does nothing. `uplink` also needs
a ground station in the Locations panel and the satellite above the horizon.

## State

`GET /ttc-api/state` returns what the page last sent:

```json
{
  "lockedName": "ISS (ZARYA)",
  "lockedSatnum": "25544",
  "hasModel": true,
  "roll": 20, "pitch": -10, "yaw": 45, "spinRate": 0,
  "panelAngle": 0, "panelTarget": 0,
  "groundStats": { "elevationDeg": 34.2, "distanceKm": 812, "latencyMs": 3.1, "visible": true },
  "interSatelliteLinks": [{ "id": 0, "a": "ISS (ZARYA)", "b": "CSS (TIANHE)" }],
  "islStats": { "0": { "distanceKm": 1200, "latencyMs": 4.0, "visible": true } },
  "stations": [{ "lat": 39.9042, "lon": 116.4074, "name": "北京" }],
  "messages": [{ "id": 12, "at": "08:42:11", "direction": "downlink", "from": "ISS (ZARYA)", "to": "北京", "text": "TLM …" }]
}
```

`messages` holds the last 20. Times are simulation UTC.

## Examples

```bash
# Lock a satellite first; the other actions need one
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" \
  -d '{"action":"lock","name":"ISS (ZARYA)"}'

# Attitude: roll 20°, pitch -10°, yaw 45°
curl "http://localhost:5174/ttc-api/command?action=attitude&roll=20&pitch=-10&yaw=45"

# POST the same attitude as JSON
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" \
  -d '{"action":"attitude","roll":20,"pitch":-10,"yaw":45}'

# Spin at 10 °/s
curl "http://localhost:5174/ttc-api/command?action=spin&rate=10"

# Stow the solar panels
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" -d '{"action":"panels","angle":90}'

# External uplink data (above the horizon): the page logs it and answers with DATA-ACK
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" -d '{"action":"uplink","text":"HELLO SAT"}'

# Inject a downlink frame
curl -X POST http://localhost:5174/ttc-api/command \
  -H "Content-Type: application/json" -d '{"action":"downlink","text":"TLM 电池 87.2%"}'

# Then read the satellite's last state, messages included
curl http://localhost:5174/ttc-api/state
```
