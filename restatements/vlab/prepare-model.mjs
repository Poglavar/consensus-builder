#!/usr/bin/env node
// vLAB restatement (README.md): prepares the author's building model (cache/building.glb, with its
// interiors) to stand as the vLAB building's own 3D model, and uploads it to an API. The model is
// rewritten without vertex normals (flat shading; it must fit the upload limit), at the landmark fit's
// scale, with the ground (model 28.2 m) at y = 0, so the app places it georeferenced: its origin at
// `modelOrigin`, turned by `rotation`. The result stays local in the gitignored cache/: the model is
// the author's work, and republishing it needs his permission.
//
//   node restatements/vlab/prepare-model.mjs --build                       # cache/building.glb → cache/vlab-building.glb
//   node restatements/vlab/prepare-model.mjs --upload --api <api> [--origin <app>] --apply  # POST /models → cache/model-upload.json

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { bboxCentre, fitSimilarity, glbTriangles, planOf } from './model-geometry.mjs';

const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const proj4 = require('proj4');
proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');

// The model's ground: between the basement's tops (its storey −1 boxes reach model 28.1 m) and the
// ground-floor slab (28.5 m). At the site's own 28.0 m the basement would show through the paving.
const GROUND_M = 28.2;
const here = name => new URL(name, import.meta.url);
const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
const { values } = parseArgs({ options: { build: { type: 'boolean' }, upload: { type: 'boolean' }, api: { type: 'string' }, origin: { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help || !(values.build || values.upload)) {
    console.log('Usage: node restatements/vlab/prepare-model.mjs --build | --upload --api <api> --apply   (see the header comment)');
    process.exit(values.help ? 0 : 1);
}

// The same landmark fit as extract-model.mjs, from the site model the building model shares its frame with.
async function placement() {
    const site = glbTriangles(await readFile(here('./cache/site.glb')));
    const { landmarks } = JSON.parse(await readFile(here('./data/landmarks.json'), 'utf8'));
    const fit = fitSimilarity(landmarks.map(l => bboxCentre(site[l.node])), landmarks.map(l => proj4('EPSG:4326', 'EPSG:3765', [l.lon, l.lat])));
    const toWgs = xy => proj4('EPSG:3765', 'EPSG:4326', fit.apply(xy));
    const [lng, lat] = toWgs([0, 0]);
    // The model's +x axis on the ground, as an angle counter-clockwise from east (true, not grid).
    const [lng1, lat1] = toWgs([100, 0]);
    const east = (lng1 - lng) * Math.cos(lat * Math.PI / 180), north = lat1 - lat;
    const rotation = Math.atan2(north, east) * 180 / Math.PI;
    return { modelOrigin: [Math.round(lng * 1e9) / 1e9, Math.round(lat * 1e9) / 1e9], rotation: Math.round(rotation * 1e4) / 1e4, scale: fit.scale, fit };
}

// The building's footprint (data/model.geojson, the vLAB parts) in the model's own plan frame, grown by
// a metre: the ground-floor slab of the author's model also paves the whole site, and the park and the
// squares are their own designs, so only the slab under the building is kept.
async function footprintTest(fit) {
    const turf = require('@turf/turf');
    const parts = JSON.parse(await readFile(here('./data/model.geojson'), 'utf8')).features
        .filter(item => item.properties.kind === 'building' && item.properties.key === 'vlab');
    const footprint = turf.buffer(parts.slice(1).reduce((merged, item) => turf.union(merged, item), parts[0]), 1, { units: 'meters' });
    return ([x, y]) => turf.booleanPointInPolygon(turf.point(proj4('EPSG:3765', 'EPSG:4326', fit.apply([x, y]))), footprint);
}

// A new GLB with every mesh's positions (scaled in plan, shifted to the ground) and indices, no normals.
// `keepTriangle(nodeName, [a, b, c])` (model plan points) may drop triangles of a node.
function rewriteGlb(buffer, { scale }, keepTriangle = () => true) {
    const jsonLength = buffer.readUInt32LE(12);
    const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
    const binStart = 20 + jsonLength;
    const bin = buffer.subarray(binStart + 8, binStart + 8 + buffer.readUInt32LE(binStart));
    const chunks = [], accessors = [], bufferViews = [];
    let offset = 0;
    const push = (bytes, target) => {
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
        chunks.push(bytes); offset += bytes.length;
        return bufferViews.length - 1;
    };
    const view = index => { const a = gltf.accessors[index], v = gltf.bufferViews[a.bufferView]; return { a, v, start: (v.byteOffset || 0) + (a.byteOffset || 0) }; };
    // Primitives sharing an accessor keep sharing its rewritten copy.
    const rewritten = new Map();
    const nodeOfMesh = new Map(gltf.nodes.filter(node => node.mesh != null).map(node => [node.mesh, node.name]));
    for (const [meshIndex, mesh] of gltf.meshes.entries()) {
        const nodeName = nodeOfMesh.get(meshIndex) || '';
        for (const primitive of mesh.primitives) {
            const key = `${meshIndex}|${primitive.attributes.POSITION}|${primitive.indices}`;
            if (rewritten.has(key)) { Object.assign(primitive, rewritten.get(key)); continue; }
            // The exporter points every primitive at the whole shared vertex buffer: keep only the
            // vertices this primitive's triangles use, and renumber its indices to them.
            const { a, v, start } = view(primitive.attributes.POSITION);
            const stride = v.byteStride || 12;
            let source;
            if (primitive.indices != null) {
                const ix = view(primitive.indices);
                const size = { 5121: 1, 5123: 2, 5125: 4 }[ix.a.componentType];
                const read = { 1: 'readUInt8', 2: 'readUInt16LE', 4: 'readUInt32LE' }[size];
                source = Array.from({ length: ix.a.count }, (_, i) => bin[read](ix.start + i * size));
            } else source = Array.from({ length: a.count }, (_, i) => i);
            const planAt = vertex => { const at = start + vertex * stride; return [bin.readFloatLE(at), -bin.readFloatLE(at + 8)]; };
            const kept = [];
            for (let i = 0; i + 2 < source.length; i += 3) {
                if (keepTriangle(nodeName, [source[i], source[i + 1], source[i + 2]].map(planAt))) kept.push(source[i], source[i + 1], source[i + 2]);
            }
            source = kept;
            const used = new Map();
            const remapped = source.map(vertex => { if (!used.has(vertex)) used.set(vertex, used.size); return used.get(vertex); });
            const out = Buffer.alloc(used.size * 12);
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (const [vertex, slot] of used) {
                const at = start + vertex * stride;
                const p = [bin.readFloatLE(at) * scale, bin.readFloatLE(at + 4) - GROUND_M, bin.readFloatLE(at + 8) * scale];
                p.forEach((value, k) => { out.writeFloatLE(value, slot * 12 + k * 4); min[k] = Math.min(min[k], value); max[k] = Math.max(max[k], value); });
            }
            accessors.push({ bufferView: push(out, 34962), componentType: 5126, count: used.size, type: 'VEC3', min, max });
            const attributes = { POSITION: accessors.length - 1 };
            const wide = used.size > 65535;
            const indexBytes = Buffer.alloc(remapped.length * (wide ? 4 : 2));
            remapped.forEach((slot, i) => (wide ? indexBytes.writeUInt32LE(slot, i * 4) : indexBytes.writeUInt16LE(slot, i * 2)));
            accessors.push({ bufferView: push(indexBytes, 34963), componentType: wide ? 5125 : 5123, count: remapped.length, type: 'SCALAR' });
            const indices = accessors.length - 1;
            primitive.attributes = attributes;
            primitive.indices = indices;
            rewritten.set(key, { attributes, indices });
        }
    }
    const body = Buffer.concat(chunks);
    const out = { ...gltf, accessors, bufferViews, buffers: [{ byteLength: body.length }] };
    let json = Buffer.from(JSON.stringify(out), 'utf8');
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
    const binPadded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8);
    const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
    return Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, binPadded)]);
}

if (values.build) {
    const place = await placement();
    const underBuilding = await footprintTest(place.fit);
    const centroid = points => [(points[0][0] + points[1][0] + points[2][0]) / 3, (points[0][1] + points[1][1] + points[2][1]) / 3];
    const keep = (name, points) => name !== 'lvl_pp_flo' || underBuilding(centroid(points));
    const glb = rewriteGlb(await readFile(here('./cache/building.glb')), place, keep);
    // A check that the rewrite reads back: every node keeps every triangle, the ground-floor slab only
    // those under the building.
    const before = glbTriangles(await readFile(here('./cache/building.glb'))), after = glbTriangles(glb);
    for (const name of Object.keys(before)) {
        const expected = name === 'lvl_pp_flo' ? before[name].filter(triangle => underBuilding(centroid(triangle.map(planOf)))).length : before[name].length;
        if (expected !== (after[name] || []).length) throw new Error(`${name}: ${(after[name] || []).length} triangles after the rewrite, expected ${expected}`);
    }
    log(`lvl_pp_flo: ${after.lvl_pp_flo.length} of ${before.lvl_pp_flo.length} triangles kept under the building`);
    delete place.fit;
    await writeFile(here('./cache/vlab-building.glb'), glb);
    await writeFile(here('./cache/model-placement.json'), `${JSON.stringify({ ...place, groundM: GROUND_M, bytes: glb.length, sha256: createHash('sha256').update(glb).digest('hex') }, null, 1)}\n`);
    log(`cache/vlab-building.glb: ${glb.length} bytes, origin ${place.modelOrigin.join(', ')}, rotation ${place.rotation}°, scale ${place.scale.toFixed(4)}`);
}

if (values.upload) {
    if (!values.api) throw new Error('--upload needs --api');
    const placementFile = JSON.parse(await readFile(here('./cache/model-placement.json'), 'utf8'));
    const glb = await readFile(here('./cache/vlab-building.glb'));
    if (createHash('sha256').update(glb).digest('hex') !== placementFile.sha256) throw new Error('cache/vlab-building.glb is not the built model (run --build)');
    if (!values.apply) { log(`dry run: would POST ${glb.length} bytes to ${values.api}/models`); process.exit(0); }
    // The API takes writes only from an app origin: the app at --origin, or this API's own origin locally.
    const origin = values.origin || new URL(values.api).origin;
    const response = await fetch(new URL('/models', values.api), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ modelData: `data:model/gltf-binary;base64,${glb.toString('base64')}`, fileName: 'vlab-building.glb' }) });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || !answer.modelUrl) throw new Error(`POST /models: HTTP ${response.status} ${JSON.stringify(answer).slice(0, 200)}`);
    // Read the served file back: the upload is done when the API serves these exact bytes.
    const served = Buffer.from(await (await fetch(new URL(answer.modelUrl, values.api))).arrayBuffer());
    if (createHash('sha256').update(served).digest('hex') !== placementFile.sha256) throw new Error(`${answer.modelUrl} does not serve the uploaded model`);
    await writeFile(here('./cache/model-upload.json'), `${JSON.stringify({ api: values.api, modelUrl: answer.modelUrl, sha256: placementFile.sha256, uploadedAt: new Date().toISOString() }, null, 1)}\n`);
    log(`uploaded and read back: ${answer.modelUrl}`);
}
