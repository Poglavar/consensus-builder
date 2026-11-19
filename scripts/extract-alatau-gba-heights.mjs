// Build a small local snapshot from the atlas height tile and Alatau OSM FeatureCollections.
import { readFileSync } from 'node:fs';
import { ALATAU_GBA_SOURCE, plausibleAlatauHeight } from '../backend/buildings/alatau-gba-heights.js';

const [tilePath, ...footprintPaths] = process.argv.slice(2);
if (!tilePath || !footprintPaths.length) {
    console.error('Usage: node scripts/extract-alatau-gba-heights.mjs <atlas-height-tile.json> <osm-footprints.geojson> [...]');
    process.exit(1);
}

const tile = JSON.parse(readFileSync(tilePath, 'utf8'));
const heights = {};
for (const path of footprintPaths) {
    const collection = JSON.parse(readFileSync(path, 'utf8'));
    if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features) || collection.partial || collection.truncated) {
        throw new Error('Expected a complete OSM FeatureCollection');
    }
    for (const feature of collection.features) {
        const id = feature.properties?.osm_id;
        if (typeof id !== 'string' || !/^w[1-9]\d*$/.test(id)) continue;
        const heightM = tile[`osm${id.slice(1)}KAZ`]?.height;
        if (plausibleAlatauHeight(heightM)) heights[id] = Math.round(heightM * 100) / 100;
    }
}
if (!Object.keys(heights).length) throw new Error('No usable atlas heights matched the OSM ways');
console.log(JSON.stringify({ source: ALATAU_GBA_SOURCE, heights }));
