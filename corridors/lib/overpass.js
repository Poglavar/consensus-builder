// Minimal Overpass API client: fetches tagged ways (with geometry) in the
// study bbox and converts them to GeoJSON-ish features in EPSG:3765.
// Relations are intentionally not assembled (prototype-grade); closed ways
// become polygons, open ways stay lines.
import { BBOX_WGS84 } from './config.js';
import { toHTRS } from './proj.js';
import { log } from './log.js';

const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];

async function overpassQuery(query) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        const url = OVERPASS_URLS[attempt % OVERPASS_URLS.length];
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // overpass-api.de rejects requests without an identifying User-Agent (406)
                    'User-Agent': 'consensus-builder-corridors/0.1',
                },
                body: 'data=' + encodeURIComponent(query),
            });
            const text = await res.text();
            if (!res.ok || text.includes('rate_limited') || text.includes('runtime error')) {
                throw new Error(`overpass ${res.status}: ${text.slice(0, 200)}`);
            }
            return JSON.parse(text);
        } catch (err) {
            lastErr = err;
            const wait = 20 * (attempt + 1);
            log(`  overpass attempt ${attempt + 1} failed (${String(err.message).slice(0, 120)}), retrying in ${wait}s`);
            await new Promise(r => setTimeout(r, wait * 1000));
        }
    }
    throw lastErr;
}

export async function fetchWays(selector) {
    const b = `${BBOX_WGS84.south},${BBOX_WGS84.west},${BBOX_WGS84.north},${BBOX_WGS84.east}`;
    const query = `[out:json][timeout:120];way${selector}(${b});out geom tags;`;
    log(`overpass: way${selector}`);
    const json = await overpassQuery(query);
    const features = [];
    for (const el of json.elements || []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        const coords = el.geometry.map(p => toHTRS([p.lon, p.lat]));
        const first = coords[0], last = coords[coords.length - 1];
        const closed = first[0] === last[0] && first[1] === last[1] && coords.length >= 4;
        features.push({ id: el.id, tags: el.tags || {}, closed, coords });
    }
    log(`  -> ${features.length} ways`);
    return features;
}
