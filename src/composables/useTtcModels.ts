import { ref } from "vue";

export interface TtcModelEntry {
  file: string;
  label: string;
  role?: string;
  satellites: { name: string; noradId: number }[];
  buses: string[];
  lods: string[];
  dimensions?: number[];
  triangles?: number;
  bytes?: number;
}

/**
 * The manifest's main files, for when data/ttc/models.json has not been generated
 * (scripts/ttc/generate-assets.mjs). Lower-detail copies are its `lods`, not entries.
 */
const FALLBACK_MODEL_FILES = [
  "ISS-(ZARYA).glb",
  "MMS-1.glb",
  "FGRST-(GLAST).glb",
  "AURA.glb",
  "LANDSAT-8.glb",
  "SENTINEL-6A.glb",
  "GPM-CORE.glb",
  "SWIFT.glb",
  "ICESAT-2.glb",
  "SDO.glb",
  "JASON-3.glb",
  "TDRS-3.glb",
  "TDRS-8.glb",
  "OCO-2.glb",
  "CLOUDSAT.glb",
  "GRACE-FO-1.glb",
  "GRACE-FO-2.glb",
  "GOES-16.glb",
  "SUOMI-NPP.glb",
  "CXO.glb",
  "HINODE-(SOLAR-B).glb",
  "TESS.glb",
  "CYGFM01.glb",
  "THEMIS-A.glb",
  "TERRA.glb",
  "STARLINK-V1.glb",
  "STARLINK-V2-MINI.glb",
  "STARLINK-V2-MINI-DTC.glb",
  "STARLINK-V3.glb",
  "CSS-(TIANHE).glb",
  "IRIDIUM-NEXT.glb",
  "KEPLER-TRANCHE-1.glb",
  "KEPLER-TRANCHE-1-SAFIRE.glb",
  "O3B.glb",
  "O3B-MPOWER.glb",
  "KUIPER.glb",
  "ONEWEB.glb",
  "QIANFAN.glb",
  "GUOWANG.glb",
  "GPS-IIF.glb",
  "GPS-IIR.glb",
  "GPS-III.glb",
  "GLONASS-M.glb",
  "GALILEO-FOC.glb",
  "BEIDOU-3-CAST.glb",
  "BEIDOU-3-SECM.glb",
  "GLOBALSTAR-2.glb",
  "INSAT-3D.glb",
  "SKYSAT.glb",
  "PELICAN.glb",
  "ICEYE.glb",
  "SUPERDOVE.glb",
  "generic/SSL-1300.glb",
  "generic/EUROSTAR-NEO.glb",
  "generic/EUROSTAR-3000.glb",
  "generic/BSS-702SP.glb",
  "generic/BSS-702HP.glb",
  "generic/DFH-3.glb",
  "generic/DFH-3-NAVIGATION.glb",
  "generic/DFH-4.glb",
  "generic/SPACEBUS-NEO.glb",
  "generic/SPACEBUS-4000.glb",
  "generic/A2100.glb",
  "generic/I-1K.glb",
  "generic/I-2K.glb",
  "generic/I-3K.glb",
  "generic/EKSPRESS-1000.glb",
  "generic/CUBESAT-1U.glb",
  "generic/CUBESAT-1.5U.glb",
  "generic/CUBESAT-2U.glb",
  "generic/CUBESAT-3U.glb",
  "generic/CUBESAT-4U.glb",
  "generic/CUBESAT-6U.glb",
  "generic/CUBESAT-8U.glb",
  "generic/CUBESAT-12U.glb",
  "generic/CUBESAT-16U.glb",
];

function prettyLabel(file: string): string {
  const name = file.replace(/^generic\//, "").replace(/\.glb$/, "").replace(/[-_]/g, " ");
  return file.startsWith("generic/") ? `${name}（通用）` : name;
}

const FALLBACK_MODELS: TtcModelEntry[] = FALLBACK_MODEL_FILES.map((file) => ({
  file,
  label: prettyLabel(file),
  satellites: [],
  buses: [],
  lods: [],
}));

const entries = ref<TtcModelEntry[]>([]);
const loaded = ref(false);
let loading: Promise<void> | undefined;

/**
 * The model picker's index. Generated from data/models/models.yaml by
 * scripts/ttc/generate-assets.mjs; the manifest itself is not served. Without it the
 * picker lists the files this build ships, so model switching still works.
 */
export function useTtcModels(): { entries: typeof entries; loaded: typeof loaded } {
  loading ??= (async () => {
    try {
      const response = await fetch("./data/ttc/models.json");
      if (response.ok) {
        const body = (await response.json()) as { entries?: TtcModelEntry[] };
        entries.value = body.entries ?? [];
      }
    } catch {
      // The dev server answers a missing file with index.html, so a parse failure is
      // the normal "not generated" path, not an error worth surfacing.
    } finally {
      if (entries.value.length === 0) {
        entries.value = FALLBACK_MODELS;
      }
      loaded.value = true;
    }
  })();
  return { entries, loaded };
}

/** Where the app serves a manifest file. */
export function ttcModelUrl(file: string): string {
  return `./data/models/${file}`;
}
