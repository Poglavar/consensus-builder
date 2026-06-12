// Resolves real NYC owners for a parcel from NYC DOF's Property Valuation &
// Assessment Data (Socrata dataset 8y4t-faws). NY State's parcel layer only
// carries the condo *billing* lot and frequently stamps it "UNAVAILABLE OWNER";
// the per-apartment owners live on the building's *unit* lots in the same
// borough/block, all sharing the building's street address. Given a parcel's
// BBL (from the unit table's `sbl` column) we fetch the block once (cached
// briefly) and return the deduplicated list of owners for that building.

const PVAD_URL = 'https://data.cityofnewyork.us/resource/8y4t-faws.json';
const PLACEHOLDER_OWNER = 'UNAVAILABLE OWNER';
const CONDO_BILLING_LOT_MIN = 7500; // lots >= 7500 are condo billing lots; the apartment unit lots sit below this
const MAX_ROWS = 50000; // one tax block stays well under this; ordered by lot so a building is never split across the cap
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// Coarse in-memory cache keyed by borough+block so repeated unit lookups for the
// same building (or neighbouring units) don't re-hit Socrata.
const cache = new Map();

function cacheNow() { return Date.now(); }

// NYC BBL packed into the 10-digit `sbl` value, e.g. "1005527502" = borough 1,
// block 552, lot 7502. The unit table also stores the 16-digit swis_sbl_id
// (6-digit SWIS prefix + sbl); accept either and strip the prefix.
export function parseBbl(sbl) {
    const digits = (sbl ?? '').toString().trim().replace(/\D/g, '');
    const packed = digits.length === 16 ? digits.slice(6) : digits;
    if (packed.length !== 10) return null;
    const boro = Number.parseInt(packed.slice(0, 1), 10);
    const block = Number.parseInt(packed.slice(1, 6), 10);
    const lot = Number.parseInt(packed.slice(6, 10), 10);
    if (!Number.isFinite(boro) || !Number.isFinite(block) || !Number.isFinite(lot) || boro < 1 || boro > 5) {
        return null;
    }
    return { boro, block, lot };
}

function normalizeAddress(houseNum, street) {
    return `${houseNum || ''} ${street || ''}`.trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeOwnerKey(value) {
    return (value || '').toString().trim().replace(/\s+/g, ' ').toUpperCase();
}

export function isPlaceholderOwner(value) {
    return normalizeOwnerKey(value) === PLACEHOLDER_OWNER;
}

// A condo billing lot's recorded owner is the condominium association entity, not
// the apartment owners — so we always resolve the unit owners for these.
export function isCondoBillingLot(sbl) {
    const bbl = parseBbl(sbl);
    return !!bbl && bbl.lot >= CONDO_BILLING_LOT_MIN;
}

// Reduce many year-rows per lot to a single latest-year row per lot.
function latestRowPerLot(rows) {
    const byLot = new Map();
    for (const row of rows) {
        const lot = Number.parseInt(row.lot, 10);
        if (!Number.isFinite(lot)) continue;
        const year = Number.parseInt(row.year, 10) || 0;
        const existing = byLot.get(lot);
        if (!existing || year > existing.year) {
            byLot.set(lot, { lot, year, owner: row.owner, address: normalizeAddress(row.housenum_lo, row.street_name) });
        }
    }
    return byLot;
}

function dedupeOwners(names) {
    const seen = new Set();
    const out = [];
    for (const name of names) {
        const trimmed = (name || '').toString().trim();
        if (!trimmed || isPlaceholderOwner(trimmed)) continue;
        const key = normalizeOwnerKey(trimmed);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
}

// Fetch the owner list for the building containing this BBL. For a condo billing
// lot we return every apartment-unit owner sharing the building address; for any
// lot we also surface a real owner recorded against the exact lot in another
// roll year. Returns { owners: string[], matched: 'unit'|'exact'|'none' }.
export async function fetchNycOwners(sbl, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const bbl = parseBbl(sbl);
    if (!bbl) return { owners: [], matched: 'none' };

    const cacheKey = `${bbl.boro}/${bbl.block}`;
    let byLot = cache.get(cacheKey)?.byLot;
    if (!byLot || (cache.get(cacheKey).at + CACHE_TTL_MS) <= cacheNow()) {
        const appToken = env.SOCRATA_APP_TOKEN || env.NYC_OPEN_DATA_APP_TOKEN || null;
        const select = 'lot,owner,housenum_lo,street_name,year';
        const url = `${PVAD_URL}?boro=${bbl.boro}&block=${bbl.block}`
            + `&$select=${encodeURIComponent(select)}&$order=lot&$limit=${MAX_ROWS}`;
        const headers = appToken ? { 'X-App-Token': appToken } : {};
        const resp = await fetchImpl(url, { headers });
        if (!resp.ok) {
            throw new Error(`NYC DOF HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        }
        const rows = await resp.json();
        byLot = latestRowPerLot(Array.isArray(rows) ? rows : []);
        if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
        cache.set(cacheKey, { at: cacheNow(), byLot });
    }

    const refRow = byLot.get(bbl.lot);

    // Condo billing lot: collect owners of every unit lot sharing the building address.
    if (bbl.lot >= CONDO_BILLING_LOT_MIN && refRow && refRow.address) {
        const unitOwners = [];
        for (const row of byLot.values()) {
            if (row.lot < CONDO_BILLING_LOT_MIN && row.address === refRow.address) {
                unitOwners.push(row.owner);
            }
        }
        const owners = dedupeOwners(unitOwners);
        if (owners.length) return { owners, matched: 'unit' };
    }

    // Otherwise (or if no units resolved): a real owner on the exact lot in any year.
    const exactOwners = dedupeOwners(refRow ? [refRow.owner] : []);
    if (exactOwners.length) return { owners: exactOwners, matched: 'exact' };

    return { owners: [], matched: 'none' };
}

// Exposed for tests.
export function __clearCache() { cache.clear(); }
