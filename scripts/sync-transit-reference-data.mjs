#!/usr/bin/env node

// Vendors the canonical OSM-derived Zagreb rail alignment assets from Zagreb Isochrone.
// Use --check in validation to prove the checked-in browser copies have not drifted.
import { access, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..');
const candidates = [
    process.env.ZAGREB_ISOCHRONE_ROOT,
    path.resolve(repositoryRoot, '../zagreb-isochrone-main'),
    '/Users/simun/Code/zagreb-isochrone-main'
].filter(Boolean);
const assets = Object.freeze([
    'zagreb_rail_tracks.geojson',
    'zagreb_tram_tracks_osm.geojson'
]);

let sourceRoot = null;
for (const root of candidates) {
    try {
        await Promise.all(assets.map(name => access(path.join(root, 'website', name))));
        sourceRoot = root;
        break;
    } catch (_) { }
}

if (!sourceRoot) {
    throw new Error('Could not find Zagreb Isochrone transit assets. Set ZAGREB_ISOCHRONE_ROOT.');
}

for (const name of assets) {
    const source = path.join(sourceRoot, 'website', name);
    const destination = path.join(repositoryRoot, 'frontend', 'data', name);
    if (process.argv.includes('--check')) {
        const [canonical, vendored] = await Promise.all([readFile(source), readFile(destination)]);
        if (!canonical.equals(vendored)) {
            console.error(`${name} is stale. Run node scripts/sync-transit-reference-data.mjs.`);
            process.exitCode = 1;
        } else {
            console.log(`${name} matches the Zagreb Isochrone source.`);
        }
    } else {
        await copyFile(source, destination);
        console.log(`Synced frontend/data/${name} from ${source}.`);
    }
}
