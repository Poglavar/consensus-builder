import { Buffer } from 'node:buffer';

type Rect = { x0: number; x1: number; z0: number; z1: number };

const SHAPES: Record<string, Rect[]> = {
  l: [
    { x0: -8, x1: 8, z0: -10, z1: 0 },
    { x0: -8, x1: 0, z0: 0, z1: 10 }
  ],
  courtyard: [
    { x0: -8, x1: -2, z0: -10, z1: 10 },
    { x0: 2, x1: 8, z0: -10, z1: 10 },
    { x0: -2, x1: 2, z0: -10, z1: -7 },
    { x0: -2, x1: 2, z0: 7, z1: 10 }
  ],
  disconnected: [
    { x0: -8, x1: -2, z0: -10, z1: 10 },
    { x0: 2, x1: 8, z0: -10, z1: 10 }
  ]
};

function quad(out: number[], a: number[], b: number[], c: number[], d: number[]) {
  // Consistent two-triangle surface; footprint extraction is orientation independent.
  out.push(...a, ...c, ...b, ...a, ...d, ...c);
}

function prism(out: number[], r: Rect) {
  const lo = 0, hi = 16;
  const p = (x: number, y: number, z: number) => [x, y, z];
  const a = p(r.x0, lo, r.z0), b = p(r.x1, lo, r.z0), c = p(r.x1, lo, r.z1), d = p(r.x0, lo, r.z1);
  const A = p(r.x0, hi, r.z0), B = p(r.x1, hi, r.z0), C = p(r.x1, hi, r.z1), D = p(r.x0, hi, r.z1);
  quad(out, A, B, C, D); // flat roof
  quad(out, d, c, b, a); // flat floor
  quad(out, a, b, B, A); quad(out, b, c, C, B);
  quad(out, c, d, D, C); quad(out, d, a, A, D);
}

/** Self-contained GLB containing a triangulated Y-up building footprint. */
export function createBuildingGlb(shape: keyof typeof SHAPES = 'l'): Buffer {
  const positions: number[] = [];
  for (const rect of SHAPES[shape]) prism(positions, rect);
  const binary = Buffer.alloc(positions.length * 4);
  positions.forEach((value, i) => binary.writeFloatLE(value, i * 4));
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'e2e-model-fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3',
      min: [-8, 0, -10], max: [8, 16, 10] }]
  }));
  const jsonPadding = (4 - json.length % 4) % 4;
  const binPadding = (4 - binary.length % 4) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const binChunk = Buffer.concat([binary, Buffer.alloc(binPadding)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binChunk.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}
