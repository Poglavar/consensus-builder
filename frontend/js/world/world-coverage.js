// Parcel-coverage lookups for the world view: which tier a clicked point is in, and place search.
// Pure (no DOM, no three.js) and UMD, so it runs in the browser as window.WorldCoverage and in node
// tests via require(). Data comes from frontend/data/world-coverage.json, built by
// scripts/build-world-coverage.mjs (which documents what each tier means).
//
// API
//   WorldCoverage.load(url?) -> Promise<coverage>       fetches the JSON (default 'data/world-coverage.json')
//   WorldCoverage.create(data) -> coverage              wraps already-parsed JSON
//   coverage.tierAt(lat, lon) -> Place                  see below
//   coverage.nameAt(lat, lon, zoom) -> { kind: 'city'|'country'|'ocean'|'world', name, cc }  the chip name
//   coverage.searchPlaces(query, { limit }) -> Place[]  diacritic-insensitive, best first
//   coverage.tierColors / WorldCoverage.TIERS
//
// Place: { kind: 'live-city' | 'city' | 'country' | 'ocean', tier: 'live'|'source'|'none'|'unknown',
//          name, country, cc, note, lat, lon, placeKey, cityId? }
//   cityId is set when tier is 'live' (the configured app city to open). placeKey is a stable id for
//   city requests: registry city id, 'country:<ISO2>' or 'point:<lat>,<lon>'.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldCoverage = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const TIERS = ['live', 'source', 'none', 'unknown'];
    const TIER_RANK = { live: 3, source: 2, none: 1, unknown: 0 };
    const LIVE_RADIUS_KM = 60;
    const CITY_RADIUS_KM = 40;
    const RINGLESS_COUNTRY_RADIUS_KM = 30;
    const NAME_CITY_RADIUS_KM = 25;
    const NAME_MIN_ZOOM = 5;
    const EARTH_RADIUS_KM = 6371.0088;

    function haversineKm(lat1, lon1, lat2, lon2) {
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    // Even-odd over all of a country's rings (flat [lon, lat, ...]); holes fall out of the parity.
    function pointInRings(lat, lon, rings) {
        let inside = false;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
                const xi = ring[i]; const yi = ring[i + 1]; const xj = ring[j]; const yj = ring[j + 1];
                if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
            }
        }
        return inside;
    }

    function ringsBbox(rings) {
        let minLon = Infinity; let minLat = Infinity; let maxLon = -Infinity; let maxLat = -Infinity;
        for (const ring of rings) {
            for (let i = 0; i < ring.length; i += 2) {
                if (ring[i] < minLon) minLon = ring[i];
                if (ring[i] > maxLon) maxLon = ring[i];
                if (ring[i + 1] < minLat) minLat = ring[i + 1];
                if (ring[i + 1] > maxLat) maxLat = ring[i + 1];
            }
        }
        return { minLon, minLat, maxLon, maxLat };
    }

    // Lower-case, strip combining marks, and fold letters NFD does not decompose (đ, ł, ø, ß...).
    function normalizeText(text) {
        return String(text || '')
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[đð]/g, 'd').replace(/ł/g, 'l').replace(/ø/g, 'o').replace(/ß/g, 'ss')
            .replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ı/g, 'i')
            .replace(/[^a-z0-9]+/g, ' ').trim();
    }

    // 0 exact, 1 prefix, 2 word prefix, 3 substring, null no match.
    function matchScore(haystack, needle) {
        if (!needle || !haystack) return null;
        if (haystack === needle) return 0;
        if (haystack.startsWith(needle)) return 1;
        if ((' ' + haystack).includes(' ' + needle)) return 2;
        if (haystack.includes(needle)) return 3;
        return null;
    }

    function roundKey(v) { return (Math.round(v * 10) / 10).toFixed(1); }

    function create(data) {
        if (!data || !Array.isArray(data.countries) || !Array.isArray(data.cities) || !Array.isArray(data.liveCities)) {
            throw new Error('world-coverage: malformed data');
        }
        const countries = data.countries.map(c => Object.assign({}, c, { bbox: c.rings.length ? ringsBbox(c.rings) : null }));
        const countryByCc = new Map(countries.map(c => [c.cc, c]));
        const liveCities = data.liveCities;
        // Registry cities that a configured city already covers are the same place under another name.
        const cities = data.cities.filter(city => !liveCities.some(l => haversineKm(l.lat, l.lon, city.lat, city.lon) <= (l.radiusKm ?? LIVE_RADIUS_KM)));
        const countryName = cc => (countryByCc.get(cc) || {}).name || cc || '';

        function nearest(list, lat, lon, maxKm) {
            let best = null; let bestKm = maxKm;
            for (const item of list) {
                const km = haversineKm(lat, lon, item.lat, item.lon);
                if (km <= bestKm && km <= (item.radiusKm ?? Infinity)) { best = item; bestKm = km; }
            }
            return best;
        }

        function countryAt(lat, lon) {
            for (const c of countries) {
                const b = c.bbox;
                if (!b || lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
                if (pointInRings(lat, lon, c.rings)) return c;
            }
            const ringless = countries.filter(c => !c.rings.length && c.center)
                .map(c => ({ c, lat: c.center[0], lon: c.center[1] }));
            const hit = nearest(ringless, lat, lon, RINGLESS_COUNTRY_RADIUS_KM);
            return hit ? hit.c : null;
        }

        function livePlace(live, lat, lon) {
            return {
                kind: 'live-city', tier: 'live', cityId: live.id, name: live.name, country: countryName(live.cc), cc: live.cc,
                note: '', lat, lon, placeKey: 'live:' + live.id, ...(live.sourceId ? { sourceId: live.sourceId } : {}),
                ...(live.dataVersion ? { dataVersion: live.dataVersion } : {})
            };
        }

        function tierAt(lat, lon) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('tierAt: lat/lon must be finite numbers');
            const live = nearest(liveCities, lat, lon, LIVE_RADIUS_KM);
            if (live) return livePlace(live, lat, lon);
            const city = nearest(cities, lat, lon, CITY_RADIUS_KM);
            if (city) {
                return {
                    kind: 'city', tier: city.tier, name: city.name, country: countryName(city.cc), cc: city.cc,
                    note: city.note, lat, lon, placeKey: city.id
                };
            }
            const country = countryAt(lat, lon);
            if (country) {
                const place = {
                    kind: 'country', tier: country.tier, name: country.name, country: country.name, cc: country.cc,
                    note: country.note, lat, lon, placeKey: 'country:' + country.cc
                };
                if (country.tier === 'live') {
                    // A countrywide live country: open the configured city of that country nearest the point.
                    const own = liveCities.filter(l => l.cc === country.cc);
                    const near = nearest(own, lat, lon, Infinity);
                    if (near) place.cityId = near.id;
                }
                return place;
            }
            return { kind: 'ocean', tier: 'unknown', name: '', country: '', cc: null, note: '', lat, lon, placeKey: 'point:' + roundKey(lat) + ',' + roundKey(lon) };
        }

        // The name of where the map is (the explore city chip): the nearest configured or registry
        // city within NAME_CITY_RADIUS_KM, else the country, else '' (open water). Tighter than the
        // coverage radii above, which say which data covers a point, not what the place is called:
        // Yokohama is not "Tokyo". Below NAME_MIN_ZOOM the map shows a continent, so no one place.
        function nameAt(lat, lon, zoom) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('nameAt: lat/lon must be finite numbers');
            if (Number.isFinite(zoom) && zoom < NAME_MIN_ZOOM) return { kind: 'world', name: '', cc: null };
            const city = nearest(liveCities.concat(cities), lat, lon, NAME_CITY_RADIUS_KM);
            if (city) return { kind: 'city', name: city.name, cc: city.cc || null };
            const country = countryAt(lat, lon);
            if (country) return { kind: 'country', name: country.name, cc: country.cc };
            return { kind: 'ocean', name: '', cc: null };
        }

        const searchIndex = [].concat(
            liveCities.map(l => ({
                kind: 'live-city', priority: 0, tier: 'live', cityId: l.id, name: l.name, country: countryName(l.cc), cc: l.cc,
                lat: l.lat, lon: l.lon, placeKey: 'live:' + l.id, keys: [normalizeText(l.name), normalizeText(l.label)],
                ...(l.sourceId ? { sourceId: l.sourceId } : {}), ...(l.dataVersion ? { dataVersion: l.dataVersion } : {})
            })),
            cities.map(c => ({
                kind: 'city', priority: 1, tier: c.tier, name: c.name, country: countryName(c.cc), cc: c.cc, note: c.note,
                lat: c.lat, lon: c.lon, placeKey: c.id, keys: [normalizeText(c.name)]
            })),
            countries.filter(c => c.center).map(c => ({
                kind: 'country', priority: 2, tier: c.tier, name: c.name, country: c.name, cc: c.cc, note: c.note,
                lat: c.center[0], lon: c.center[1], placeKey: 'country:' + c.cc, keys: [normalizeText(c.name), c.cc.toLowerCase()]
            }))
        );

        function searchPlaces(query, options) {
            const limit = (options && options.limit) || 8;
            const needle = normalizeText(query);
            if (!needle) return [];
            const scored = [];
            for (const item of searchIndex) {
                let score = null;
                for (const key of item.keys) {
                    const s = matchScore(key, needle);
                    if (s !== null && (score === null || s < score)) score = s;
                }
                if (score === null) continue;
                scored.push({ item, score });
            }
            scored.sort((a, b) => a.score - b.score
                || a.item.priority - b.item.priority
                || TIER_RANK[b.item.tier] - TIER_RANK[a.item.tier]
                || a.item.name.length - b.item.name.length
                || a.item.name.localeCompare(b.item.name));
            return scored.slice(0, limit).map(({ item }) => {
                const { keys, priority, ...place } = item;
                return Object.assign({ note: '' }, place);
            });
        }

        return { data, tierAt, nameAt, searchPlaces, countries, cities, liveCities };
    }

    function load(url) {
        return fetch(url || 'data/world-coverage.json', { cache: 'no-cache' })
            .then(response => {
                if (!response.ok) throw new Error('world-coverage: HTTP ' + response.status + ' for ' + (url || 'data/world-coverage.json'));
                return response.json();
            })
            .then(create);
    }

    return { TIERS, TIER_RANK, LIVE_RADIUS_KM, CITY_RADIUS_KM, create, load, haversineKm, normalizeText, pointInRings };
});
