// Parcel-coverage lookups and city/point destinations for the world view.
// Pure (no DOM, no three.js) and UMD, so it runs in the browser as window.WorldCoverage and in node
// tests via require(). Data comes from frontend/data/world-coverage.json, built by
// scripts/build-world-coverage.mjs (which documents what each tier means).
//
// API
//   WorldCoverage.load(url?) -> Promise<coverage>       fetches the JSON (default 'data/world-coverage.json')
//   WorldCoverage.create(data) -> coverage              wraps already-parsed JSON
//   coverage.tierAt(lat, lon) -> Place                  see below
//   coverage.liveCitiesAt(lat, lon) -> [{ cityId, km, via: 'extent'|'radius'|'area' }]  every configured
//                                                       city whose parcels cover the point (see below)
//   coverage.jurisdictionAt(lat, lon) -> cityId | null  the ONE city whose parcels apply there (boot,
//                                                       publication with no city); null = explore
//   coverage.nameAt(lat, lon, zoom) -> { kind: 'city'|'country'|'territory'|'ocean'|'world', name, cc }  the chip name
//   coverage.regionAt(lat, lon) -> region record | null  the state/province/UK nation outline holding a point
//   coverage.pointAt(lat, lon) -> point destination     exact coordinates, with their app routing
//   coverage.cityPlace(city) -> city destination       preserves the explicit marker/search identity
//   coverage.searchPlaces(query, { limit }) -> Place[]  cities only, diacritic-insensitive, best first
//   coverage.liveSummary -> { cityCount, countryCount } unique configured live-city and country counts
//   coverage.tierColors / WorldCoverage.TIERS
//
// Place: { kind: 'live-city' | 'city' | 'point' | 'region' | 'country' | 'territory' | 'ocean', tier: 'live'|'source'|'none'|'unknown',
//          name, country, cc, note, lat, lon, placeKey, cityId?, regionId?, coverage?, coverageSources? }
//   Countries and regions carry geographic coverage (full/mostly/partial/none/unknown), independently of app
//   routing. A region (US state, Canadian province, England, ...) answers for its part of a country,
//   except inside a countrywide-live country, whose routing the country place carries.
//   Only city and point places are navigation destinations; area places are coverage context.
//   WorldCoverage.statusKey(place) selects the matching localized label/description prefix.
//   cityId is set when tier is 'live' (the configured app city to open: inside an area a parcel source
//   declares, Croatia or England, also on a country, region or registry-city place). placeKey is a stable id for
//   city requests: registry city id, 'region:<ISO 3166-2>', 'country:<ISO2>', 'territory:<source-id>'
//   or 'point:<lat>,<lon>'.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldCoverage = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const TIERS = ['live', 'source', 'none', 'unknown'];
    const COVERAGE_LEVELS = ['full', 'mostly', 'partial', 'none', 'unknown'];
    const TIER_RANK = { live: 3, source: 2, none: 1, unknown: 0 };
    const LIVE_RADIUS_KM = 60;
    const CITY_RADIUS_KM = 40;
    const RINGLESS_COUNTRY_RADIUS_KM = 30;
    const NAME_CITY_RADIUS_KM = 25;
    const NAME_MIN_ZOOM = 5;
    const EXTENT_TWIN_KM = 10;
    const EARTH_RADIUS_KM = 6371.0088;

    function statusKey(place) {
        if (place.kind === 'country') return 'world.coverage.' + place.coverage;
        if (place.kind === 'region') return 'world.regionCoverage.' + place.coverage;
        return 'world.tier.' + place.tier;
    }

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

    // Planar area of even-odd rings in km² (equirectangular at each edge's latitude): enough to rank
    // nested administrative extents, smallest first.
    function ringsAreaKm2(rings) {
        const k = (Math.PI / 180) * EARTH_RADIUS_KM;
        let total = 0;
        for (const ring of rings) {
            let sum = 0;
            for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
                const cos = Math.cos(((ring[i + 1] + ring[j + 1]) / 2) * Math.PI / 180);
                sum += (ring[j] * cos * k) * (ring[i + 1] * k) - (ring[i] * cos * k) * (ring[j + 1] * k);
            }
            total += Math.abs(sum) / 2;
        }
        return total;
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

    // Candidate lookup for suppressing registry cities already covered by a configured city.
    // Unit-sphere XYZ buckets avoid longitude wrap and polar crowding; an exact haversine check
    // still decides every candidate, preserving the radius semantics of the original scan.
    function filterCoveredRegistryCities(liveCities, registryCities) {
        if (!liveCities.length || !registryCities.length) return registryCities.slice();

        // A city with an administrative extent covers the registry cities inside it, and its registry
        // twin (the settlement locator its centre came from, which can lie in a neighbouring district)
        // within EXTENT_TWIN_KM of its centre.
        const extents = liveCities.filter(city => Array.isArray(city.extent));
        if (extents.length) {
            const boxed = extents.map(city => ({ rings: city.extent, bbox: ringsBbox(city.extent) }));
            registryCities = registryCities.filter(city => !boxed.some(({ rings, bbox }) =>
                city.lat >= bbox.minLat && city.lat <= bbox.maxLat && city.lon >= bbox.minLon && city.lon <= bbox.maxLon
                && pointInRings(city.lat, city.lon, rings)));
            liveCities = liveCities.map(city => (Array.isArray(city.extent) ? { lat: city.lat, lon: city.lon, radiusKm: EXTENT_TWIN_KM } : city));
        }
        const indexed = [];
        let maxRadiusKm = 0;
        liveCities.forEach(function (city) {
            const lat = Number(city.lat); const lon = Number(city.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            const radiusKm = Number(city.radiusKm ?? LIVE_RADIUS_KM);
            if (radiusKm > maxRadiusKm) maxRadiusKm = Math.min(radiusKm, Math.PI * EARTH_RADIUS_KM);
            indexed.push(city);
        });
        if (!indexed.length) return registryCities.slice();

        function unitSpherePoint(place) {
            const lat = Number(place.lat) * Math.PI / 180;
            const lon = Number(place.lon) * Math.PI / 180;
            const cosLat = Math.cos(lat);
            return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
        }

        const maxChord = 2 * Math.sin(maxRadiusKm / (2 * EARTH_RADIUS_KM));
        // A small floor handles zero-radius and tiny-radius cities without zero-sized buckets.
        const bucketSize = Math.max(Math.min(2, maxChord * (1 + 1e-12) + 1e-12), 1e-6);
        function bucketCoordinate(value) { return Math.floor((value + 1) / bucketSize); }
        function bucketKey(x, y, z) { return x + ',' + y + ',' + z; }
        const buckets = new Map();
        indexed.forEach(function (city) {
            const point = unitSpherePoint(city);
            const x = bucketCoordinate(point[0]); const y = bucketCoordinate(point[1]); const z = bucketCoordinate(point[2]);
            const key = bucketKey(x, y, z);
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(city);
        });

        function isCovered(city, candidates) {
            for (const live of candidates) {
                if (haversineKm(live.lat, live.lon, city.lat, city.lon) <= (live.radiusKm ?? LIVE_RADIUS_KM)) return true;
            }
            return false;
        }

        return registryCities.filter(function (city) {
            const lat = Number(city.lat); const lon = Number(city.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
            const point = unitSpherePoint(city);
            const x = bucketCoordinate(point[0]); const y = bucketCoordinate(point[1]); const z = bucketCoordinate(point[2]);
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        const candidates = buckets.get(bucketKey(x + dx, y + dy, z + dz));
                        if (candidates && isCovered(city, candidates)) return false;
                    }
                }
            }
            return true;
        });
    }

    // `data` is world-coverage.json, or the boot subset frontend/data/boot-coverage.js (live cities, their
    // extents and the declared areas liveCitiesAt needs, no registry cities), which answers liveCitiesAt identically.
    function create(data) {
        if (!data || !Array.isArray(data.countries) || !Array.isArray(data.cities) || !Array.isArray(data.liveCities)) {
            throw new Error('world-coverage: malformed data');
        }
        const countries = data.countries.map(c => Object.assign({}, c, { bbox: c.rings.length ? ringsBbox(c.rings) : null }));
        const territories = (data.territories || []).map(c => Object.assign({}, c, { bbox: c.rings.length ? ringsBbox(c.rings) : null }));
        const regions = (data.regions || []).map(r => Object.assign({}, r, { bbox: r.rings.length ? ringsBbox(r.rings) : null }));
        const countryByCc = new Map(countries.map(c => [c.cc, c]));
        const liveCities = data.liveCities;
        const liveById = new Map(liveCities.map(city => [city.id, city]));
        // Cities with an administrative extent (build-world-coverage.mjs), smallest first, and the rest
        // with their circles; the areas parcel sources declare (Croatia, England, Wales).
        const extentCities = liveCities.filter(city => Array.isArray(city.extent))
            .map(city => ({ city, rings: city.extent, bbox: ringsBbox(city.extent), areaKm2: ringsAreaKm2(city.extent) }));
        const circleCities = liveCities.filter(city => !Array.isArray(city.extent));
        const liveAreas = (data.liveAreas || []).map(area => Object.assign({}, area, { bbox: area.rings.length ? ringsBbox(area.rings) : null }));
        const liveSummary = Object.freeze({
            cityCount: new Set(liveCities.map(city => typeof city.id === 'string' ? city.id.trim() : '').filter(Boolean)).size,
            countryCount: new Set(liveCities.map(city => typeof city.cc === 'string' ? city.cc.trim() : '').filter(Boolean)).size
        });
        // Registry cities that a configured city already covers are the same place under another name.
        const cities = filterCoveredRegistryCities(liveCities, data.cities);
        const countryName = cc => (countryByCc.get(cc) || {}).name || cc || '';

        function nearest(list, lat, lon, maxKm) {
            let best = null; let bestKm = maxKm;
            for (const item of list) {
                const km = haversineKm(lat, lon, item.lat, item.lon);
                if (km <= bestKm && km <= (item.radiusKm ?? Infinity)) { best = item; bestKm = km; }
            }
            return best;
        }

        function outlineAt(areas, lat, lon) {
            for (const c of areas) {
                const b = c.bbox;
                if (!b || lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
                if (pointInRings(lat, lon, c.rings)) return c;
            }
            return null;
        }

        function countryAt(lat, lon) {
            const country = outlineAt(countries, lat, lon);
            if (country) return country;
            const ringless = countries.filter(c => !c.rings.length && c.center)
                .map(c => ({ c, lat: c.center[0], lon: c.center[1] }));
            const hit = nearest(ringless, lat, lon, RINGLESS_COUNTRY_RADIUS_KM);
            return hit ? hit.c : null;
        }

        function livePlace(live, lat, lon) {
            return {
                kind: 'live-city', tier: 'live', cityId: live.id, name: live.name, country: countryName(live.cc), cc: live.cc,
                note: '', lat, lon, placeKey: 'live:' + live.id, ...(live.sourceId ? { sourceId: live.sourceId } : {}),
                ...(live.queryMode ? { queryMode: live.queryMode } : {}),
                ...(live.dataVersion ? { dataVersion: live.dataVersion } : {})
            };
        }

        function regionAt(lat, lon) {
            return outlineAt(regions, lat, lon);
        }

        function regionPlace(region, lat, lon) {
            return { kind: 'region', tier: region.tier, coverage: region.coverage, coverageSources: region.coverageSources,
                name: region.name, country: countryName(region.cc), cc: region.cc, regionId: region.id,
                note: region.note, lat, lon, placeKey: 'region:' + region.id };
        }

        function territoryPlace(territory, lat, lon) {
            return { kind: 'territory', tier: 'unknown', coverage: 'unknown', name: territory.name,
                country: '', cc: null, note: '', lat, lon, placeKey: 'territory:' + territory.id };
        }

        function tierAt(lat, lon) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('tierAt: lat/lon must be finite numbers');
            const hit = liveCitiesAt(lat, lon)[0];
            if (hit && hit.via !== 'area') return livePlace(liveById.get(hit.cityId), lat, lon);
            // Inside an area a parcel source declares, whatever place answers opens the city it belongs to.
            const place = placeAt(lat, lon);
            return hit ? Object.assign(place, { tier: 'live', cityId: hit.cityId }) : place;
        }

        function placeAt(lat, lon) {
            const city = nearest(cities, lat, lon, CITY_RADIUS_KM);
            if (city) {
                return {
                    kind: 'city', tier: city.tier, name: city.name, country: countryName(city.cc), cc: city.cc,
                    note: city.note, coverageSources: city.coverageSources, lat, lon, placeKey: city.id
                };
            }
            const country = countryAt(lat, lon);
            const region = country && country.tier === 'live' ? null : regionAt(lat, lon);
            if (region) return regionPlace(region, lat, lon);
            if (country) {
                return {
                    kind: 'country', tier: country.tier, coverage: country.coverage, coverageSources: country.coverageSources,
                    name: country.name, country: country.name, cc: country.cc,
                    note: country.note, lat, lon, placeKey: 'country:' + country.cc
                };
            }
            const territory = outlineAt(territories, lat, lon);
            if (territory) return territoryPlace(territory, lat, lon);
            return { kind: 'ocean', tier: 'unknown', name: '', country: '', cc: null, note: '', lat, lon, placeKey: 'point:' + roundKey(lat) + ',' + roundKey(lon) };
        }

        // Every configured city whose parcels cover a point, in the order they apply (location-first.md
        // phase 3): those whose administrative extent holds it (via 'extent'; the smallest extent first,
        // then the nearest centre, so towns sharing a district split it by distance), then those whose
        // circle holds it (cities without an extent: within liveRadiusKm, at most LIVE_RADIUS_KM; via
        // 'radius'; nearest first), then, inside an area a parcel source declares it covers (Croatia,
        // England and Wales), every city reading that source (via 'area', nearest first). Ties by id.
        // [] = no app cadastre covers the point. The city a view boots in and a publication is filed
        // in are both the first (jurisdictionAt). Circles still ignore borders (Geneva's centre falls
        // in France in the coarse country outlines); extents and declared areas follow them.
        function liveCitiesAt(lat, lon) {
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('liveCitiesAt: lat/lon must be finite numbers');
            const byId = (a, b) => (a.cityId < b.cityId ? -1 : a.cityId > b.cityId ? 1 : 0);
            const byDistance = (a, b) => a.km - b.km || byId(a, b);
            const inside = (item) => item.bbox && lat >= item.bbox.minLat && lat <= item.bbox.maxLat
                && lon >= item.bbox.minLon && lon <= item.bbox.maxLon && pointInRings(lat, lon, item.rings);
            const extent = extentCities.filter(inside)
                .map(({ city, areaKm2 }) => ({ cityId: city.id, km: haversineKm(lat, lon, city.lat, city.lon), via: 'extent', areaKm2 }))
                .sort((a, b) => a.areaKm2 - b.areaKm2 || byDistance(a, b))
                .map(({ areaKm2, ...hit }) => hit);
            const radius = [];
            for (const live of circleCities) {
                const km = haversineKm(lat, lon, live.lat, live.lon);
                if (km <= Math.min(LIVE_RADIUS_KM, live.radiusKm ?? Infinity)) radius.push({ cityId: live.id, km, via: 'radius' });
            }
            const hits = extent.concat(radius.sort(byDistance));
            const area = [];
            for (const declared of liveAreas) {
                if (!inside(declared)) continue;
                for (const cityId of declared.cityIds) {
                    const live = liveById.get(cityId);
                    if (live && !hits.some(hit => hit.cityId === cityId) && !area.some(hit => hit.cityId === cityId)) {
                        area.push({ cityId, km: haversineKm(lat, lon, live.lat, live.lon), via: 'area' });
                    }
                }
            }
            return hits.concat(area.sort(byDistance));
        }

        // The city whose parcels apply at a point: the nearest covering one (liveCitiesAt), null where
        // no app cadastre does (explore). The city a view boots in (WorldEntryModel.resolveEntry) and
        // the city a publication with no requested city is filed in are both this.
        function jurisdictionAt(lat, lon) {
            const hit = liveCitiesAt(lat, lon)[0];
            return hit ? hit.cityId : null;
        }

        // Coverage outlines describe data availability; they are never navigation destinations.
        // A background click stays the exact point even inside a city or countrywide cadastre.
        function pointAt(lat, lon) {
            const cityId = jurisdictionAt(lat, lon);
            const country = countryAt(lat, lon);
            return { kind: 'point', tier: cityId ? 'live' : 'unknown', ...(cityId ? { cityId } : {}),
                name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, country: country?.name || '', cc: country?.cc || null,
                lat, lon, note: '', placeKey: `point:${lat.toFixed(5)},${lon.toFixed(5)}` };
        }

        function cityPlace(city) {
            const live = liveById.get(city.id);
            if (live) return livePlace(live, live.lat, live.lon);
            return { kind: 'city', tier: city.tier, name: city.name, country: countryName(city.cc), cc: city.cc,
                note: city.note || '', coverageSources: city.coverageSources,
                lat: city.lat, lon: city.lon, placeKey: city.id };
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
            const territory = outlineAt(territories, lat, lon);
            if (territory) return { kind: 'territory', name: territory.name, cc: null };
            return { kind: 'ocean', name: '', cc: null };
        }

        const searchIndex = [].concat(
            liveCities.map(l => ({
                kind: 'live-city', priority: 0, tier: 'live', cityId: l.id, name: l.name, country: countryName(l.cc), cc: l.cc,
                lat: l.lat, lon: l.lon, placeKey: 'live:' + l.id, keys: [normalizeText(l.name), normalizeText(l.label)],
                ...(l.sourceId ? { sourceId: l.sourceId } : {}), ...(l.queryMode ? { queryMode: l.queryMode } : {}), ...(l.dataVersion ? { dataVersion: l.dataVersion } : {})
            })),
            cities.map(c => ({
                kind: 'city', priority: 1, tier: c.tier, name: c.name, country: countryName(c.cc), cc: c.cc, note: c.note, coverageSources: c.coverageSources,
                lat: c.lat, lon: c.lon, placeKey: c.id, keys: [normalizeText(c.name)]
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

        return { data, tierAt, liveCitiesAt, jurisdictionAt, nameAt, regionAt, pointAt, cityPlace,
            searchPlaces, countries, regions, territories, cities, liveCities, liveAreas, liveSummary };
    }

    function load(url) {
        return fetch(url || 'data/world-coverage.json', { cache: 'no-cache' })
            .then(response => {
                if (!response.ok) throw new Error('world-coverage: HTTP ' + response.status + ' for ' + (url || 'data/world-coverage.json'));
                return response.json();
            })
            .then(create);
    }

    return { TIERS, COVERAGE_LEVELS, TIER_RANK, LIVE_RADIUS_KM, CITY_RADIUS_KM, statusKey, create, load, haversineKm, normalizeText, pointInRings };
});
