// Deep-link routing for individual parcels: /parcel/<parcelId> (or ?parcel=<parcelId>).
// Parses the URL, switches to the parcel's city if needed, then fetches, selects and
// centres that parcel. This is the resolution target for ENS parcel names
// (<slug>.parcels.urbangametheory.eth → url record → /parcel/<parcelId>).
(function (global) {
    'use strict';

    // Map a parcelId to its city id using the per-city id prefix conventions
    // (mirrors the formats produced by the backend parcel routes / mint scripts).
    // Returns null when the city can't be derived; the caller then tries the
    // current city as-is.
    function parcelIdToCityId(rawId) {
        const id = (rawId || '').toString().trim().toUpperCase();
        if (!id) return null;
        if (id.startsWith('HR-')) return 'zagreb';
        if (id.startsWith('US-NY-')) return 'new_york';
        if (id.startsWith('US-CO-')) return 'colorado';
        if (id.startsWith('SI-')) return 'ljubljana';
        if (id.startsWith('SR-')) return 'belgrade';
        // Buenos Aires uses a bare SMP (e.g. 001-005-027A) with no country prefix.
        if (/^[0-9]{3}-[0-9]{3}[A-Z]?-[0-9]{3}[A-Z]?$/.test(id)) return 'buenos_aires';
        return null;
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

        const targetCityId = parcelIdToCityId(parcelId);
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
        const fetchSingle = (global.Parcels && global.Parcels.fetch && global.Parcels.fetch.fetchSingleParcelById) || global.fetchSingleParcelById;
        if (!global.parcelLayer || typeof fetchSingle !== 'function' || typeof selectParcel !== 'function') {
            if (attempt < 40) setTimeout(() => handleParcelRouteFromUrl(attempt + 1), 250);
            return;
        }

        try {
            console.log('[handleParcelRouteFromUrl] opening parcel', parcelId);
            const layer = await fetchSingle(parcelId);
            const resolvedId = (layer && layer.feature && typeof global.getParcelId === 'function')
                ? (global.getParcelId(layer.feature) || parcelId)
                : parcelId;
            // selectParcel centres + zooms (and now bumps zoom up for very large
            // parcels so the grid stays visible — see selection.js).
            selectParcel(resolvedId);
        } catch (error) {
            console.error('[handleParcelRouteFromUrl] failed to open parcel', parcelId, error && error.message);
        }
    }

    global.parcelIdToCityId = parcelIdToCityId;
    global.handleParcelRouteFromUrl = handleParcelRouteFromUrl;

    global.addEventListener('load', () => {
        setTimeout(() => handleParcelRouteFromUrl(), 150);
    });
})(typeof window !== 'undefined' ? window : globalThis);
