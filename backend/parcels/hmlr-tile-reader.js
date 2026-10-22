// Reads the published HMLR tile release: only the 1 km tiles under a view (and those its parcels'
// overlap context reaches) are fetched, hash-verified and decoded into the same native features the
// per-council import produces, so the existing ground engine resolves them identically.
import { gunzipSync } from 'fflate';
import { fromWgs84 } from './osgb36-projection.js';
import { sha256Hex } from './portable-hash.js';
import { upstreamError } from './source-contract.js';
import { HMLR_BROWSER_GROUND_POLICY } from './hmlr-browser-ground.js';
import { HMLR_TILE_FORMAT, HMLR_TILE_SIZE_M, HMLR_INDEX_SHARD_TILES, decodeTileRow, tileKey, tileRange, indexShardKey, idBucket }
    from './hmlr-tile-format.js';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_TILE_BYTES = 16 * 1024 * 1024;
const MAX_QUERY_TILES = 400;
const TILE_CACHE_SIZE = 400;
const FETCH_TIMEOUT_MS = 30_000;
// Repair and the 1 mm snap can move an input by under a millimetre; context boxes are padded by a metre.
const CONTEXT_PAD_M = 1;
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function canonicalCore(manifest) {
    const { releaseId, ...core } = manifest;
    return JSON.stringify(core);
}

// Native (EPSG:27700) envelope of a WGS84 rectangle, sampled along its edges through OSTN15.
export function nativeEnvelope([west, south, east, north]) {
    const xs = [], ys = [];
    for (let step = 0; step <= 8; step++) {
        const t = step / 8, lon = west + (east - west) * t, lat = south + (north - south) * t;
        for (const point of [[lon, south], [lon, north], [west, lat], [east, lat]]) {
            const [x, y] = fromWgs84(point); xs.push(x); ys.push(y);
        }
    }
    return [Math.min(...xs) - CONTEXT_PAD_M, Math.min(...ys) - CONTEXT_PAD_M, Math.max(...xs) + CONTEXT_PAD_M, Math.max(...ys) + CONTEXT_PAD_M];
}

export function createHmlrTileReader({ manifestUrl, snapshotId, fetchImpl, maxQueryTiles = MAX_QUERY_TILES }) {
    let base;
    try { base = new URL(manifestUrl); } catch { throw new Error('Invalid HMLR tile manifest URL.'); }
    if (base.protocol !== 'https:' || base.search || base.hash || !base.pathname.endsWith('/manifest.json')) throw new Error('HMLR tile manifest URL must be explicit HTTPS metadata.');
    const root = new URL('./', base).href;
    const tiles = new Map(), pending = new Map();
    let manifestPromise;

    async function verifiedBytes(url, expected, signal, limit = MAX_TILE_BYTES) {
        const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        let response;
        try { response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' }); }
        catch (error) { if (signal?.aborted) throw signal.reason; throw upstreamError(`HMLR tile store is unavailable (${error.message}).`, timeout.aborted ? 504 : 502); }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw upstreamError(`HMLR tile store answered HTTP ${response.status}.`, 502); }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) throw upstreamError('HMLR tile store file exceeds its byte limit.', 502);
        if (expected && (bytes.byteLength !== expected.bytes || sha256Hex(bytes) !== expected.sha256)) {
            throw upstreamError('HMLR tile store file does not match its release hash.', 502);
        }
        return bytes;
    }
    const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const gzJson = bytes => json(gunzipSync(bytes));

    function getManifest(signal) {
        if (!manifestPromise) manifestPromise = (async () => {
            const manifest = json(await verifiedBytes(base.href, null, signal, MAX_MANIFEST_BYTES));
            if (manifest?.schemaVersion !== 1 || manifest.kind !== 'hmlr-tiles' || manifest.format !== HMLR_TILE_FORMAT
                || manifest.policy !== HMLR_BROWSER_GROUND_POLICY || manifest.tileSizeM !== HMLR_TILE_SIZE_M
                || manifest.indexShardTiles !== HMLR_INDEX_SHARD_TILES || manifest.partial !== false
                || !/^[a-f0-9]{64}$/.test(manifest.releaseId || '') || sha256Hex(canonicalCore(manifest)) !== manifest.releaseId
                || !base.pathname.endsWith(`/${manifest.releaseId}/manifest.json`)) {
                throw upstreamError('HMLR tile manifest is invalid, partial, or does not match its release.', 502);
            }
            // Tiles and the per-council fallback must describe the same pinned archive edition.
            if (snapshotId !== undefined && manifest.sourceRelease !== snapshotId) throw upstreamError('HMLR tile release was cut from a different archive edition.', 502);
            return manifest;
        })().catch(error => { manifestPromise = null; throw error; });
        return manifestPromise;
    }

    async function shared(key, load) {
        if (tiles.has(key)) { const value = tiles.get(key); tiles.delete(key); tiles.set(key, value); return value; }
        if (pending.has(key)) return pending.get(key);
        const task = load().then(value => {
            tiles.set(key, value);
            while (tiles.size > TILE_CACHE_SIZE) tiles.delete(tiles.keys().next().value);
            return value;
        }).finally(() => pending.delete(key));
        pending.set(key, task);
        return task;
    }
    async function indexShard(manifest, e, n, signal) {
        const shard = indexShardKey(e, n), expected = manifest.indexes[shard];
        if (!expected) return {};
        return shared(`index:${shard}`, async () => gzJson(await verifiedBytes(`${root}index/${shard}.json.gz`, expected, signal)).tiles);
    }
    // Decoded features of one tile; a tile no parcel touches is simply empty.
    async function tile(manifest, e, n, signal) {
        const key = tileKey(e, n), entry = (await indexShard(manifest, e, n, signal))[key];
        if (!entry) return [];
        return shared(`tile:${key}`, async () => {
            const content = gzJson(await verifiedBytes(`${root}tiles/${key}.json.gz`, { sha256: entry[0], bytes: entry[1] }, signal));
            if (content.format !== HMLR_TILE_FORMAT || content.tile?.[0] !== e || content.tile?.[1] !== n || content.rows.length !== entry[2]) {
                throw upstreamError('HMLR tile content disagrees with its index.', 502);
            }
            return content.rows.map(decodeTileRow);
        });
    }
    async function tilesInRanges(manifest, ranges, signal) {
        const keys = new Map();
        for (const [e0, n0, e1, n1] of ranges) for (let e = e0; e <= e1; e++) for (let n = n0; n <= n1; n++) keys.set(tileKey(e, n), [e, n]);
        if (keys.size > maxQueryTiles) throw upstreamError(`HMLR query needs ${keys.size} tiles, over the ${maxQueryTiles} tile limit.`, 413);
        const lists = await Promise.all([...keys.values()].map(([e, n]) => tile(manifest, e, n, signal)));
        // A parcel near a tile edge is in every tile its box touches; keep one copy per identical input.
        const unique = new Map();
        for (const list of lists) for (const feature of list) {
            const key = `${feature.id}:${JSON.stringify(feature.geometry)}`;
            if (!unique.has(key)) unique.set(key, feature);
        }
        return [...unique.values()];
    }

    return Object.freeze({
        manifest: getManifest,
        // Native input polygons whose box meets the view's native envelope.
        async candidatesInBounds(bounds, signal) {
            const manifest = await getManifest(signal), box = nativeEnvelope(bounds);
            const features = await tilesInRanges(manifest, [tileRange(box)], signal);
            return { manifest, features: features.filter(feature => overlaps(feature.bbox, box)) };
        },
        // Every input whose box meets a candidate's padded box: the overlap context the engine needs.
        async contextFor(candidates, signal) {
            const manifest = await getManifest(signal);
            const boxes = candidates.map(feature => [feature.bbox[0] - CONTEXT_PAD_M, feature.bbox[1] - CONTEXT_PAD_M,
                feature.bbox[2] + CONTEXT_PAD_M, feature.bbox[3] + CONTEXT_PAD_M]);
            const features = await tilesInRanges(manifest, boxes.map(tileRange), signal);
            // Bucket candidate boxes by tile so each input is compared only with nearby candidates.
            const byTile = new Map();
            boxes.forEach(box => {
                const [e0, n0, e1, n1] = tileRange(box);
                for (let e = e0; e <= e1; e++) for (let n = n0; n <= n1; n++) {
                    const key = tileKey(e, n); if (!byTile.has(key)) byTile.set(key, []); byTile.get(key).push(box);
                }
            });
            return features.filter(feature => {
                const [e0, n0, e1, n1] = tileRange(feature.bbox);
                for (let e = e0; e <= e1; e++) for (let n = n0; n <= n1; n++) {
                    if (byTile.get(tileKey(e, n))?.some(box => overlaps(box, feature.bbox))) return true;
                }
                return false;
            });
        },
        // Native inputs for exact IDs; IDs the release does not list are absent.
        async featuresForIds(nativeIds, signal) {
            const manifest = await getManifest(signal);
            const buckets = [...new Set(nativeIds.map(idBucket))];
            const shards = new Map(await Promise.all(buckets.map(async bucket => {
                const expected = manifest.ids[bucket];
                if (!expected) return [bucket, {}];
                return [bucket, await shared(`ids:${bucket}`, async () => gzJson(await verifiedBytes(`${root}ids/${bucket}.json.gz`, expected, signal)).ids)];
            })));
            const ranges = [], listed = new Set();
            for (const id of nativeIds) {
                const found = shards.get(idBucket(id))[id];
                if (found) { listed.add(id); ranges.push(...found); }
            }
            const features = ranges.length ? await tilesInRanges(manifest, ranges, signal) : [];
            return { features: features.filter(feature => listed.has(feature.id)), listed };
        }
    });
}
