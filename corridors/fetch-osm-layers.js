// Fetches OSM context layers for the study area from Overpass and caches them
// to data/osm-layers.json (EPSG:3765 coords). The geodata DB only has these
// layers for Zagreb, so for Trogir–Split we pull them from OSM directly.
// Usage: node fetch-osm-layers.js --run [--force]
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './lib/config.js';
import { fetchWays } from './lib/overpass.js';
import { log, fail } from './lib/log.js';

const OUT_FILE = path.join(DATA_DIR, 'osm-layers.json');

const LAYERS = {
    rail: '[railway=rail]',
    major_road: '[highway~"^(motorway|trunk|primary|secondary)$"]',
    water: '[natural=water]',
    wetland: '[natural=wetland]',
    builtup: '[landuse~"^(residential|industrial|commercial|retail)$"]',
    protected: '[boundary=protected_area]',
    nature_reserve: '[leisure=nature_reserve]',
    aerodrome: '[aeroway=aerodrome]',
};

const args = process.argv.slice(2);
if (!args.includes('--run')) {
    console.log('Fetch OSM context layers (rail, roads, water, built-up, protected, aerodrome)');
    console.log('for the Trogir–Split study area into data/osm-layers.json.');
    console.log('Usage: node fetch-osm-layers.js --run [--force]');
    process.exit(0);
}
if (fs.existsSync(OUT_FILE) && !args.includes('--force')) {
    fail(`${OUT_FILE} already exists — pass --force to refetch`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const result = {};
for (const [name, selector] of Object.entries(LAYERS)) {
    const ways = await fetchWays(selector);
    result[name] = ways.map(w => ({
        id: w.id,
        closed: w.closed,
        coords: w.coords.map(c => [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10]),
    }));
    await new Promise(r => setTimeout(r, 2000)); // be polite to Overpass between queries
}
fs.writeFileSync(OUT_FILE, JSON.stringify(result));
log(`wrote ${OUT_FILE}`, Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])));
