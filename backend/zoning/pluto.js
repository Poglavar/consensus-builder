// Read official PLUTO attributes for screening. Missing flags remain unknown;
// PLUTO tax-lot attributes do not establish zoning-lot rights or legal geometry.
import { parseBbl } from '../routes/nyc-condo-owners.js';

export const PLUTO_URL = 'https://data.cityofnewyork.us/resource/64uk-42ks.json';
export const SELECT_FIELDS = Object.freeze([
    'bbl', 'address', 'borough', 'cd', 'version',
    'zonedist1', 'zonedist2', 'zonedist3', 'zonedist4',
    'overlay1', 'overlay2', 'spdist1', 'spdist2', 'spdist3', 'ltdheight',
    'residfar', 'commfar', 'facilfar', 'affresfar',
    'lotarea', 'lotfront', 'lotdepth', 'lottype', 'irrlotcode',
    'numfloors', 'bldgarea', 'builtfar', 'bldgclass', 'landuse', 'numbldgs',
    'yearbuilt', 'splitzone', 'histdist', 'landmark', 'edesignum',
    'firm07_flag', 'pfirm15_flag', 'latitude', 'longitude',
]);
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

function toNumber(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function toFlag(value) {
    if ([true, 'true', 'Y', '1', 1].includes(value)) return true;
    if ([false, 'false', 'N', '0', 0].includes(value)) return false;
    return null;
}

function toText(value) {
    return value == null ? null : String(value).trim() || null;
}

export function toPlutoBbl(parcelId) {
    const parts = parseBbl(parcelId);
    return parts ? `${parts.boro}${String(parts.block).padStart(5, '0')}${String(parts.lot).padStart(4, '0')}` : null;
}

export function normalizePlutoRow(row) {
    const result = {};
    for (const field of ['address', 'borough', 'version', 'zonedist1', 'zonedist2', 'zonedist3', 'zonedist4',
        'overlay1', 'overlay2', 'spdist1', 'spdist2', 'spdist3']) result[field] = toText(row[field]);
    for (const [target, field] of Object.entries({
        lotArea: 'lotarea', lotFront: 'lotfront', lotDepth: 'lotdepth',
        residFar: 'residfar', commFar: 'commfar', facilFar: 'facilfar', affResFar: 'affresfar',
        numFloors: 'numfloors', bldgArea: 'bldgarea', builtFar: 'builtfar', numBldgs: 'numbldgs',
        yearBuilt: 'yearbuilt', latitude: 'latitude', longitude: 'longitude',
    })) result[target] = toNumber(row[field]);
    for (const [target, field] of Object.entries({
        communityDistrict: 'cd', lotType: 'lottype', bldgClass: 'bldgclass', landUse: 'landuse',
        limitedHeight: 'ltdheight', historicDistrict: 'histdist', landmark: 'landmark', eDesignation: 'edesignum',
    })) result[target] = toText(row[field]);
    result.bbl = toText(row.bbl)?.replace(/\.0+$/, '') ?? null;
    result.splitZone = toFlag(row.splitzone);
    result.irregularLot = toFlag(row.irrlotcode);
    result.flood2007 = toFlag(row.firm07_flag);
    result.flood2015 = toFlag(row.pfirm15_flag);
    return result;
}

export async function fetchPluto(parcelId, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const bbl = toPlutoBbl(parcelId);
    if (!bbl) return null;
    const cached = cache.get(bbl);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.row;
    const url = new URL(PLUTO_URL);
    url.searchParams.set('bbl', bbl);
    url.searchParams.set('$select', SELECT_FIELDS.join(','));
    url.searchParams.set('$limit', '2');
    const token = env.SOCRATA_APP_TOKEN || env.NYC_OPEN_DATA_APP_TOKEN;
    const response = await fetchImpl(String(url), {
        headers: token ? { 'X-App-Token': token } : {}, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`PLUTO HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('PLUTO returned an ambiguous or malformed response');
    const row = rows.length ? normalizePlutoRow(rows[0]) : null;
    if (row && row.bbl !== bbl) throw new Error('PLUTO returned a different BBL');
    if (cache.size >= 1000) cache.clear();
    cache.set(bbl, { at: Date.now(), row });
    return row;
}

export function __clearCache() { cache.clear(); }
