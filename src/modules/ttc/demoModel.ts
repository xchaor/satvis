// A small satellite whose solar panels are separate glTF nodes, built in the browser:
// the models satvis ships bake their node transforms away at build time, so none of
// them can hinge. A blob URL keeps it out of data/ and out of the service worker cache.

interface BoxMesh {
  positions: number[];
  normals: number[];
  indices: number[];
}

/** Six faces, four vertices each, wound counter-clockwise from outside. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): BoxMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const face = (normal: number[], points: number[][]): void => {
    const base = positions.length / 3;
    for (const point of points) {
      positions.push(...point);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  face([1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]);
  face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  face([0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]);
  face([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
  face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  face([0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]);
  return { positions, normals, indices };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** The frame satvis authors models in: +Z velocity, +Y zenith, +X port. */
function buildGltf(): Record<string, unknown> {
  const parts = [
    { name: "body", material: 0, mesh: box(-0.3, 0.3, -0.4, 0.4, -0.5, 0.5) },
    { name: "solar_panel_port", material: 1, mesh: box(0, 1.7, -0.01, 0.01, -0.35, 0.35) },
    { name: "solar_panel_starboard", material: 1, mesh: box(-1.7, 0, -0.01, 0.01, -0.35, 0.35) },
  ];

  const chunks: Uint8Array[] = [];
  const accessors: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array, target: number): number => {
    const padding = (4 - (offset % 4)) % 4;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
      offset += padding;
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    offset += bytes.length;
    return bufferViews.length - 1;
  };

  const primitives = parts.map((part) => {
    const positions = new Float32Array(part.mesh.positions);
    const positionBytes = new Uint8Array(positions.buffer);
    const positionView = push(positionBytes, 34962);
    const axisValues = (axis: number): number[] => part.mesh.positions.filter((_, index) => index % 3 === axis);
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: positions.length / 3,
      type: "VEC3",
      min: [0, 1, 2].map((axis) => Math.min(...axisValues(axis))),
      max: [0, 1, 2].map((axis) => Math.max(...axisValues(axis))),
    });
    const positionAccessor = accessors.length - 1;

    const normals = new Float32Array(part.mesh.normals);
    const normalView = push(new Uint8Array(normals.buffer), 34962);
    accessors.push({ bufferView: normalView, componentType: 5126, count: normals.length / 3, type: "VEC3" });
    const normalAccessor = accessors.length - 1;

    const indices = new Uint16Array(part.mesh.indices);
    const indexView = push(new Uint8Array(indices.buffer), 34963);
    accessors.push({ bufferView: indexView, componentType: 5123, count: indices.length, type: "SCALAR" });
    const indexAccessor = accessors.length - 1;

    return { attributes: { POSITION: positionAccessor, NORMAL: normalAccessor }, indices: indexAccessor, material: part.material, mode: 4 };
  });

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, cursor);
    cursor += chunk.length;
  }

  return {
    asset: { version: "2.0", generator: "satvis TT&C demo" },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [
      { name: "body", mesh: 0 },
      { name: "solar_panel_port", mesh: 1, translation: [0.3, 0, 0] },
      { name: "solar_panel_starboard", mesh: 2, translation: [-0.3, 0, 0] },
    ],
    meshes: parts.map((part, index) => ({ name: part.name, primitives: [primitives[index]!] })),
    materials: [
      { name: "body", pbrMetallicRoughness: { baseColorFactor: [0.72, 0.72, 0.76, 1], metallicFactor: 0.7, roughnessFactor: 0.45 }, doubleSided: true },
      { name: "solar_panel", pbrMetallicRoughness: { baseColorFactor: [0.04, 0.09, 0.33, 1], metallicFactor: 0.4, roughnessFactor: 0.25 }, doubleSided: true },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${base64(buffer)}` }],
  };
}

let url: string | undefined;

/** One blob per session: the store and the picker compare URLs to tell the selection apart. */
export function ttcDemoModelUrl(): string {
  url ??= URL.createObjectURL(new Blob([JSON.stringify(buildGltf())], { type: "model/gltf+json" }));
  return url;
}

export const TTC_DEMO_LABEL = "TT&C 演示卫星（可展开太阳翼）";
