// Generates a small, recognizable house-shaped building as a binary glTF (.glb) for
// manually testing the proposal "Upload" flow. No dependencies: writes the GLB container
// (header + JSON chunk + BIN chunk) by hand. Footprint 16 m (x) × 20 m (z), height 16 m
// (12 m walls + 4 m gable roof) — sized to sit in a Zagreb parcel near proposal 38.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const positions = [];
const normals = [];
const indices = [];

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

function pushVert(p, n) {
    positions.push(p[0], p[1], p[2]);
    normals.push(n[0], n[1], n[2]);
    return positions.length / 3 - 1;
}
function addTri(a, b, c) {
    const n = norm(cross(sub(b, a), sub(c, a)));
    const i0 = pushVert(a, n), i1 = pushVert(b, n), i2 = pushVert(c, n);
    indices.push(i0, i1, i2);
}
function addQuad(a, b, c, d) { addTri(a, b, c); addTri(a, c, d); }

// Walls: box from x[-8,8], y[0,12], z[-10,10]
const A = [-8, 0, -10], B = [8, 0, -10], E = [8, 0, 10], F = [-8, 0, 10];
const D = [-8, 12, -10], C = [8, 12, -10], G = [8, 12, 10], H = [-8, 12, 10];
addQuad(F, E, B, A); // bottom
addQuad(F, E, G, H); // front (+z)
addQuad(B, A, D, C); // back (-z)
addQuad(A, F, H, D); // left (-x)
addQuad(E, B, C, G); // right (+x)

// Gable roof: ridge at x=0, y=16, eaves at y=12
const R1 = [0, 16, -10], R2 = [0, 16, 10];
addQuad(D, H, R2, R1); // left slope
addQuad(C, R1, R2, G); // right slope
addTri(D, R1, C);      // gable end (-z)
addTri(H, G, R2);      // gable end (+z)

const vertexCount = positions.length / 3;
const indexCount = indices.length;

// Min/max for the POSITION accessor (required by spec).
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
    }
}

// Binary buffer: positions (f32) | normals (f32) | indices (u16, padded to 4 bytes)
const posBytes = vertexCount * 12;
const normBytes = vertexCount * 12;
const idxBytesRaw = indexCount * 2;
const idxBytes = Math.ceil(idxBytesRaw / 4) * 4;
const binLength = posBytes + normBytes + idxBytes;

const bin = new ArrayBuffer(binLength);
new Float32Array(bin, 0, positions.length).set(positions);
new Float32Array(bin, posBytes, normals.length).set(normals);
new Uint16Array(bin, posBytes + normBytes, indexCount).set(indices);

const gltf = {
    asset: { version: '2.0', generator: 'consensus-builder make-test-building' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'TestBuilding' }],
    meshes: [{ name: 'TestBuilding', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{
        name: 'Limestone',
        pbrMetallicRoughness: { baseColorFactor: [0.82, 0.80, 0.74, 1], metallicFactor: 0.0, roughnessFactor: 0.9 },
        doubleSided: true
    }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
        { buffer: 0, byteOffset: posBytes, byteLength: normBytes, target: 34962 },
        { buffer: 0, byteOffset: posBytes + normBytes, byteLength: idxBytesRaw, target: 34963 }
    ],
    accessors: [
        { bufferView: 0, componentType: 5126, count: vertexCount, type: 'VEC3', min, max },
        { bufferView: 1, componentType: 5126, count: vertexCount, type: 'VEC3' },
        { bufferView: 2, componentType: 5123, count: indexCount, type: 'SCALAR' }
    ]
};

// Assemble the GLB container.
function pad(buf, padByte) {
    const rem = buf.length % 4;
    if (rem === 0) return buf;
    return Buffer.concat([buf, Buffer.alloc(4 - rem, padByte)]);
}
const jsonChunk = pad(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
const binChunk = pad(Buffer.from(bin), 0x00);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // 'glTF'
header.writeUInt32LE(2, 4);          // version
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8); // total length

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonChunk.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

const glb = Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
const outPath = join(dirname(fileURLToPath(import.meta.url)), 'test-building.glb');
writeFileSync(outPath, glb);
console.log(`Wrote ${outPath} (${glb.length} bytes), ${vertexCount} verts, ${indexCount} indices`);
console.log(`Footprint ${max[0] - min[0]}m x ${max[2] - min[2]}m, height ${max[1] - min[1]}m`);
