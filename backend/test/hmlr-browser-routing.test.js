// HMLR ZIP choice follows parcel polygons rather than their enclosing rectangles, and cancelled
// queries release shared council loads only when no remaining query still wants them.
import { beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import proj4 from 'proj4';
import { HMLR_BROWSER_GROUND_POLICY, HMLR_BROWSER_GROUND_PREFIX } from '../parcels/hmlr-browser-ground.js';
import { createHmlrBrowserParcelSource, createMemoryHmlrFeatureStore } from '../parcels/hmlr-browser-source.js';
import { createHmlrArchiveScopeBuilder } from '../parcels/hmlr-archive-scope.js';
import { sha256Hex } from '../parcels/portable-hash.js';
import { projectNativeBounds } from '../scripts/build-hmlr-browser-manifest.mjs';

const SOURCE_DATE = '2026-10-11';
const MANIFEST_URL = 'https://metadata.example/hmlr/manifest.json';
const ring = points => [...points, points[0]];
const square = (x, y, size) => ring([[x, y], [x + size, y], [x + size, y + size], [x, y + size]]);
// An L with a vertical leg and a horizontal leg, both `width` wide, from corner (x, y).
const ell = (x, y, width, east, north) => ring([[x, y], [east, y], [east, y + width], [x + width, y + width], [x + width, north], [x, north]]);
const memberXml = (id, points) => `<wfs:member><lr:PREDEFINED g:id="row-${id}"><lr:INSPIREID>${id}</lr:INSPIREID><lr:GEOMETRY><g:MultiSurface srsName="urn:ogc:def:crs:EPSG::27700" srsDimension="2"><g:surfaceMember><g:Polygon><g:exterior><g:LinearRing><g:posList>${points.flat().join(' ')}</g:posList></g:LinearRing></g:exterior></g:Polygon></g:surfaceMember></g:MultiSurface></lr:GEOMETRY></lr:PREDEFINED></wfs:member>`;
const collectionXml = members => `<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:lr="www.landregistry.gov.uk" xmlns:g="http://www.opengis.net/gml/3.2" timeStamp="${SOURCE_DATE}T08:30:00Z" numberMatched="${members.length}" numberReturned="${members.length}">${members.join('')}</wfs:FeatureCollection>`;
const ok = (bytes, headers = {}) => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength), ...headers } });
const toWgs = point => proj4('EPSG:27700', 'EPSG:4326', point);
const around = (point, half = 0.00002) => { const [x, y] = toWgs(point); return [x - half, y - half, x + half, y + half]; };
const wait = () => new Promise(resolve => setImmediate(resolve));

// Authorities are lists of [id, ring]; `archiveGate(index, signal)` may delay an archive response.
function fixture(authorities, { archiveGate } = {}) {
    const project = proj4('EPSG:27700', 'EPSG:4326');
    const archives = authorities.map((rows, index) => new Uint8Array(zipSync({ [`a${index}.gml`]: strToU8(collectionXml(rows.map(([id, points]) => memberXml(id, points)))) })));
    const records = authorities.map((rows, index) => {
        const xs = rows.flatMap(([, points]) => points.map(point => point[0])), ys = rows.flatMap(([, points]) => points.map(point => point[1]));
        const nativeBounds = [Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1];
        const builder = createHmlrArchiveScopeBuilder(point => project.forward(point));
        for (const [, points] of rows) builder.addGeometry({ type: 'Polygon', coordinates: [points] });
        const archiveSha256 = sha256Hex(archives[index]), scope = strToU8(JSON.stringify(builder.finish(archiveSha256)));
        return { name: `Authority ${index}`, endpoint: `https://use-land-property-data.service.gov.uk/datasets/inspire/download/a${index}.zip`,
            etag: `"a${index}"`, bytes: archives[index].length, archiveSha256, featureCount: rows.length, nativeBounds,
            bounds: projectNativeBounds(nativeBounds), scope: { sha256: sha256Hex(scope), bytes: scope.length }, scopeBytes: scope };
    });
    const ids = {};
    authorities.forEach((rows, index) => rows.forEach(([id]) => { (ids[id] ||= []).push(index); }));
    const shards = new Map();
    for (const [id, indices] of Object.entries(ids)) { const bucket = id.slice(0, 4); shards.set(bucket, { ...shards.get(bucket), [id]: indices }); }
    const shardBytes = new Map([...shards].map(([bucket, content]) => [bucket, strToU8(JSON.stringify(content))]));
    const authorityCore = records.map(({ scopeBytes, ...record }) => record);
    const idDirectory = Object.fromEntries([...shardBytes].sort(([a], [b]) => a < b ? -1 : 1).map(([bucket, bytes]) => [bucket, { sha256: sha256Hex(bytes), bytes: bytes.length }]));
    const releaseId = sha256Hex(JSON.stringify({ schemaVersion: 2, sourceDate: SOURCE_DATE, policy: HMLR_BROWSER_GROUND_POLICY, authorities: authorityCore, idDirectory }));
    authorityCore.forEach((record, index) => { record.scope = { ...record.scope, url: `https://metadata.example/hmlr/${releaseId}/scopes/${index}.${record.scope.sha256}.json` }; });
    const manifest = { schemaVersion: 2, sourceDate: SOURCE_DATE, policy: HMLR_BROWSER_GROUND_POLICY, releaseId, authorities: authorityCore,
        idDirectory: Object.fromEntries(Object.entries(idDirectory).map(([bucket, item]) => [bucket, { ...item, url: `https://metadata.example/hmlr/${releaseId}/ids/${bucket}.${item.sha256}.json` }])) };
    const archiveCalls = [], archiveSignals = [];
    const fetchImpl = async (url, options = {}) => {
        if (url === MANIFEST_URL) return ok(strToU8(JSON.stringify(manifest)));
        const scopeIndex = authorityCore.findIndex(record => record.scope.url === url);
        if (scopeIndex >= 0) return ok(records[scopeIndex].scopeBytes);
        const shard = Object.entries(manifest.idDirectory).find(([, item]) => item.url === url);
        if (shard) return ok(shardBytes.get(shard[0]));
        const index = authorityCore.findIndex(record => record.endpoint === url);
        if (index < 0) throw new Error(`Unexpected fetch ${url}`);
        archiveCalls.push(index); archiveSignals.push(options.signal);
        await archiveGate?.(index, options.signal);
        options.signal?.throwIfAborted();
        return ok(archives[index], { etag: authorityCore[index].etag });
    };
    const store = createMemoryHmlrFeatureStore();
    const create = (options = {}) => createHmlrBrowserParcelSource({ id: 'gb-hmlr-browser-v1', adapter: 'hmlr-browser', idPrefix: HMLR_BROWSER_GROUND_PREFIX, manifestUrl: MANIFEST_URL },
        { fetchImpl, featureStore: store, cacheStorage: null, indexedDB: null, allowSample: true, ...options });
    return { create, archiveCalls, archiveSignals, store, releaseId };
}

// A gate per archive that also fails like fetch when its request is aborted.
function gates() {
    const open = new Map();
    const gate = (index, signal) => new Promise((resolve, reject) => {
        open.set(index, resolve);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { gate, release: index => open.get(index)?.(), started: index => open.has(index) };
}

beforeAll(() => {
    proj4.defs('EPSG:27700', '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs');
});

const QUERY = [530810, 180210];
const id = value => `${HMLR_BROWSER_GROUND_PREFIX}${value}`;

describe('HMLR ZIP routing from parcel polygons', () => {
    it('an offscreen parcel whose rectangle covers the view cannot pull a neighbouring ZIP into it', async () => {
        // 1002's L wraps around the view without touching it, and its far leg overlaps the
        // neighbour's parcel: as a candidate it would need that ZIP for its overlap context.
        const f = fixture([
            [['1001', square(530805, 180205, 10)], ['1002', ell(530790, 180150, 10, 531000, 180300)]],
            [['2001', square(530990, 180145, 20)]]
        ]);
        const result = await f.create().queryBounds(around(QUERY));
        expect(result.features.map(item => item.id)).toEqual([id('1001')]);
        expect(f.archiveCalls).toEqual([0]);
    });

    it('a visible parcel whose rectangle (not polygon) reaches a neighbour does not download that ZIP', async () => {
        const f = fixture([
            [['3001', ell(530805, 180205, 10, 531000, 180300)]],
            [['4001', square(530990, 180280, 5)]]
        ]);
        const result = await f.create().queryBounds(around(QUERY));
        expect(result.features.map(item => item.id)).toEqual([id('3001')]);
        expect(result.features[0].properties.derivation.intersectingHigherPriorityCount).toBe(0);
        expect(f.archiveCalls).toEqual([0]);
    });

    it('a neighbour polygon that actually overlaps a visible parcel off screen is still downloaded and cuts it', async () => {
        const f = fixture([
            [['3001', ell(530805, 180205, 10, 531000, 180300)]],
            // 3,600 m² outranks the L's 2,800 m², so the L loses the overlap.
            [['4002', square(530950, 180180, 60)]]
        ]);
        const result = await f.create().queryBounds(around(QUERY));
        expect(result.features.map(item => item.id)).toEqual([id('3001')]);
        expect(result.features[0].properties.derivation.intersectingHigherPriorityCount).toBe(1);
        expect(f.archiveCalls).toEqual([0, 1]);
    });
});

describe('cancelled HMLR queries', () => {
    const twoCouncils = [[['1001', square(530805, 180205, 10)], ['1005', square(530860, 180205, 10)]], [['2001', square(531500, 180205, 10)]]];

    it('a council download continues while another query still needs it', async () => {
        const g = gates(), f = fixture(twoCouncils, { archiveGate: g.gate }), source = f.create();
        const first = new AbortController();
        const cancelled = source.queryBounds(around(QUERY), { signal: first.signal });
        const kept = source.queryBounds(around([530865, 180210]), { signal: new AbortController().signal });
        while (!g.started(0)) await wait();
        first.abort();
        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.archiveSignals[0].aborted).toBe(false);
        g.release(0);
        expect((await kept).features.map(item => item.id)).toEqual([id('1005')]);
        expect(f.archiveCalls).toEqual([0]);
    });

    it('a download nobody claims again within the grace period is aborted, leaves no ready data, and a later query reloads', async () => {
        const g = gates(), f = fixture(twoCouncils, { archiveGate: g.gate }), source = f.create({ orphanedLoadGraceMs: 10 });
        const view = new AbortController();
        const cancelled = source.queryBounds(around(QUERY), { signal: view.signal });
        while (!g.started(0)) await wait();
        view.abort();
        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.archiveSignals[0].aborted).toBe(false);
        while (!f.archiveSignals[0].aborted) await wait();
        await wait();
        expect((await f.store.getAuthority(f.releaseId, 0))?.ready).not.toBe(true);
        const retry = source.queryBounds(around(QUERY));
        while (!g.started(0) || f.archiveCalls.length < 2) await wait();
        g.release(0);
        expect((await retry).features.map(item => item.id)).toEqual([id('1001')]);
        expect(f.archiveCalls).toEqual([0, 0]);
    });

    it('a newer query that claims the same council within the grace period keeps its download running', async () => {
        const g = gates(), f = fixture(twoCouncils, { archiveGate: g.gate }), source = f.create({ orphanedLoadGraceMs: 60_000 });
        const older = new AbortController();
        const superseded = source.queryBounds(around(QUERY), { signal: older.signal });
        while (!g.started(0)) await wait();
        // The page cancels the older view first; the newer view's query for another part of the
        // same council arrives just after.
        older.abort();
        await expect(superseded).rejects.toMatchObject({ name: 'AbortError' });
        const newer = source.queryBounds(around([530865, 180210]), { signal: new AbortController().signal });
        await wait();
        g.release(0);
        expect((await newer).features.map(item => item.id)).toEqual([id('1005')]);
        expect(f.archiveSignals[0].aborted).toBe(false);
        expect(f.archiveCalls).toEqual([0]);
    });

    it('a council load still waiting for a download slot that nobody wants any more never starts', async () => {
        // Two downloads may run at once; a third council queues behind them.
        const threeCouncils = [...twoCouncils, [['3001', square(532500, 180205, 10)]]];
        const g = gates(), f = fixture(threeCouncils, { archiveGate: g.gate }), source = f.create();
        const first = source.queryBounds(around(QUERY), { signal: new AbortController().signal });
        const second = source.queryBounds(around([531505, 180210]), { signal: new AbortController().signal });
        while (!g.started(0) || !g.started(1)) await wait();
        const stale = new AbortController();
        const queued = source.queryBounds(around([532505, 180210]), { signal: stale.signal });
        await wait();
        stale.abort();
        await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
        g.release(0); g.release(1);
        await first; await second;
        await wait();
        expect([...f.archiveCalls].sort()).toEqual([0, 1]);
    });
});
