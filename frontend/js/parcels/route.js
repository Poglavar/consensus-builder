// Deep-link routing for individual parcels: /parcel/<parcelId> (or ?parcel=<parcelId>).
// Parses the URL, switches to the parcel's city if needed, then fetches, selects and
// centres that parcel. This is the resolution target for ENS parcel names
// (<slug>.parcels.urbangametheory.eth → url record → /parcel/<parcelId>).
(function (global) {
    'use strict';

    // The parcel source shared by every Croatian city: one countrywide DGU dataset behind one
    // backend route, so an `HR-` id says which COUNTRY a parcel is in but not which city.
    const CROATIAN_PARCEL_SOURCE = 'oss-wfs';
    // Where an HR parcel goes when we cannot place it (offline, unknown id). Matches the behaviour
    // from before Croatia had more than one city, so nothing regresses when the lookup fails.
    const CROATIAN_FALLBACK_CITY = 'zagreb';
    // Deadline for that lookup. It sits on the deep-link boot path, so a slow or wedged backend must
    // degrade to the fallback city rather than leave the page waiting on a parcel forever. Read at
    // call time so the unit test can shorten it — the real timeout would otherwise add 6 idle
    // seconds to every suite run just to watch a timer expire.
    const CITY_LOOKUP_TIMEOUT_MS = 6000;
    function cityLookupTimeoutMs() {
        const override = Number(global.__CB_CITY_LOOKUP_TIMEOUT_MS__);
        return Number.isFinite(override) && override > 0 ? override : CITY_LOOKUP_TIMEOUT_MS;
    }

    // Map a parcelId to its city id using the per-city id prefix conventions
    // (mirrors the formats produced by the backend parcel routes / mint scripts).
    // Returns null when the city can't be derived; the caller then tries the
    // current city as-is.
    //
    // `HR-` is deliberately NOT resolved here — see resolveCityIdForParcel. Every other prefix is
    // one country with one city configured, so the prefix alone is the answer.
    function parcelIdToCityId(rawId) {
        const id = (rawId || '').toString().trim().toUpperCase();
        if (!id) return null;
        if (id.startsWith('HR-')) return null;
        if (id.startsWith('US-NY-')) return 'new_york';
        if (id.startsWith('US-CO-')) return 'colorado';
        if (id.startsWith('SI-')) return 'ljubljana';
        if (id.startsWith('SR-')) return 'belgrade';
        // Buenos Aires uses a bare SMP (e.g. 001-005-027A) with no country prefix.
        if (/^[0-9]{3}-[0-9]{3}[A-Z]?-[0-9]{3}[A-Z]?$/.test(id)) return 'buenos_aires';
        return null;
    }

    function isCroatianParcelId(rawId) {
        return (rawId || '').toString().trim().toUpperCase().startsWith('HR-');
    }

    // First coordinate of a GeoJSON feature, at any nesting depth (Polygon / MultiPolygon).
    // Only used to place the parcel against city centres hundreds of km apart, so a corner is as
    // good as a centroid and costs no geometry library.
    function firstLatLngOfFeature(feature) {
        const coords = feature?.geometry?.coordinates;
        let node = coords;
        while (Array.isArray(node) && Array.isArray(node[0])) node = node[0];
        if (!Array.isArray(node) || node.length < 2) return null;
        const [lng, lat] = node;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return [lat, lng];
    }

    // Which Croatian city owns this parcel? The id carries its cadastral municipality
    // (HR-<maticni_broj_ko>-<broj_cestice>) but no city, and a hardcoded KO→city table would be ~90
    // numbers that go stale the moment a KO is added or a city's extent changes. So ask the data:
    // the /parcels route serves the WHOLE country regardless of which city the app is currently in,
    // so one lookup gives real coordinates, and the nearest city among those reading the Croatian
    // cadastre is the answer. A fourth Croatian city then needs no change here at all.
    async function resolveCroatianCityId(parcelId) {
        const manager = global.CityConfigManager;
        const backendBase = typeof global.getBackendBase === 'function' ? global.getBackendBase() : null;
        if (!manager || typeof manager.findNearestCity !== 'function' || !backendBase) {
            return CROATIAN_FALLBACK_CITY;
        }

        const candidates = typeof manager.getCitiesByParcelSource === 'function'
            ? manager.getCitiesByParcelSource(CROATIAN_PARCEL_SOURCE)
            : [];
        // One Croatian city configured (or none) — no ambiguity to resolve, so skip the request.
        if (candidates.length <= 1) {
            return candidates[0]?.id || CROATIAN_FALLBACK_CITY;
        }

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const deadline = controller ? setTimeout(() => controller.abort(), cityLookupTimeoutMs()) : null;
        try {
            const url = `${backendBase.replace(/\/+$/, '')}/parcels?parcel_id=${encodeURIComponent(parcelId)}`;
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                ...(controller ? { signal: controller.signal } : {})
            });
            if (!response.ok) throw new Error(`parcels lookup ${response.status}`);
            const data = await response.json();
            const latLng = firstLatLngOfFeature((data && data.features || [])[0]);
            if (!latLng) throw new Error('parcel has no usable geometry');

            const candidateIds = new Set(candidates.map(c => c.id));
            const nearest = manager.findNearestCity(latLng[0], latLng[1], {
                filter: config => candidateIds.has(config.id)
            });
            return nearest?.id || CROATIAN_FALLBACK_CITY;
        } catch (error) {
            console.warn('[handleParcelRouteFromUrl] could not place Croatian parcel', parcelId,
                '- falling back to', CROATIAN_FALLBACK_CITY, error && error.message);
            return CROATIAN_FALLBACK_CITY;
        } finally {
            if (deadline) clearTimeout(deadline);
        }
    }

    // The city a deep-linked parcel belongs to: prefix alone where that is unambiguous, a data
    // lookup for Croatia. Returns null when nothing can be derived (caller keeps the current city).
    async function resolveCityIdForParcel(parcelId) {
        if (isCroatianParcelId(parcelId)) return resolveCroatianCityId(parcelId);
        return parcelIdToCityId(parcelId);
    }

    // Pull the parcel id from the path (/parcel/<id>) or, as a host-agnostic
    // fallback, from a ?parcel=<id> query param. The captured segment keeps any
    // internal slashes — Zagreb ids look like HR-335258-4341/2 — so we grab the
    // whole remainder after /parcel/ and only trim a trailing slash.
    function parseParcelIdFromUrl() {
        try {
            const pathname = global.location.pathname || '';
            const match = pathname.match(/^\/parcel\/(.+)$/);
            if (match && match[1]) {
                const raw = match[1].endsWith('/') ? match[1].slice(0, -1) : match[1];
                return decodeURIComponent(raw).trim();
            }
            const params = new URLSearchParams(global.location.search || '');
            const queryId = params.get('parcel');
            return queryId ? queryId.trim() : null;
        } catch (_) {
            return null;
        }
    }

    async function handleParcelRouteFromUrl(attempt = 0) {
        const parcelId = parseParcelIdFromUrl();
        if (!parcelId) return;

        const cityManager = global.CityConfigManager;
        if (!cityManager || typeof cityManager.getCurrentCityId !== 'function') {
            if (attempt < 20) setTimeout(() => handleParcelRouteFromUrl(attempt + 1), 200);
            return;
        }

        const targetCityId = await resolveCityIdForParcel(parcelId);
        const currentCityId = cityManager.getCurrentCityId();

        // Wrong city → switch. navigateToCity only sets ?city= and reloads, so the
        // /parcel/<id> path is preserved and this handler runs again on reload with
        // the city now matching (no confirmation/data-wipe, unlike switchCity).
        if (targetCityId && targetCityId !== currentCityId) {
            console.log('[handleParcelRouteFromUrl] switching city for parcel', parcelId, '->', targetCityId);
            if (typeof cityManager.navigateToCity === 'function') {
                cityManager.navigateToCity(targetCityId);
            } else {
                const url = new URL(global.location.href);
                url.searchParams.set('city', targetCityId);
                global.location.href = url.toString();
            }
            return;
        }

        // Right city (or unknown prefix → try in the current city). Wait for the
        // parcel machinery, then fetch the parcel by id and select/centre it —
        // same path the sidebar "locate parcel" feature uses.
        const selectParcel = (global.Parcels && global.Parcels.selection && global.Parcels.selection.selectParcel) || global.selectParcel;
        const ground = global.CadastralGroundService || (global.Parcels && global.Parcels.ground);
        if (!global.parcelLayer || !ground || typeof ground.ensureIds !== 'function' || typeof selectParcel !== 'function') {
            if (attempt < 40) setTimeout(() => handleParcelRouteFromUrl(attempt + 1), 250);
            return;
        }

        try {
            console.log('[handleParcelRouteFromUrl] opening parcel', parcelId);
            await ground.ensureIds([parcelId]);
            const layer = typeof global.resolveParcelLayerById === 'function'
                ? global.resolveParcelLayerById(parcelId)
                : null;
            const resolvedId = (layer && layer.feature && typeof global.getParcelId === 'function')
                ? (global.getParcelId(layer.feature) || parcelId)
                : parcelId;
            if (!layer) throw new Error('Parcel not found');
            // selectParcel centres + zooms (and now bumps zoom up for very large
            // parcels so the grid stays visible — see selection.js).
            selectParcel(resolvedId);
        } catch (error) {
            console.error('[handleParcelRouteFromUrl] failed to open parcel', parcelId, error && error.message);
        }
    }

    global.parcelIdToCityId = parcelIdToCityId;
    global.resolveCityIdForParcel = resolveCityIdForParcel;
    global.handleParcelRouteFromUrl = handleParcelRouteFromUrl;

    // Node-testable exports for the pure pieces (the classic script still installs the globals above
    // when loaded in a browser, where `module` is undefined).
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { parcelIdToCityId, isCroatianParcelId, firstLatLngOfFeature, resolveCroatianCityId };
    }

    // Guarded so a node `require` of this file (for the unit tests) doesn't blow up on a global with
    // no addEventListener — the browser path is unchanged.
    if (typeof global.addEventListener === 'function') {
        global.addEventListener('load', () => {
            setTimeout(() => handleParcelRouteFromUrl(), 150);
        });
    }
})(typeof window !== 'undefined' ? window : globalThis);
