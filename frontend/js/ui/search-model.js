// ui/search-model.js — the pure half of the map search box (js/ui/map-search.js): what a query looks
// like (city, parcel id, proposal, address, command), which parcel ids to try for it, how result
// groups are ranked, where a geocoded place sits relative to the configured cities, the recent
// searches list and the keyboard selection state. No DOM, no network; UMD so
// backend/test/frontend-map-search.test.js runs it headlessly. window.SearchModel in the browser.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SearchModel = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const GROUPS = Object.freeze(['recent', 'cities', 'parcels', 'proposals', 'places', 'commands']);
    const GROUP_LIMITS = Object.freeze({ recent: 8, cities: 12, parcels: 5, proposals: 8, places: 5, commands: 5 });
    const RECENT_MAX = 8;
    const PLACE_MIN_CHARS = 3;
    const PROPOSAL_MIN_CHARS = 2;
    // A geocoded place this close to the current city's centre is "here"; one this close to another
    // configured city is offered as "Open in <city>"; anything further is a world place.
    const CITY_AREA_KM = 40;
    const NEARBY_CITY_KM = 60;

    // Parcel id prefixes the cadastre transports expect, per configured city. Croatian cities share
    // one countrywide cadastre whose ids are HR-<cadastral municipality>-<number>.
    const CITY_PARCEL_PREFIX = Object.freeze({
        new_york: 'US-NY-',
        colorado: 'US-CO-',
        ljubljana: 'SI-',
        belgrade: 'SR-'
    });
    const CROATIAN_SOURCE = 'oss-wfs';
    const KNOWN_PREFIX = /^(HR|SI|SR|US-NY|US-CO)-/i;

    const normalize = value => String(value || '')
        .toLocaleLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[đð]/g, 'd')
        .replace(/\s+/g, ' ')
        .trim();

    // 0 exact, 1 prefix, 2 word start, 3 substring, null no match.
    function matchRank(haystack, needle) {
        const h = normalize(haystack);
        const n = normalize(needle);
        if (!n || !h) return null;
        if (h === n) return 0;
        if (h.startsWith(n)) return 1;
        if (h.split(/[^a-z0-9]+/).some(word => word && word.startsWith(n))) return 2;
        if (h.includes(n)) return 3;
        return null;
    }

    // Something a cadastre could call a parcel: digits with optional slash/dash parts
    // (1813/6, 335550-1813/6, 1000010010, 001-005-027A), or one of the countries' prefixes
    // (HR-335550-1813/6, US-NY-1000010010). No spaces: "Ilica 1" is an address.
    function looksLikeParcelId(query) {
        const q = String(query || '').trim();
        if (!q || /\s/.test(q)) return false;
        if (KNOWN_PREFIX.test(q)) return /\d/.test(q.replace(KNOWN_PREFIX, ''));
        return /^\d[\dA-Za-z]*([/.-][\dA-Za-z]+)*$/.test(q);
    }

    // What the query could be. A leading '>' asks for commands only (as in an editor's palette).
    function classifyQuery(query) {
        const raw = String(query || '');
        const trimmed = raw.trim();
        if (!trimmed) return { text: '', empty: true, kinds: [] };
        if (trimmed.startsWith('>')) {
            return { text: trimmed.slice(1).trim(), empty: false, commandsOnly: true, kinds: ['command'] };
        }
        const hasLetter = /\p{L}/u.test(trimmed);
        const parcel = looksLikeParcelId(trimmed);
        const kinds = [];
        // Names and addresses need a word ("Ilica 1", "Main St"); an id with a letter in it
        // (001-005-027A, HR-…) is a parcel, not a place.
        const wordy = hasLetter && !parcel;
        if (wordy) kinds.push('city');
        if (parcel) kinds.push('parcel');
        if (trimmed.length >= PROPOSAL_MIN_CHARS) kinds.push('proposal');
        if (trimmed.length >= PLACE_MIN_CHARS && wordy) kinds.push('address');
        if (hasLetter) kinds.push('command');
        return { text: trimmed, empty: false, parcelLike: parcel, kinds };
    }

    // The full parcel ids worth asking the cadastre for. Ids already loaded on the map that end in
    // the typed number come first (a bare "1813/6" in Zagreb means that number in whichever
    // cadastral municipality is on screen); then the id the city's transport would build.
    // Returns { ids, needsMunicipality } — the latter when a Croatian bare number matched nothing
    // loaded, so the UI can say which prefix to add.
    function parcelIdCandidates(query, options = {}) {
        const q = String(query || '').trim();
        if (!looksLikeParcelId(q)) return { ids: [], needsMunicipality: false };
        const loaded = Array.isArray(options.loadedIds) ? options.loadedIds : [];
        const limit = options.limit || GROUP_LIMITS.parcels;
        const upper = q.toUpperCase();
        const out = [];
        const add = id => { if (id && !out.includes(id) && out.length < limit) out.push(id); };

        const exactLoaded = loaded.find(id => String(id).toUpperCase() === upper);
        if (exactLoaded) add(String(exactLoaded));
        if (!KNOWN_PREFIX.test(q)) {
            const suffix = `-${upper}`;
            loaded.filter(id => String(id).toUpperCase().endsWith(suffix)).sort().forEach(id => add(String(id)));
        }

        const croatian = options.parcelSource === CROATIAN_SOURCE;
        let needsMunicipality = false;
        if (KNOWN_PREFIX.test(q)) {
            add(upper.replace(/^(HR|SI|SR|US-NY|US-CO)-/i, m => m.toUpperCase()));
        } else if (croatian) {
            if (/^\d{6}-\S+$/.test(q)) add(`HR-${q}`);
            else if (!out.length) needsMunicipality = true;
        } else if (CITY_PARCEL_PREFIX[options.cityId]) {
            add(`${CITY_PARCEL_PREFIX[options.cityId]}${q}`);
        } else {
            add(q);
        }
        return { ids: out, needsMunicipality };
    }

    // Configured cities matching the query, best first; the empty query lists them all with the
    // current city first. Each: { id, label, rank, current }.
    function rankCities(query, cities, currentCityId) {
        const list = Array.isArray(cities) ? cities : [];
        const text = String(query || '').trim();
        const scored = list.map(city => {
            const label = city.label || city.id;
            // The shown label, the id and any alias (the English label behind a translated one).
            const names = [label, String(city.id).replace(/_/g, ' ')].concat(Array.isArray(city.aliases) ? city.aliases : []);
            const ranks = text ? names.map(name => matchRank(String(name), text)).filter(r => r !== null) : [0];
            const best = ranks.length ? Math.min(...ranks) : null;
            return { id: city.id, label, rank: best, current: city.id === currentCityId };
        }).filter(item => item.rank !== null);
        scored.sort((a, b) => (text ? 0 : (b.current - a.current)) || (a.rank - b.rank) || a.label.localeCompare(b.label));
        return scored;
    }

    // A proposal summary's city is a configured city id ('zagreb'), sometimes a short code ('zg')
    // or a placeholder ('city', ''): resolve it to a configured id or null (unknown — no prompt).
    function resolveProposalCityId(raw, cityIds, codeMap) {
        const value = String(raw || '').trim().toLowerCase();
        if (!value) return null;
        const ids = Array.isArray(cityIds) ? cityIds : [];
        if (ids.includes(value)) return value;
        const mapped = codeMap && codeMap[value];
        return mapped && ids.includes(mapped) ? mapped : null;
    }

    // Proposals in the current city first, otherwise the server's order (it ranks the ILIKE hits).
    function rankProposals(proposals, currentCityId) {
        const list = Array.isArray(proposals) ? proposals.slice() : [];
        return list
            .map((proposal, index) => ({ proposal, index }))
            .sort((a, b) => ((b.proposal.cityId === currentCityId) - (a.proposal.cityId === currentCityId)) || (a.index - b.index))
            .map(item => item.proposal);
    }

    // Browser-local work has not necessarily been uploaded, so it cannot appear in the server
    // summary search. Match the fields a person can recognise (title, author and durable id) and
    // retain the usual exact/prefix/word/substring ordering.
    function rankLocalProposals(proposals, query) {
        const text = String(query || '').trim();
        if (!text || !Array.isArray(proposals)) return [];
        return proposals
            .map((proposal, index) => {
                const fields = [proposal && proposal.title, proposal && proposal.name,
                    proposal && proposal.proposalName, proposal && proposal.author,
                    proposal && proposal.proposalId, proposal && proposal.serverProposalId];
                const ranks = fields.map(field => matchRank(field, text)).filter(rank => rank !== null);
                return { proposal, index, rank: ranks.length ? Math.min(...ranks) : null };
            })
            .filter(entry => entry.proposal && entry.rank !== null)
            .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
            .slice(0, GROUP_LIMITS.proposals)
            .map(entry => Object.assign({}, entry.proposal, { searchRank: entry.rank, localOnly: true }));
    }

    // A published record may also live in this browser. Keep that local copy (it has the complete
    // authored geometry and opens without a download prompt) and suppress its server summary.
    function mergeProposalSearchResults(local, remote, currentCityId) {
        const localItems = Array.isArray(local) ? local : [];
        const localServerIds = new Set(localItems
            .map(proposal => String(proposal && proposal.serverProposalId || ''))
            .filter(Boolean));
        const remoteItems = (Array.isArray(remote) ? remote : [])
            .filter(proposal => !localServerIds.has(String(proposal && (proposal.id ?? proposal.proposalId) || '')));
        return localItems.concat(rankProposals(remoteItems, currentCityId));
    }

    // Photon GeoJSON → plain places. `type` is Photon's feature class (house, street, city, ...).
    function parsePhoton(payload) {
        const features = payload && Array.isArray(payload.features) ? payload.features : [];
        return features.map(feature => {
            const props = feature.properties || {};
            const coords = feature.geometry && feature.geometry.coordinates;
            if (!Array.isArray(coords) || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
            const street = props.street ? `${props.street}${props.housenumber ? ' ' + props.housenumber : ''}` : '';
            const name = props.name || street || props.city || props.country || '';
            if (!name) return null;
            const context = [props.name && street && street !== props.name ? street : '',
                props.district, props.city !== name ? props.city : '', props.country]
                .filter(Boolean).filter((part, i, arr) => arr.indexOf(part) === i);
            return {
                key: `${props.osm_type || ''}${props.osm_id || ''}` || `${coords[1]},${coords[0]}`,
                name: props.housenumber && !props.name ? street : name,
                context: context.join(', '),
                type: props.type || props.osm_value || '',
                lat: coords[1],
                lon: coords[0]
            };
        }).filter(Boolean).filter((place, index, all) =>
            // A street comes back once per OSM way; one entry per name and area is enough.
            all.findIndex(other => other.name === place.name && other.context === place.context) === index);
    }

    // How close to zoom for a place: a house or street fills the screen, a town less so.
    function placeZoom(type) {
        switch (String(type || '').toLowerCase()) {
            case 'house': case 'street': case 'building': return 18;
            case 'locality': case 'district': return 15;
            case 'city': case 'town': case 'village': return 13;
            case 'county': return 10;
            case 'state': return 8;
            case 'country': return 6;
            default: return 16;
        }
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
        return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    // Where a place is relative to the app's cities. cities: [{ id, label, center: [lat, lon],
    // parcelSource }]. Returns { kind: 'here' | 'other-city' | 'world', city?, distanceKm? }.
    // A point near another city that shares the current city's cadastre (Croatia's countrywide one)
    // is still 'here': its parcels load without switching. `options.liveCityId` is the configured
    // city the world coverage assigns to a point in a countrywide-live country (WorldCoverage
    // tierAt(...).cityId): a point far from every city centre but inside such a country belongs to
    // that city, not to the world.
    function classifyPlaceLocation(point, cities, currentCityId, options = {}) {
        const areaKm = options.areaKm || CITY_AREA_KM;
        const nearbyKm = options.nearbyKm || NEARBY_CITY_KM;
        const list = (Array.isArray(cities) ? cities : []).filter(c => Array.isArray(c.center));
        if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || !list.length) return { kind: 'world' };
        const withDistance = list.map(city => ({ city, km: haversineKm(point.lat, point.lon, city.center[0], city.center[1]) }))
            .sort((a, b) => a.km - b.km);
        const current = withDistance.find(item => item.city.id === currentCityId);
        if (current && current.km <= areaKm) return { kind: 'here', city: current.city, distanceKm: current.km };
        const nearest = withDistance[0];
        if (nearest.km <= nearbyKm) {
            const sameCadastre = current && current.city.parcelSource && current.city.parcelSource === nearest.city.parcelSource;
            if (nearest.city.id === currentCityId || sameCadastre) return { kind: 'here', city: nearest.city, distanceKm: nearest.km };
            return { kind: 'other-city', city: nearest.city, distanceKm: nearest.km };
        }
        const live = options.liveCityId ? list.find(city => city.id === options.liveCityId) : null;
        if (live) {
            const sameCadastre = current && current.city.parcelSource && current.city.parcelSource === live.parcelSource;
            return { kind: live.id === currentCityId || sameCadastre ? 'here' : 'other-city', city: live, distanceKm: nearest.km };
        }
        return { kind: 'world', distanceKm: nearest.km };
    }

    // Recent searches: newest first, one entry per query text, at most RECENT_MAX.
    function pushRecent(list, query, max = RECENT_MAX) {
        const text = String(query || '').trim();
        const prev = Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.trim()) : [];
        if (!text) return prev.slice(0, max);
        return [text, ...prev.filter(item => normalize(item) !== normalize(text))].slice(0, max);
    }

    // Order groups by their best item (rank 0 exact … 3 substring); ties keep GROUPS order. Server
    // and geocoder results carry no rank of ours and count as a word match (2), a parcel-looking
    // query puts parcels at 0. Empty groups drop out, every group is cut to its limit.
    function orderGroups(groups) {
        const order = new Map(GROUPS.map((id, i) => [id, i]));
        return (Array.isArray(groups) ? groups : [])
            .map(group => {
                const items = (group.items || []).slice(0, GROUP_LIMITS[group.id] || 8);
                const ranks = items.map(item => (Number.isFinite(item.rank) ? item.rank : 2));
                const best = ranks.length ? Math.min(...ranks) : Infinity;
                return Object.assign({}, group, { items, best });
            })
            .filter(group => group.items.length || group.status)
            .sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return (a.best - b.best) || ((order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
            });
    }

    // The items a person can move to with the arrow keys, in display order.
    function selectableItems(groups) {
        const out = [];
        (groups || []).forEach(group => (group.items || []).forEach(item => {
            if (!item.disabled) out.push(item);
        }));
        return out;
    }

    // Arrow keys wrap; from "nothing selected" (-1) Down goes to the first item and Up to the last.
    function moveSelection(index, delta, count) {
        if (!count) return -1;
        if (index < 0 || index >= count) return delta > 0 ? 0 : count - 1;
        return (index + delta + count) % count;
    }

    // The item a bare Enter (nothing highlighted) runs: the first real result, never a trailing
    // helper row (the 'hint' that opens the command palette). -1 when there is none.
    function defaultEnterIndex(items) {
        return (Array.isArray(items) ? items : []).findIndex(item => item && item.kind !== 'hint');
    }

    // What a key does in an open result list: { type: 'move', index } | { type: 'run', index }
    // | { type: 'wait' } | { type: 'close' } | null (not ours — let the input have it).
    // options (map search only): defaultIndex — what a bare Enter runs (defaultEnterIndex);
    // pending — remote results are still on their way, so a bare Enter waits for them instead of
    // running whatever happens to be listed already ("Ilica 20" + quick Enter opened the palette).
    function keyAction(key, index, count, options = {}) {
        switch (key) {
            case 'ArrowDown': return { type: 'move', index: moveSelection(index, 1, count) };
            case 'ArrowUp': return { type: 'move', index: moveSelection(index, -1, count) };
            case 'Enter': {
                if (count && index >= 0 && index < count) return { type: 'run', index };
                if (options.pending) return { type: 'wait' };
                const fallback = Number.isInteger(options.defaultIndex) ? options.defaultIndex : 0;
                return fallback >= 0 && fallback < count ? { type: 'run', index: fallback } : null;
            }
            case 'Escape': return { type: 'close' };
            default: return null;
        }
    }

    return {
        GROUPS,
        GROUP_LIMITS,
        RECENT_MAX,
        PLACE_MIN_CHARS,
        PROPOSAL_MIN_CHARS,
        CITY_AREA_KM,
        NEARBY_CITY_KM,
        normalize,
        matchRank,
        looksLikeParcelId,
        classifyQuery,
        parcelIdCandidates,
        rankCities,
        resolveProposalCityId,
        rankProposals,
        rankLocalProposals,
        mergeProposalSearchResults,
        parsePhoton,
        placeZoom,
        haversineKm,
        classifyPlaceLocation,
        pushRecent,
        orderGroups,
        selectableItems,
        moveSelection,
        defaultEnterIndex,
        keyAction
    };
});
