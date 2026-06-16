// ENS label encoding for parcels and the parcelId → city mapping.
// A parcel's ENS name is `<slug>.parcels.urbangametheory.eth`; the slug is an
// ENSIP-15-safe label derived from the globally-unique parcelId. The slug is NOT
// cleanly reversible (e.g. Zagreb's `/` collapses to `-`), so slug → parcelId
// goes through the `parcel_ens` lookup table, not a pure inverse.

// Per-city id prefixes, mirroring the formats produced by the backend parcel
// routes / mint scripts. Order matters: US-NY-/US-CO- are checked before bare
// patterns. Buenos Aires uses a bare SMP (e.g. 001-005-027A) with no prefix.
const CITIES = [
    { cityId: 'zagreb', cityCode: 'zg', test: (id) => id.startsWith('HR-') },
    { cityId: 'new_york', cityCode: 'ny', test: (id) => id.startsWith('US-NY-') },
    { cityId: 'colorado', cityCode: 'co', test: (id) => id.startsWith('US-CO-') },
    { cityId: 'ljubljana', cityCode: 'lj', test: (id) => id.startsWith('SI-') },
    { cityId: 'belgrade', cityCode: 'bg', test: (id) => id.startsWith('SR-') },
    { cityId: 'buenos_aires', cityCode: 'ba', test: (id) => /^[0-9]{3}-[0-9]{3}[A-Z]?-[0-9]{3}[A-Z]?$/.test(id) },
];

// Human-readable city names, keyed by cityId — used in ENS `description` records.
const CITY_NAMES = {
    zagreb: 'Zagreb',
    new_york: 'New York',
    colorado: 'Colorado',
    ljubljana: 'Ljubljana',
    belgrade: 'Belgrade',
    buenos_aires: 'Buenos Aires',
};

// Encode a parcelId into an ENSIP-15-safe label: lowercase, every run of
// non-[a-z0-9] becomes a single hyphen, with no leading/trailing hyphen.
//   US-NY-6201001005440048 -> us-ny-6201001005440048
//   HR-335258-4341/2        -> hr-335258-4341-2
//   001-005-027A            -> 001-005-027a
function parcelToSlug(parcelId) {
    const raw = (parcelId === undefined || parcelId === null) ? '' : String(parcelId).trim();
    if (!raw) return '';
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Resolve a parcelId to its city using the id prefix. Returns
// { cityId, cityCode, cityName } or null when the city can't be derived.
function parcelIdToCity(parcelId) {
    const id = (parcelId === undefined || parcelId === null) ? '' : String(parcelId).trim().toUpperCase();
    if (!id) return null;
    const match = CITIES.find((c) => c.test(id));
    if (!match) return null;
    return { cityId: match.cityId, cityCode: match.cityCode, cityName: CITY_NAMES[match.cityId] };
}

export { parcelToSlug, parcelIdToCity, CITIES, CITY_NAMES };
