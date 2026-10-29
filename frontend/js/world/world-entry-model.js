// Decisions for entering the app through the world view (globe), kept pure so node tests cover them:
// whether a boot opens the globe, the `?at=lat,lon,zoom` view parameter, where a globe pick lands
// (same city in place, another city by reload, or the explore city). Metres never depend on the city
// (projections.md §2). No DOM, no storage; UMD so it is window.WorldEntryModel in the browser and require()-able
// in node. js/ui/world-entry.js is the browser layer that wires these to the globe and the map.
//
// API
//   parseAt(value) -> { lat, lon, zoom|null } | null      validates; zoom clamped to [MIN_ZOOM, MAX_ZOOM]
//   formatAt({ lat, lon, zoom }) -> 'lat,lon,zoom'        5 decimals, integer zoom
//   addressWithView(href, view, { dropCity }) -> href | null  the address carrying the view as ?at=
//                                                          (and without ?city= when dropCity); null
//                                                          when it already is that
//   isSharedRoute({ pathname, search }) -> boolean         a link that names what to show (no globe)
//   bootDecision({ cityChosen, sharedRoute, search }) -> { open, closable, firstVisit, forced }
//   canReturnToMap(zoom) -> boolean      true when the current map is a useful return destination
//   resolveLanding({ cityId, point, currentCityId, cityView, focus, explore }) -> landing (see below)
//   liveCityFor({ place, currentCityId, sameCadastre }) -> the city a live place opens
//   arrivesAtLatest(landing) -> boolean   a landing goes on to the city's latest proposal
//   resolveEntry({ pathname, search, storedCityId, resolveCityParam, jurisdictionAt }) -> entry (see below)
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldEntryModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EXPLORE_CITY_ID = 'explore';
    const MIN_ZOOM = 3;
    const MAX_ZOOM = 23;
    // Precise search results must land close enough for parcels to load; globe points use zoom 19.
    const PARCEL_ZOOM = 17;
    const EXPLORE_ZOOM = 19;
    // Web Mercator stops at ±85.0511°; Leaflet clamps beyond it, so such a value is not a real view.
    const MAX_LAT = 85.0511;

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value);
    }

    // `?at=45.80450,15.97879,17` -> { lat, lon, zoom }. Two parts are fine (zoom null = the city's
    // own default); anything unparseable or off the map is null, so a bad link boots normally.
    function parseAt(value) {
        if (typeof value !== 'string') return null;
        const parts = value.split(',').map(part => part.trim());
        if (parts.length < 2 || parts.length > 3 || parts.some(part => part === '')) return null;
        const numbers = parts.map(Number);
        if (!numbers.every(Number.isFinite)) return null;
        const [lat, lon, rawZoom] = numbers;
        if (Math.abs(lat) > MAX_LAT || Math.abs(lon) > 180) return null;
        const zoom = parts.length === 3 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(rawZoom))) : null;
        return { lat, lon, zoom };
    }

    function formatAt(view) {
        if (!view || !finite(view.lat) || !finite(view.lon)) throw new Error('formatAt: lat/lon must be finite numbers');
        const head = `${view.lat.toFixed(5)},${view.lon.toFixed(5)}`;
        return finite(view.zoom) ? `${head},${Math.round(view.zoom)}` : head;
    }

    // The address bar follows the map (js/map-core.js, on every move): the current address with the
    // view as ?at=, everything else kept — so a reload, a copied link or a second tab opens where the
    // map is, not the city's default (or the explore spot another tab saved). null = already there.
    function addressWithView(href, view, options) {
        const url = new URL(href);
        const at = formatAt(view);
        const dropCity = !!(options && options.dropCity) && url.searchParams.has('city');
        if (url.searchParams.get('at') === at && !dropCity) return null;
        url.searchParams.set('at', at);
        if (dropCity) url.searchParams.delete('city');
        // commas are valid in a query: keep the view readable in an address people copy
        return url.toString().replace(/([?&]at=)([^&#]*)/, (match, key, value) => key + value.replace(/%2C/gi, ','));
    }

    // Every link form that already says what to show. Mirrors the app's own route handlers:
    // /proposals, /proposals/<chain>/…, /designs/<cids> and /agreements/<cid>
    // (handleProposalRouteFromUrl, isProposalDeepLinkPath), /parcel/<id> and
    // ?parcel= (parcels/route.js), /monitors/<id> (area-monitor/routing.js), the selection ?design=,
    // ?plan= and ?agreement= (selection-address.js, world/proposal-entry.js), ?activity= (game.js), ?scene= (ai-scene-follow.js),
    // /bets/<account> and ?bets= (bets/bets-link.js) and the view-mode params (?model/?mode3d/?3d,
    // ?photo/?real/?rl/?rw: is3DModeRequestedFromUrl), or a valid shared map view (?at=).
    const SHARED_PATHS = [/^\/proposals\/?$/i, /^\/proposals\/[a-z0-9-]+\/[^/]+\/[^/]+\/./i, /^\/designs\/./i, /^\/agreements\/./i,
        /^\/plans\/[^/]+\/?$/i, /^\/parcel\/./i, /^\/bets\/./i, /\/monitors\/\d+\/?$/];
    const SHARED_PARAMS = ['parcel', 'design', 'plan', 'agreement', 'activity', 'scene', 'bets', 'model', 'mode3d', '3d', 'photo', 'real', 'rl', 'rw'];
    // The shared routes that open a stored record, which keeps the city it was made in. A selection
    // (selection-address.js) is one only without ?at=: with it, it was made where the view is.
    const RECORD_PARAMS = ['activity', 'scene', 'bets'];
    const SELECTION_PARAMS = ['parcel', 'design', 'plan', 'agreement'];

    // A user zooming out through the map scale opens the globe at the last map centre. Keep the
    // decision pure; the UI separately proves a native zoom gesture happened.
    function shouldReturnToGlobe(input) {
        const fromZoom = input && input.fromZoom;
        const toZoom = input && input.toZoom;
        return finite(fromZoom) && finite(toZoom)
            && fromZoom > toZoom && toZoom <= 4
            && !!input.userInitiated && !input.blocked;
    }

    function isSharedRoute(loc) {
        const pathname = (loc && loc.pathname) || '';
        if (SHARED_PATHS.some(pattern => pattern.test(pathname))) return true;
        let params;
        try { params = new URLSearchParams((loc && loc.search) || ''); } catch (_) { return false; }
        return SHARED_PARAMS.some(name => params.has(name)) || parseAt(params.get('at')) !== null;
    }

    // First visit = no stored city, no ?city=, no shared route. ?world=1 forces the globe for anyone;
    // Boot globes never have a meaningful view to return to, even when ?world=1 was forced.
    function bootDecision(input) {
        const cityChosen = !!(input && input.cityChosen);
        const sharedRoute = !!(input && input.sharedRoute);
        let forced = false;
        try { forced = new URLSearchParams((input && input.search) || '').get('world') === '1'; } catch (_) { forced = false; }
        const firstVisit = !cityChosen && !sharedRoute;
        return { open: forced || firstVisit, closable: false, firstVisit, forced };
    }

    function canReturnToMap(zoom) {
        return finite(zoom) && zoom > 4;
    }

    function samePoint(a, b) {
        return !!(a && b && finite(a.lat) && finite(a.lon) && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6);
    }

    // Where a globe pick lands.
    //   cityId         the live city the popup offered (ignored when explore is true)
    //   point          { lat, lon, place } from the globe
    //   currentCityId  the city booted now
    //   cityView       { center: [lat, lon], zoom } of the target city (its configured default)
    //   focus          the place the globe was opened on ({ lat, lon, zoom? }), if any: a geocoded
    //                  spot with a zoom is precise, so the map opens exactly there
    //   explore        true for "Explore anyway"
    // -> { cityId, inPlace, view: { lat, lon, zoom }, carryAt }
    //   inPlace: the target is the city already loaded -> close the globe and move the map, no reload.
    //   carryAt: the view must ride along as ?at= (a specific spot); false = the city's own default.
    function resolveLanding(input) {
        const point = input && input.point;
        if (!point || !finite(point.lat) || !finite(point.lon)) throw new Error('resolveLanding: point needs finite lat/lon');
        const place = point.place || {};
        const focus = input.focus;
        const precise = samePoint(focus, point) && finite(focus.zoom);
        const targetCityId = input.explore ? EXPLORE_CITY_ID : input.cityId;
        if (!targetCityId) throw new Error('resolveLanding: no city to land in');
        const inPlace = targetCityId === input.currentCityId;
        if (input.explore) {
            const zoom = precise ? Math.min(MAX_ZOOM, Math.max(PARCEL_ZOOM, focus.zoom)) : EXPLORE_ZOOM;
            return { cityId: targetCityId, inPlace, view: { lat: point.lat, lon: point.lon, zoom }, carryAt: true };
        }
        // A background click or precise search result opens the exact spot. Only an explicit city
        // marker/search selection uses the city's default view and latest proposal.
        if (precise || place.kind === 'point') {
            const zoom = precise ? Math.min(MAX_ZOOM, Math.max(PARCEL_ZOOM, focus.zoom)) : EXPLORE_ZOOM;
            return { cityId: targetCityId, inPlace, view: { lat: point.lat, lon: point.lon, zoom }, carryAt: true };
        }
        const cityView = input.cityView || {};
        const center = Array.isArray(cityView.center) && cityView.center.length === 2 ? cityView.center : [point.lat, point.lon];
        const zoom = finite(cityView.zoom) ? cityView.zoom : PARCEL_ZOOM;
        return { cityId: targetCityId, inPlace, view: { lat: center[0], lon: center[1], zoom }, carryAt: false };
    }

    // Which configured city a live place opens (the globe popup's "Open <city>"). A place reached
    // through a countrywide cadastre (kind 'point': anywhere in Croatia) stays in the loaded city
    // when that city reads the same cadastre — the parcels are there already, like the search box's
    // "here". A click on a city itself always opens that city.
    function liveCityFor(input) {
        const place = (input && input.place) || {};
        if (place.kind === 'point' && input.sameCadastre && input.currentCityId) return input.currentCityId;
        return place.cityId || null;
    }

    // Whether a landing goes on to its city's latest proposal (js/world/arrival.js) instead of its
    // own view: only for a pick of a city as a whole. A particular spot (a searched address, a place
    // in a countrywide cadastre — carryAt) is where the visitor asked to go, and explore has no
    // proposals of its own to arrive at.
    function arrivesAtLatest(landing) {
        return !!landing && landing.cityId !== EXPLORE_CITY_ID && !landing.carryAt;
    }

    // Which city a boot opens in, from the address (location-first.md "URL rules"). First match wins:
    //   record   a link to a stored record (a proposal, plan, parcel, bet, scene, monitor) keeps its
    //            ?city=, else the stored city; the record frames itself (view null).
    //   at       ?at= decides: the city whose parcels apply there (jurisdictionAt), else explore. A
    //            ?city= beside it is ignored (ignoredCity names it when it disagrees).
    //   city     only ?city= (an id or short code): that city at its own default view.
    //   stored   neither: the stored city.
    //   default  nothing at all: cityId null, the caller's default.
    // Explore is never asked for: it is where no city's parcels reach, so a legacy ?city=explore beside
    // ?at= is just the point, and alone it opens explore at its last view.
    //   resolveCityParam(raw) -> configured city id | null (unknown values are null)
    //   jurisdictionAt(lat, lon) -> city id | null   (WorldCoverage.jurisdictionAt)
    // -> { cityId, view: { lat, lon, zoom|null } | null, source, cityParam, ignoredCity, dropCityParam }
    //   dropCityParam: the address should lose ?city= (it carries ?at= from the first move on).
    function resolveEntry(input) {
        const pathname = (input && input.pathname) || '';
        let params;
        try { params = new URLSearchParams((input && input.search) || ''); } catch (_) { params = new URLSearchParams(); }
        const rawCity = params.get('city');
        const cityParam = rawCity && typeof input.resolveCityParam === 'function' ? input.resolveCityParam(rawCity) : null;
        const storedCityId = (input && input.storedCityId) || null;
        const entry = (cityId, view, source, extra) => Object.assign(
            { cityId, view, source, cityParam, ignoredCity: null, dropCityParam: false }, extra || {});

        const record = SHARED_PATHS.some(pattern => pattern.test(pathname)) || RECORD_PARAMS.some(name => params.has(name))
            || (SELECTION_PARAMS.some(name => params.has(name)) && !params.has('at'));
        if (record) return entry(cityParam || storedCityId, null, 'record');

        // Without a coverage to ask, ?at= cannot choose (guessing explore would hide every city).
        const at = typeof input.jurisdictionAt === 'function' ? parseAt(params.get('at')) : null;
        if (at) {
            const cityId = input.jurisdictionAt(at.lat, at.lon) || EXPLORE_CITY_ID;
            const ignoredCity = rawCity && cityParam !== cityId && cityParam !== EXPLORE_CITY_ID ? rawCity : null;
            return entry(cityId, at, 'at', { ignoredCity, dropCityParam: rawCity !== null });
        }
        if (cityParam) return entry(cityParam, null, 'city', { dropCityParam: true });
        if (storedCityId) return entry(storedCityId, null, 'stored');
        return entry(null, null, 'default');
    }

    return {
        EXPLORE_CITY_ID, MIN_ZOOM, MAX_ZOOM, PARCEL_ZOOM, EXPLORE_ZOOM,
        parseAt, formatAt, addressWithView, isSharedRoute, bootDecision, canReturnToMap, resolveLanding, liveCityFor, arrivesAtLatest,
        shouldReturnToGlobe, resolveEntry
    };
});
