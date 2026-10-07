// Pure sorting, filtering and jurisdiction-level summaries for the parcel research report.
export const COVERAGE_CATEGORIES = ['national', 'local', 'none', 'unknown'];
export const METRICS = ['landAreaKm2', 'builtUpAreaKm2', 'population'];

const present = value => value !== null && value !== undefined && value !== '';
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function nextSort(previous, key) {
    return { key, direction: previous?.key === key && previous.direction === 'asc' ? 'desc' : 'asc' };
}

export function sortRows(rows, { key, direction = 'asc' }, locale = 'en') {
    const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    return rows.map((row, index) => ({ row, index })).sort((a, b) => {
        const left = a.row[key]; const right = b.row[key];
        // Unknown values remain last in both directions; zero and false are real values.
        if (!present(left) || !present(right)) {
            if (present(left)) return -1;
            if (present(right)) return 1;
            return a.index - b.index;
        }
        const comparison = typeof left === 'number' && typeof right === 'number'
            ? left - right
            : typeof left === 'boolean' && typeof right === 'boolean'
                ? Number(left) - Number(right)
                : collator.compare(String(left), String(right));
        return (direction === 'desc' ? -comparison : comparison) || a.index - b.index;
    }).map(item => item.row);
}

export const normalizeSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();

export function filterCities(rows, { query = '', checked = 'all', registry = 'all', country = '', cohort = 'all' } = {}) {
    const needle = normalizeSearch(query).trim();
    return rows.filter(row => (!needle || normalizeSearch(`${row.name} ${row.country} ${row.countryCode}`).includes(needle))
        && (!country || row.countryCode === country)
        && (checked === 'all' || row.checked === (checked === 'yes'))
        && (registry === 'all' || (registry === 'unknown' ? row.registryFound === null : row.registryFound === (registry === 'yes')))
        && (cohort === 'all' || (cohort === 'largest200' && row.cohorts?.includes('largest200'))
            || (cohort === 'growth200' && row.cohorts?.includes('growth200'))
            || (cohort === 'growth-top20' && Number.isInteger(row.growthRank) && row.growthRank >= 1 && row.growthRank <= 20)));
}

export function filterCountries(rows, { query = '', category = 'all' } = {}) {
    const needle = normalizeSearch(query).trim();
    return rows.filter(row => (!needle || normalizeSearch(`${row.name} ${row.code}`).includes(needle))
        && (category === 'all' || row.category === category));
}

export function countryCategory(country) {
    if (country.nationalCadastreFound === true) return 'national';
    if (country.citiesWithRegistry > 0 || country.subnationalEvidence || ['subnational_only', 'partial_or_unofficial_sample'].includes(country.probeStatus)) return 'local';
    if (country.nationalCadastreFound === false) return 'none';
    return 'unknown';
}

export function summarizeJurisdictions(countries, world) {
    const result = COVERAGE_CATEGORIES.map(id => ({ id, jurisdictions: 0, landAreaKm2: 0, builtUpAreaKm2: 0, population: 0 }));
    const byId = new Map(result.map(row => [row.id, row]));
    const statisticsAvailable = Object.fromEntries(METRICS.map(key => [key, 0]));
    for (const country of countries) {
        const row = byId.get(country.category);
        if (!row) throw new Error(`Unknown coverage category: ${country.category}`);
        row.jurisdictions++;
        // Supplementary/disputed rows may overlap a statistical parent. Never add them twice.
        if (country.statisticsIncluded === false) continue;
        for (const key of METRICS) {
            if (!finite(country[key])) continue;
            if (country[key] < 0) throw new Error(`Negative ${key} for ${country.code}`);
            row[key] += country[key];
            statisticsAvailable[key]++;
        }
    }
    const residual = {};
    for (const key of METRICS) {
        const denominator = world[key];
        if (!finite(denominator) || denominator <= 0) throw new Error(`Missing world denominator: ${key}`);
        const total = result.reduce((sum, row) => sum + row[key], 0);
        const difference = denominator - total;
        if (difference < -Math.max(1, denominator * 0.00001)) throw new Error(`Jurisdiction totals exceed world ${key}; check duplicate territory statistics`);
        residual[key] = Math.max(0, difference);
        byId.get('unknown')[key] += residual[key];
        for (const row of result) row[`${key}Pct`] = row[key] / denominator * 100;
    }
    return { rows: result, statisticsAvailable, residual };
}

export function mapLinks(latitude, longitude) {
    if (!finite(latitude) || !finite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return { osmUrl: null, googleMapsUrl: null };
    const lat = latitude.toFixed(5); const lon = longitude.toFixed(5);
    return {
        osmUrl: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}`,
        googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`
    };
}
