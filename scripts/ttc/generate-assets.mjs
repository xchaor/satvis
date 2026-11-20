// Writes the model picker's index of data/models/models.yaml. The manifest itself is
// not served, and the dev server answers a missing file with index.html, so the app
// falls back to its baked-in file list until this runs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const outDir = resolve(root, "data/ttc");
mkdirSync(outDir, { recursive: true });

const manifest = parse(readFileSync(resolve(root, "data/models/models.yaml"), "utf8"));

const entries = (manifest.models ?? []).map((model) => ({
  file: model.file,
  label: model.satellites?.[0]?.name ?? model.buses?.[0] ?? model.file.replace(/\.glb$/, ""),
  role: model.role,
  satellites: model.satellites ?? [],
  buses: model.buses ?? [],
  lods: (model.lods ?? []).map((lod) => lod.file),
  dimensions: model.measured?.dimensions,
  triangles: model.measured?.triangles,
  bytes: model.measured?.bytes,
}));

writeFileSync(resolve(outDir, "models.json"), `${JSON.stringify({ source: "data/models/models.yaml", entries }, null, 1)}\n`);

console.log(`wrote ${entries.length} model entries to data/ttc/models.json`);
