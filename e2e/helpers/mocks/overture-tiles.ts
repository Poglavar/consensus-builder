// Overture's buildings served to the browser without the network: a STAC catalogue naming a test
// release, and a PMTiles archive (v3, uncompressed) holding the z14 tiles of the buildings a spec
// gives it. Installed for every mockApi page (empty archive), so a city reading Overture's tiles
// (frontend/js/overture-tiles.js) never reaches the real CDN from a test.
import type { Page, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const RELEASE = 'e2e-test.0';
const ARCHIVE_URL = `https://tiles.overturemaps.org/${RELEASE}/buildings.pmtiles`;
const ZOOM = 14;
const EXTENT = 4096;

export type TestBuilding = {
  id: string;
  ring: Array<[number, number]>; // lng/lat, closed or open
  height?: number;
  floors?: number;
  osmId?: string; // 'w123': the outline came from OpenStreetMap
};

// The tile-id curve comes from the same vendored library the page uses, so ids cannot disagree.
const pmtiles = (() => {
  const context: Record<string, unknown> = {};
  vm.createContext(context);
  const file = path.join(__dirname, '..', '..', '..', 'frontend', 'vendor', 'pmtiles-4.4.1', 'pmtiles.js');
  vm.runInContext(`${readFileSync(file, 'utf8')};this.pmtiles = pmtiles;`, context);
  return context.pmtiles as { zxyToTileId: (z: number, x: number, y: number) => number };
})();

// --- protobuf writing, just enough for vector tiles and PMTiles directories ---
function varint(out: number[], value: number) {
  let v = value;
  while (v >= 0x80) { out.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
  out.push(v);
}
function field(out: number[], num: number, wire: number) { varint(out, num * 8 + wire); }
function bytesField(out: number[], num: number, bytes: number[] | Uint8Array) { field(out, num, 2); varint(out, bytes.length); out.push(...bytes); }
function stringField(out: number[], num: number, text: string) { bytesField(out, num, Array.from(Buffer.from(text, 'utf8'))); }
function packed(out: number[], num: number, values: number[]) { const body: number[] = []; values.forEach(v => varint(body, v)); bytesField(out, num, body); }
const zigzag = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);

function tileOf(lng: number, lat: number) {
  const n = 2 ** ZOOM;
  const r = lat * Math.PI / 180;
  return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
}

// One building layer of `buildings`, all placed in tile (x, y).
function encodeTile(x: number, y: number, buildings: TestBuilding[]): Uint8Array {
  const keys: string[] = [];
  const values: Array<string | number | boolean> = [];
  const index = <T>(list: T[], value: T) => { let i = list.indexOf(value); if (i < 0) { list.push(value); i = list.length - 1; } return i; };
  const features = buildings.map(b => {
    const props: Record<string, string | number | boolean> = { id: b.id, is_underground: false };
    props.sources = JSON.stringify([b.osmId
      ? { dataset: 'OpenStreetMap', property: '', record_id: `${b.osmId}@1` }
      : { dataset: 'Microsoft ML Buildings', property: '' }]);
    if (b.height) props.height = b.height;
    if (b.floors) props.num_floors = b.floors;
    const tags = Object.entries(props).flatMap(([k, v]) => [index(keys, k), index(values, v)]);
    let pts = b.ring.map(([lng, lat]) => { const t = tileOf(lng, lat); return [Math.round((t.x - x) * EXTENT), Math.round((t.y - y) * EXTENT)]; });
    if (pts[0][0] === pts.at(-1)![0] && pts[0][1] === pts.at(-1)![1]) pts = pts.slice(0, -1);
    // Exterior rings have positive area in tile coordinates (y down).
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]; area += ax * by - bx * ay; }
    if (area < 0) pts.reverse();
    const geometry: number[] = [1 | (1 << 3), zigzag(pts[0][0]), zigzag(pts[0][1]), 2 | ((pts.length - 1) << 3)];
    for (let i = 1; i < pts.length; i++) geometry.push(zigzag(pts[i][0] - pts[i - 1][0]), zigzag(pts[i][1] - pts[i - 1][1]));
    geometry.push(7 | (1 << 3));
    return { tags, geometry };
  });
  const layer: number[] = [];
  varint(layer, 15 * 8); varint(layer, 2);
  stringField(layer, 1, 'building');
  for (const f of features) {
    const body: number[] = [];
    packed(body, 2, f.tags);
    field(body, 3, 0); varint(body, 3);
    packed(body, 4, f.geometry);
    bytesField(layer, 2, body);
  }
  keys.forEach(k => stringField(layer, 3, k));
  values.forEach(v => {
    const body: number[] = [];
    if (typeof v === 'string') stringField(body, 1, v);
    else if (typeof v === 'boolean') { field(body, 7, 0); varint(body, v ? 1 : 0); }
    else { field(body, 3, 1); const b = Buffer.alloc(8); b.writeDoubleLE(v); body.push(...b); }
    bytesField(layer, 4, body);
  });
  field(layer, 5, 0); varint(layer, EXTENT);
  const tile: number[] = [];
  bytesField(tile, 3, layer);
  return Uint8Array.from(tile);
}

// PMTiles v3: 127-byte header, root directory, metadata, tile data; nothing compressed.
export function buildArchive(buildings: TestBuilding[]): Buffer {
  const byTile = new Map<string, TestBuilding[]>();
  for (const b of buildings) {
    const t = tileOf(b.ring[0][0], b.ring[0][1]);
    const key = `${Math.floor(t.x)}/${Math.floor(t.y)}`;
    byTile.set(key, [...(byTile.get(key) || []), b]);
  }
  const entries = [...byTile.entries()].map(([key, list]) => {
    const [x, y] = key.split('/').map(Number);
    return { id: pmtiles.zxyToTileId(ZOOM, x, y), data: encodeTile(x, y, list) };
  }).sort((a, b) => a.id - b.id);
  let offset = 0;
  const placed = entries.map(e => { const p = { ...e, offset }; offset += e.data.length; return p; });
  const dir: number[] = [];
  varint(dir, placed.length);
  let last = 0;
  placed.forEach(e => { varint(dir, e.id - last); last = e.id; });
  placed.forEach(() => varint(dir, 1));
  placed.forEach(e => varint(dir, e.data.length));
  placed.forEach((e, i) => varint(dir, i > 0 && e.offset === placed[i - 1].offset + placed[i - 1].data.length ? 0 : e.offset + 1));
  const metadata = Buffer.from('{}');
  const tileData = Buffer.concat(placed.map(e => Buffer.from(e.data)));
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  const u64 = (pos: number, value: number) => header.writeBigUInt64LE(BigInt(value), pos);
  const rootOffset = 127, metaOffset = rootOffset + dir.length, dataOffset = metaOffset + metadata.length;
  u64(8, rootOffset); u64(16, dir.length);
  u64(24, metaOffset); u64(32, metadata.length);
  u64(40, dataOffset); u64(48, 0);
  u64(56, dataOffset); u64(64, tileData.length);
  u64(72, placed.length); u64(80, placed.length); u64(88, placed.length);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(1, 97); // internal compression: none
  header.writeUInt8(1, 98); // tile compression: none
  header.writeUInt8(1, 99); // MVT
  header.writeUInt8(0, 100); header.writeUInt8(ZOOM, 101);
  header.writeInt32LE(-1800000000, 102); header.writeInt32LE(-850000000, 106);
  header.writeInt32LE(1800000000, 110); header.writeInt32LE(850000000, 114);
  header.writeUInt8(0, 118); header.writeInt32LE(0, 119); header.writeInt32LE(0, 123);
  return Buffer.concat([header, Buffer.from(dir), metadata, tileData]);
}

export type OvertureTileLog = { catalogue: number; ranges: string[] };

// Later calls replace earlier ones (Playwright tries the newest route first).
export async function mockOvertureTiles(page: Page, buildings: TestBuilding[] = []): Promise<OvertureTileLog> {
  const archive = buildArchive(buildings);
  // A new archive is a new ETag, so the page's PMTiles reader never mixes two archives' bytes.
  const etag = `"${createHash('sha1').update(archive).digest('hex')}"`;
  const log: OvertureTileLog = { catalogue: 0, ranges: [] };
  const catalogue: Record<string, unknown> = {
    'https://stac.overturemaps.org/catalog.json': { latest: RELEASE },
    [`https://stac.overturemaps.org/${RELEASE}/buildings/catalog.json`]: { links: [{ rel: 'pmtiles', href: ARCHIVE_URL }] }
  };
  await page.route('https://stac.overturemaps.org/**', (route: Route) => {
    log.catalogue += 1;
    const body = catalogue[route.request().url()];
    return body ? route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } }) : route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://tiles.overturemaps.org/**', (route: Route) => {
    if (route.request().url() !== ARCHIVE_URL) return route.fulfill({ status: 404, body: '' });
    const range = /bytes=(\d+)-(\d+)?/.exec(route.request().headers().range || '');
    const start = range ? Number(range[1]) : 0;
    const end = Math.min(archive.length - 1, range && range[2] ? Number(range[2]) : archive.length - 1);
    log.ranges.push(`${start}-${end}`);
    return route.fulfill({
      status: 206,
      body: archive.subarray(start, end + 1),
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes ${start}-${end}/${archive.length}`,
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'ETag, Content-Length, Content-Range, Accept-Ranges',
        etag
      }
    });
  });
  return log;
}
