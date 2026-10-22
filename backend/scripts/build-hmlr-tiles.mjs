// Cuts the pinned HM Land Registry council archives into 1 km native-grid parcel tiles, so the
// browser reads only the tiles under a view instead of importing whole councils. Raw INSPIRE input
// polygons are stored exactly (integer millimetres, delta-encoded); overlap resolution stays in
// the browser engine, so derived ground and IDs are identical to the per-council path.
//
//   node backend/scripts/build-hmlr-tiles.mjs --run --manifest <routing manifest URL or file> --out tmp/hmlr-tiles [--shard 0/3] [--only Oxford_City_Council,...] [--keep-archives]
//   node backend/scripts/build-hmlr-tiles.mjs --assemble --manifest <same> --out tmp/hmlr-tiles
//
// --run parses councils (restartable: a council with a complete marker and fragments is skipped);
// several --shard k/N processes may run at once. --assemble refuses unless every council is done,
// then writes an immutable release under <out>/release/<releaseId>/ for upload.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { officialArchiveFetch, boundedBytes } from '../parcels/gml-snapshot-source.js';
import { readGmlZipMember } from '../parcels/gml-zip-reader.js';
import { parseGmlParcels } from '../parcels/gml-parcel-reader.js';
import { HMLR_BROWSER_GROUND_POLICY } from '../parcels/hmlr-browser-ground.js';
import { HMLR_TILE_FORMAT, HMLR_TILE_SIZE_M, HMLR_INDEX_SHARD_TILES, encodeTileRow, tileRange, tileKey, indexShardKey, idBucket }
    from '../parcels/hmlr-tile-format.js';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_GML_BYTES = 1024 * 1024 * 1024;
const MAX_AUTHORITY_FEATURES = 1_500_000;
const sha = value => createHash('sha256').update(value).digest('hex');
const log = message => console.log(`[${new Date().toISOString()}] [hmlr-tiles] ${message}`);
const atomic = async (path, data) => { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, data); await rename(temp, path); };
const exists = async path => { try { await stat(path); return true; } catch { return false; } };
const numericCmp = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

export function parseCliArgs(args) {
    const options = { run: false, assemble: false, keepArchives: false, shard: [0, 1], only: null };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--run') options.run = true;
        else if (arg === '--assemble') options.assemble = true;
        else if (arg === '--keep-archives') options.keepArchives = true;
        else if (['--manifest', '--out', '--shard', '--only'].includes(arg)) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
            if (arg === '--manifest') options.manifest = value;
            else if (arg === '--out') options.out = value;
            else if (arg === '--only') options.only = new Set(value.split(',').map(name => name.trim()).filter(Boolean));
            else {
                const match = /^(\d+)\/(\d+)$/.exec(value);
                if (!match || Number(match[1]) >= Number(match[2])) throw new Error('--shard takes k/N with k < N.');
                options.shard = [Number(match[1]), Number(match[2])];
            }
        } else throw new Error(`Unknown argument ${arg}.`);
    }
    if (!options.run && !options.assemble) return null;
    if (options.run && options.assemble) throw new Error('Choose --run or --assemble.');
    if (!options.manifest || !options.out) throw new Error('--manifest and --out are required.');
    return options;
}

async function loadManifest(source) {
    const text = /^https:\/\//.test(source)
        ? await (async () => { const response = await fetch(source); if (!response.ok) throw new Error(`Manifest HTTP ${response.status}.`); return response.text(); })()
        : await readFile(source, 'utf8');
    const manifest = JSON.parse(text);
    if (manifest?.schemaVersion !== 2 || manifest.policy !== HMLR_BROWSER_GROUND_POLICY || !/^[a-f0-9]{64}$/.test(manifest.releaseId || '')
        || !Array.isArray(manifest.authorities) || !manifest.authorities.length) throw new Error('Not an HMLR routing release manifest for this policy.');
    if (sha(JSON.stringify({ schemaVersion: 2, sourceDate: manifest.sourceDate, policy: manifest.policy,
        authorities: manifest.authorities.map(({ name, endpoint, etag, bytes, archiveSha256, featureCount, nativeBounds, bounds, scope }) =>
            ({ name, endpoint, etag, bytes, archiveSha256, featureCount, nativeBounds, bounds, scope: { sha256: scope.sha256, bytes: scope.bytes } })),
        idDirectory: Object.fromEntries(Object.entries(manifest.idDirectory).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            .map(([bucket, { sha256, bytes }]) => [bucket, { sha256, bytes }])) })) !== manifest.releaseId) {
        throw new Error('Routing manifest content does not match its release ID.');
    }
    return manifest;
}

async function archiveBytes(authority, out, keepArchives) {
    const cached = join(out, 'archives', `${authority.archiveSha256}.zip`);
    if (await exists(cached)) {
        const bytes = new Uint8Array(await readFile(cached));
        if (bytes.byteLength === authority.bytes && sha(bytes) === authority.archiveSha256) return bytes;
        await rm(cached, { force: true });
    }
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await officialArchiveFetch(authority.endpoint, { signal: AbortSignal.timeout(600_000),
                headers: { Accept: 'application/zip', 'If-Match': authority.etag } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (response.headers.get('etag') !== authority.etag) throw new Error('archive ETag changed since the routing release; rebuild the routing release first');
            const bytes = new Uint8Array(await boundedBytes(response, MAX_ARCHIVE_BYTES, AbortSignal.timeout(600_000)));
            if (bytes.byteLength !== authority.bytes || sha(bytes) !== authority.archiveSha256) throw new Error('archive bytes do not match the routing release pin');
            if (keepArchives) { await mkdir(join(out, 'archives'), { recursive: true }); await atomic(cached, bytes); }
            return bytes;
        } catch (error) {
            if (attempt >= 3 || /ETag changed|do not match/.test(error.message)) throw error;
            log(`  download attempt ${attempt} failed for ${authority.name}: ${error.message}; retrying`);
            await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
        }
    }
}

async function councilDone(out, index, authority) {
    try {
        const marker = JSON.parse(await readFile(join(out, 'councils', `${index}.json`), 'utf8'));
        if (marker.archiveSha256 !== authority.archiveSha256 || marker.featureCount !== authority.featureCount) return false;
        for (const key of Object.keys(marker.tiles)) if (!await exists(join(out, 'fragments', String(index), `${key}.ndjson.gz`))) return false;
        return await exists(join(out, 'idstage', `${index}.tsv.gz`));
    } catch { return false; }
}

// One council: every parcel goes to each 1 km tile its native bounding box touches.
async function cutCouncil(manifest, index, out, keepArchives) {
    const authority = manifest.authorities[index], started = Date.now();
    const bytes = await archiveBytes(authority, out, keepArchives);
    const tiles = new Map(), ids = [];
    let rawRows = 0, maxTilesPerParcel = 0;
    const parsed = await parseGmlParcels(readGmlZipMember(bytes, MAX_GML_BYTES), {
        coordinateMode: 'native', maxBytes: MAX_GML_BYTES, maxFeatures: MAX_AUTHORITY_FEATURES,
        onFeature: feature => {
            const { row, raw, bbox } = encodeTileRow(feature);
            if (raw) rawRows++;
            const line = JSON.stringify(row), [e0, n0, e1, n1] = tileRange(bbox);
            maxTilesPerParcel = Math.max(maxTilesPerParcel, (e1 - e0 + 1) * (n1 - n0 + 1));
            for (let e = e0; e <= e1; e++) for (let n = n0; n <= n1; n++) {
                const key = tileKey(e, n);
                if (!tiles.has(key)) tiles.set(key, []);
                tiles.get(key).push(line);
            }
            ids.push(`${row[0]}\t${e0}\t${n0}\t${e1}\t${n1}`);
        }
    });
    if (parsed.sourceCrs !== 'EPSG:27700' || parsed.featureCount !== authority.featureCount || ids.length !== authority.featureCount
        || parsed.sourceTimestamp?.slice(0, 10) !== manifest.sourceDate) {
        throw new Error(`${authority.name}: GML CRS, date or feature count disagrees with the routing release.`);
    }
    const directory = join(out, 'fragments', String(index));
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const counts = {};
    for (const [key, lines] of tiles) {
        await atomic(join(directory, `${key}.ndjson.gz`), gzipSync(lines.join('\n')));
        counts[key] = lines.length;
    }
    await mkdir(join(out, 'idstage'), { recursive: true });
    await atomic(join(out, 'idstage', `${index}.tsv.gz`), gzipSync(ids.join('\n')));
    await mkdir(join(out, 'councils'), { recursive: true });
    await atomic(join(out, 'councils', `${index}.json`), JSON.stringify({ name: authority.name, archiveSha256: authority.archiveSha256,
        featureCount: authority.featureCount, rawRows, maxTilesPerParcel, tiles: counts, finishedAt: new Date().toISOString() }));
    if (!keepArchives) await rm(join(out, 'archives', `${authority.archiveSha256}.zip`), { force: true });
    return { tiles: tiles.size, rawRows, maxTilesPerParcel, ms: Date.now() - started };
}

export async function runCouncils({ manifest: source, out, shard: [k, n], only, keepArchives }) {
    const manifest = await loadManifest(source);
    const work = manifest.authorities.map((authority, index) => ({ authority, index }))
        .filter(({ authority, index }) => index % n === k && (!only || only.has(authority.name)));
    log(`release ${manifest.releaseId.slice(0, 12)} (${manifest.sourceDate}); shard ${k}/${n}: ${work.length} councils`);
    const failures = []; let done = 0, skipped = 0, parcels = 0;
    const started = Date.now();
    for (const { authority, index } of work) {
        if (await councilDone(out, index, authority)) { skipped++; done++; continue; }
        try {
            const result = await cutCouncil(manifest, index, out, keepArchives);
            done++; parcels += authority.featureCount;
            const cut = done - skipped, eta = cut ? Math.round((Date.now() - started) / cut * (work.length - done) / 1000) : 0;
            log(`${done}/${work.length} ${authority.name}: ${authority.featureCount} parcels in ${result.tiles} tiles, ${(result.ms / 1000).toFixed(1)} s`
                + `${result.rawRows ? `, ${result.rawRows} rows kept as raw coordinates` : ''}, widest parcel ${result.maxTilesPerParcel} tiles; ETA ${eta} s`);
        } catch (error) {
            failures.push(`${authority.name}: ${error.message}`);
            log(`FAILED ${authority.name}: ${error.message}`);
        }
    }
    log(`shard ${k}/${n} finished: ${done - failures.length} councils done (${skipped} already done before this run), ${parcels} parcels cut, ${failures.length} failed`);
    if (failures.length) throw new Error(`Incomplete: ${failures.join('; ')}`);
}

// Joins every council's fragments into immutable, hash-addressed tiles, index shards and ID shards.
export async function assemble({ manifest: source, out, only }) {
    const manifest = await loadManifest(source);
    const wanted = manifest.authorities.map((authority, index) => ({ authority, index }))
        .filter(({ authority }) => !only || only.has(authority.name));
    const missing = [];
    for (const { authority, index } of wanted) if (!await councilDone(out, index, authority)) missing.push(authority.name);
    if (missing.length) throw new Error(`Not every council is cut yet (${missing.length} missing, e.g. ${missing.slice(0, 3).join(', ')}).`);
    const partial = !!only;
    const stage = join(out, 'release-staging');
    await rm(stage, { recursive: true, force: true });
    await mkdir(join(stage, 'tiles'), { recursive: true });
    await mkdir(join(stage, 'index'), { recursive: true });
    await mkdir(join(stage, 'ids'), { recursive: true });

    const byTile = new Map();
    for (const { index } of wanted) {
        const marker = JSON.parse(await readFile(join(out, 'councils', `${index}.json`), 'utf8'));
        for (const key of Object.keys(marker.tiles)) { if (!byTile.has(key)) byTile.set(key, []); byTile.get(key).push(index); }
    }
    const keys = [...byTile.keys()].sort();
    log(`assembling ${keys.length} tiles from ${wanted.length} councils`);
    const shards = new Map(); let rows = 0, bytes = 0, written = 0;
    const started = Date.now();
    for (const key of keys) {
        const lines = new Set();
        for (const index of byTile.get(key)) {
            for (const line of gunzipSync(await readFile(join(out, 'fragments', String(index), `${key}.ndjson.gz`))).toString('utf8').split('\n')) lines.add(line);
        }
        const tileRows = [...lines].map(line => JSON.parse(line)).sort((a, b) => numericCmp(a[0], b[0]) || (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
        const [e, n] = key.split('_').map(Number);
        const body = gzipSync(JSON.stringify({ format: HMLR_TILE_FORMAT, tile: [e, n], rows: tileRows }), { level: 9 });
        await writeFile(join(stage, 'tiles', `${key}.json.gz`), body);
        const shard = indexShardKey(e, n);
        if (!shards.has(shard)) shards.set(shard, {});
        shards.get(shard)[key] = [sha(body), body.byteLength, tileRows.length];
        rows += tileRows.length; bytes += body.byteLength; written++;
        if (written % 5000 === 0) log(`  ${written}/${keys.length} tiles, ${(bytes / 1e9).toFixed(2)} GB; ETA ${Math.round((Date.now() - started) / written * (keys.length - written) / 1000)} s`);
    }
    const indexes = {};
    for (const [shard, tiles] of [...shards].sort(([a], [b]) => a < b ? -1 : 1)) {
        const body = gzipSync(JSON.stringify({ format: HMLR_TILE_FORMAT, shard, tiles }), { level: 9 });
        await writeFile(join(stage, 'index', `${shard}.json.gz`), body);
        indexes[shard] = { sha256: sha(body), bytes: body.byteLength };
    }
    // ID shards: native ID -> the 1 km tile range its bounding box covers.
    const buckets = new Map();
    for (const { index } of wanted) {
        for (const line of gunzipSync(await readFile(join(out, 'idstage', `${index}.tsv.gz`))).toString('utf8').split('\n')) {
            const [id, ...range] = line.split('\t');
            const bucket = idBucket(id);
            if (!buckets.has(bucket)) buckets.set(bucket, new Map());
            const ranges = buckets.get(bucket);
            if (!ranges.has(id)) ranges.set(id, []);
            const value = range.map(Number);
            if (!ranges.get(id).some(existing => existing.join() === value.join())) ranges.get(id).push(value);
        }
    }
    const ids = {};
    for (const [bucket, ranges] of [...buckets].sort(([a], [b]) => a < b ? -1 : 1)) {
        const content = Object.fromEntries([...ranges].sort(([a], [b]) => numericCmp(a, b)));
        const body = gzipSync(JSON.stringify({ format: HMLR_TILE_FORMAT, bucket, ids: content }), { level: 9 });
        await writeFile(join(stage, 'ids', `${bucket}.json.gz`), body);
        ids[bucket] = { sha256: sha(body), bytes: body.byteLength };
    }
    const core = { schemaVersion: 1, kind: 'hmlr-tiles', format: HMLR_TILE_FORMAT, policy: HMLR_BROWSER_GROUND_POLICY,
        sourceRelease: manifest.releaseId, sourceDate: manifest.sourceDate, crs: 'EPSG:27700', tileSizeM: HMLR_TILE_SIZE_M,
        indexShardTiles: HMLR_INDEX_SHARD_TILES, partial, councils: wanted.length, featureCount: wanted.reduce((sum, { authority }) => sum + authority.featureCount, 0),
        tileCount: keys.length, indexes, ids };
    const releaseId = sha(JSON.stringify(core));
    const release = join(out, 'release', releaseId);
    await rm(release, { recursive: true, force: true });
    await mkdir(join(out, 'release'), { recursive: true });
    await rename(stage, release);
    await atomic(join(release, 'manifest.json'), JSON.stringify({ ...core, releaseId }));
    log(`release ${releaseId}: ${keys.length} tiles, ${rows} tile rows, ${(bytes / 1e9).toFixed(2)} GB of tiles, ${Object.keys(indexes).length} index shards, ${Object.keys(ids).length} ID shards${partial ? ' (PARTIAL: --only)' : ''}`);
    return { releaseId, path: release };
}

async function main() {
    const options = parseCliArgs(process.argv.slice(2));
    if (!options) {
        console.log('Usage:\n  node backend/scripts/build-hmlr-tiles.mjs --run --manifest <url|file> --out <ignored dir> [--shard k/N] [--only A,B] [--keep-archives]\n'
            + '  node backend/scripts/build-hmlr-tiles.mjs --assemble --manifest <url|file> --out <ignored dir> [--only A,B]');
        return;
    }
    if (options.run) await runCouncils(options); else await assemble(options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`[${new Date().toISOString()}] [hmlr-tiles] ${error.message}`); process.exitCode = 1; });
