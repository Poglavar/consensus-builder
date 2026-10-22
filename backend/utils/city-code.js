// The city id a request's city parameter names. The frontend sends short city codes
// (frontend/js/city-config.js CITY_QUERY_MAP) but designs and agreements are indexed under the full city
// id. Every code the frontend can produce must map, or that city's records become invisible: `?city=ny`
// used to fall through unmapped and never match `new_york`.
const CITY_CODE_TO_ID = {
    zg: 'zagreb',
    zgb: 'zagreb',
    st: 'split',
    si: 'sibenik',
    bg: 'belgrade',
    ba: 'buenos_aires',
    caba: 'buenos_aires',
    'ar-ba': 'buenos_aires',
    lj: 'ljubljana',
    co: 'colorado',
    ny: 'new_york'
};

export function normalizeCityCode(code) {
    const raw = (code || '').toString().trim().toLowerCase();
    if (!raw) return null;
    // Already a full city id (or an unknown value) — pass it through unchanged.
    return CITY_CODE_TO_ID[raw] || raw;
}
