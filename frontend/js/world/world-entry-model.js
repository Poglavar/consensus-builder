// Decisions for entering the app through the world view (globe), kept pure so node tests cover them:
// whether a boot opens the globe, the `?at=lat,lon,zoom` view parameter, where a globe pick lands
// (same city in place, another city by reload, or the explore city) and the explore city's metric
// projection. No DOM, no storage; UMD so it is window.WorldEntryModel in the browser and require()-able
// in node. js/ui/world-entry.js is the browser layer that wires these to the globe and the map.
//
// API
//   parseAt(value) -> { lat, lon, zoom|null } | null      validates; zoom clamped to [MIN_ZOOM, MAX_ZOOM]
//   formatAt({ lat, lon, zoom }) -> 'lat,lon,zoom'        5 decimals, integer zoom
//   isSharedRoute({ pathname, search }) -> boolean         a link that names what to show (no globe)
//   bootDecision({ cityChosen, sharedRoute, search }) -> { open, closable, firstVisit, forced }
//   resolveLanding({ cityId, point, currentCityId, cityView, focus, explore }) -> landing (see below)
//   liveCityFor({ place, currentCityId, sameCadastre }) -> the city a live place opens
//   exploreZoomFor(place) -> zoom for an explore landing
//   utmProjectionFor(lat, lon) -> { crs, definition }      the metric CRS for a place anywhere
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldEntryModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const EXPLORE_CITY_ID = 'explore';
    const MIN_ZOOM = 3;
    const MAX_ZOOM = 19;
    // Croatian parcels draw from zoom 17 (every city's parcelZoomRange.min): a countrywide-live
    // point (Osijek, inland Croatia) lands there so the parcels around it load at once.
    const PARCEL_ZOOM = 17;
    const EXPLORE_ZOOM = { precise: 15, city: 12, area: 10 };
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

    // Every link form that already says what to show. Mirrors the app's own route handlers:
    // proposals/plans (handleProposalRouteFromUrl, isProposalDeepLinkPath), /parcel/<id> and
    // ?parcel= (parcels/route.js), /monitors/<id> (area-monitor/routing.js), ?proposalShare= and
    // ?shared= (proposals/sharing-routes.js), ?activity= (game.js), ?scene= (ai-scene-follow.js)
    // and the view-mode params (?model/?mode3d/?3d, ?photo/?real/?rl/?rw: is3DModeRequestedFromUrl).
    const SHARED_PATHS = [/^\/proposals\/./i, /^\/plans\/./i, /^\/parcel\/./i, /\/monitors\/\d+\/?$/];
    const SHARED_PARAMS = ['parcel', 'proposalShare', 'shared', 'activity', 'scene', 'model', 'mode3d', '3d', 'photo', 'real', 'rl', 'rw'];

    function isSharedRoute(loc) {
        const pathname = (loc && loc.pathname) || '';
        if (SHARED_PATHS.some(pattern => pattern.test(pathname))) return true;
        let params;
        try { params = new URLSearchParams((loc && loc.search) || ''); } catch (_) { return false; }
        return SHARED_PARAMS.some(name => params.has(name));
    }

    // First visit = no stored city, no ?city=, no shared route. ?world=1 forces the globe for anyone;
    // it is closable whenever a city was already chosen (there is somewhere to go back to).
    function bootDecision(input) {
        const cityChosen = !!(input && input.cityChosen);
        const sharedRoute = !!(input && input.sharedRoute);
        let forced = false;
        try { forced = new URLSearchParams((input && input.search) || '').get('world') === '1'; } catch (_) { forced = false; }
        const firstVisit = !cityChosen && !sharedRoute;
        return { open: forced || firstVisit, closable: !firstVisit, firstVisit, forced };
    }

    function exploreZoomFor(place) {
        const kind = place && place.kind;
        return kind === 'city' || kind === 'live-city' ? EXPLORE_ZOOM.city : EXPLORE_ZOOM.area;
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
            const zoom = precise ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, focus.zoom)) : exploreZoomFor(place);
            return { cityId: targetCityId, inPlace, view: { lat: point.lat, lon: point.lon, zoom }, carryAt: true };
        }
        // A live city reached through its whole country (Croatian parcels are countrywide), or a
        // precise search result: open at that spot. A click on the city itself: the city's default
        // view — a globe click is kilometres coarse, so its exact point means nothing at street zoom.
        if (precise || place.kind === 'country') {
            const zoom = precise ? Math.min(MAX_ZOOM, Math.max(PARCEL_ZOOM, focus.zoom)) : PARCEL_ZOOM;
            return { cityId: targetCityId, inPlace, view: { lat: point.lat, lon: point.lon, zoom }, carryAt: true };
        }
        const cityView = input.cityView || {};
        const center = Array.isArray(cityView.center) && cityView.center.length === 2 ? cityView.center : [point.lat, point.lon];
        const zoom = finite(cityView.zoom) ? cityView.zoom : PARCEL_ZOOM;
        return { cityId: targetCityId, inPlace, view: { lat: center[0], lon: center[1], zoom }, carryAt: false };
    }

    // Which configured city a live place opens (the globe popup's "Open <city>"). A place reached
    // through a countrywide cadastre (kind 'country': anywhere in Croatia) stays in the loaded city
    // when that city reads the same cadastre — the parcels are there already, like the search box's
    // "here". A click on a city itself always opens that city.
    function liveCityFor(input) {
        const place = (input && input.place) || {};
        if (place.kind === 'country' && input.sameCadastre && input.currentCityId) return input.currentCityId;
        return place.cityId || null;
    }

    // WGS84 UTM zone of a point: the explore city's metric CRS (measurement, buffers), valid anywhere.
    function utmProjectionFor(lat, lon) {
        if (!finite(lat) || !finite(lon)) throw new Error('utmProjectionFor: lat/lon must be finite numbers');
        const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
        const south = lat < 0;
        return {
            crs: `EPSG:${south ? 327 : 326}${String(zone).padStart(2, '0')}`,
            definition: `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs +type=crs`
        };
    }

    return {
        EXPLORE_CITY_ID, MIN_ZOOM, MAX_ZOOM, PARCEL_ZOOM, EXPLORE_ZOOM,
        parseAt, formatAt, isSharedRoute, bootDecision, resolveLanding, liveCityFor, exploreZoomFor, utmProjectionFor
    };
});
