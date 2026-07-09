// Fetches per-lot zoning attributes from NYC DCP's PLUTO dataset (Socrata
// 64uk-42ks) live by BBL, with a small in-memory cache. PLUTO is the only
// official source for a lot's zoning district + FAR + dimensions; we do NOT
// persist it (matches the owners/footprints live-fetch pattern) — one cheap
// GET per clicked lot, cached so repeat clicks don't re-hit Socrata.

import { parseBbl } from '../routes/nyc-condo-owners.js';

const PLUTO_URL = 'https://data.cityofnewyork.us/resource/64uk-42ks.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // PLUTO updates ~quarterly; an hour is plenty
const CACHE_MAX_ENTRIES = 1000;

// The only fields the envelope computation needs.
const SELECT_FIELDS = [
    'bbl', 'address',
    'zonedist1', 'zonedist2', 'zonedist3', 'zonedist4',
    'overlay1', 'overlay2', 'spdist1',
    'residfar', 'commfar', 'facilfar', 'affresfar',
    'lotarea', 'lotfront', 'lotdepth', 'lottype',
    'numfloors', 'bldgarea', 'builtfar', 'bldgclass', 'landuse',
    'yearbuilt', 'splitzone',
];

const cache = new Map();

// Build PLUTO's 10-digit BBL (borough + 5-digit block + 4-digit lot) from any
// accepted parcel id form (US-NY-<swis_sbl_id>, the 16-digit swis_sbl_id, or the
// 10-digit sbl). parseBbl already strips the SWIS prefix and validates the boro.
export function toPlutoBbl(parcelId) {
    const parts = parseBbl(parcelId);
    if (!parts) return null;
    const { boro, block, lot } = parts;
    return `${boro}${String(block).padStart(5, '0')}${String(lot).padStart(4, '0')}`;
}

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

// Normalize a raw PLUTO row (all strings) into typed fields we use downstream.
function normalizeRow(row) {
    return {
        bbl: row.bbl ? String(row.bbl).split('.')[0] : null,
        address: row.address || null,
        zonedist1: row.zonedist1 || null,
        zonedist2: row.zonedist2 || null,
        zonedist3: row.zonedist3 || null,
        zonedist4: row.zonedist4 || null,
        overlay1: row.overlay1 || null,
        overlay2: row.overlay2 || null,
        spdist1: row.spdist1 || null,
        residFar: toNumber(row.residfar),
        commFar: toNumber(row.commfar),
        facilFar: toNumber(row.facilfar),
        affResFar: toNumber(row.affresfar),
        lotArea: toNumber(row.lotarea),
        lotFront: toNumber(row.lotfront),
        lotDepth: toNumber(row.lotdepth),
        lotType: row.lottype != null ? String(row.lottype) : null,
        numFloors: toNumber(row.numfloors),
        bldgArea: toNumber(row.bldgarea),
        builtFar: toNumber(row.builtfar),
        bldgClass: row.bldgclass || null,
        landUse: row.landuse || null,
        yearBuilt: toNumber(row.yearbuilt),
        // PLUTO returns splitzone as a JSON boolean on this dataset.
        splitZone: row.splitzone === true || row.splitzone === 'true' || row.splitzone === 'Y',
    };
}

// Fetch PLUTO attributes for a parcel. Returns the normalized row, or null if the
// BBL is unparseable or PLUTO has no such lot.
export async function fetchPluto(parcelId, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const bbl = toPlutoBbl(parcelId);
    if (!bbl) return null;

    const cached = cache.get(bbl);
    if (cached && cached.at + CACHE_TTL_MS > Date.now()) {
        return cached.row;
    }

    const appToken = env.SOCRATA_APP_TOKEN || env.NYC_OPEN_DATA_APP_TOKEN || null;
    const url = `${PLUTO_URL}?bbl=${encodeURIComponent(bbl)}`
        + `&$select=${encodeURIComponent(SELECT_FIELDS.join(','))}&$limit=1`;
    const headers = appToken ? { 'X-App-Token': appToken } : {};
    const resp = await fetchImpl(url, { headers });
    if (!resp.ok) {
        throw new Error(`PLUTO HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const rows = await resp.json();
    const row = Array.isArray(rows) && rows.length ? normalizeRow(rows[0]) : null;

    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cache.set(bbl, { at: Date.now(), row });
    return row;
}

// Exposed for tests.
export function __clearCache() { cache.clear(); }
