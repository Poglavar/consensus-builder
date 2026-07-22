// Address search: type a place, geocode it via OpenStreetMap Nominatim, fly the map there. The URL
// building and response parsing are pure (unit-tested headlessly); the browser init below wires the
// input to fetch + Leaflet and is the only part that touches the DOM/map/network.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AddressSearch = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

    // Build the Nominatim query URL. Returns '' for a blank query so callers can skip the fetch.
    function buildNominatimUrl(query, options = {}) {
        const q = String(query == null ? '' : query).trim();
        if (!q) return '';
        const endpoint = options.endpoint || NOMINATIM_ENDPOINT;
        const params = new URLSearchParams({
            format: 'jsonv2',
            q,
            limit: String(Number.isFinite(options.limit) ? options.limit : 5),
            addressdetails: '0'
        });
        if (options.countrycodes) params.set('countrycodes', String(options.countrycodes));
        return `${endpoint}?${params.toString()}`;
    }

    // Normalise Nominatim's response (array, or a JSON string of one) into plain result objects.
    // Nominatim gives lat/lon as strings and boundingbox as [south, north, west, east] strings.
    function parseGeocodeResults(payload) {
        let list = payload;
        if (typeof payload === 'string') {
            try { list = JSON.parse(payload); } catch (_) { return []; }
        }
        if (!Array.isArray(list)) return [];
        return list.map(function (entry) {
            if (!entry) return null;
            const lat = Number(entry.lat);
            const lng = Number(entry.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            let boundingBox = null;
            const bb = entry.boundingbox;
            if (Array.isArray(bb) && bb.length === 4) {
                const nums = bb.map(Number);
                if (nums.every(Number.isFinite)) {
                    // → [[south, west], [north, east]] for Leaflet fitBounds.
                    boundingBox = [[nums[0], nums[2]], [nums[1], nums[3]]];
                }
            }
            return { lat, lng, displayName: entry.display_name || '', boundingBox };
        }).filter(Boolean);
    }

    function pickBestResult(rawResults) {
        const parsed = parseGeocodeResults(rawResults);
        return parsed.length ? parsed[0] : null;
    }

    // ---- Browser wiring (no-op under node) ----

    function initAddressSearch(opts = {}) {
        const doc = (typeof document !== 'undefined') ? document : null;
        if (!doc) return;
        const form = doc.getElementById('address-search');
        const input = doc.getElementById('address-search-input');
        const status = doc.getElementById('address-search-status');
        if (!form || !input) return;

        // The bar sits over the map — keep clicks, drags and wheel from reaching Leaflet.
        if (typeof window !== 'undefined' && window.L && window.L.DomEvent) {
            window.L.DomEvent.disableClickPropagation(form);
            window.L.DomEvent.disableScrollPropagation(form);
        }

        const tr = (key, fallback) => (typeof window !== 'undefined' && window.i18n && typeof window.i18n.t === 'function')
            ? (window.i18n.t(key) !== key ? window.i18n.t(key) : fallback)
            : fallback;

        const setStatus = (text, isError) => {
            if (!status) return;
            status.textContent = text || '';
            status.hidden = !text;
            status.classList.toggle('is-error', !!isError);
        };

        let inFlight = false;

        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            if (inFlight) return;
            const url = buildNominatimUrl(input.value, { limit: 5 });
            if (!url) return;

            const map = (typeof window !== 'undefined') ? window.map : null;
            if (!map) return;

            inFlight = true;
            setStatus(tr('addressSearch.searching', 'Searching…'), false);
            try {
                const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!response.ok) throw new Error(`Geocoder returned ${response.status}`);
                const best = pickBestResult(await response.json());
                if (!best) {
                    setStatus(tr('addressSearch.notFound', 'No match found.'), true);
                    return;
                }
                if (best.boundingBox) {
                    map.fitBounds(best.boundingBox, { maxZoom: 17 });
                } else {
                    map.flyTo([best.lat, best.lng], 17);
                }
                setStatus('', false);
                input.blur();
            } catch (error) {
                console.error('[address-search] geocode failed', error);
                setStatus(tr('addressSearch.error', 'Search failed, try again.'), true);
            } finally {
                inFlight = false;
            }
        });
    }

    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => initAddressSearch());
        } else {
            initAddressSearch();
        }
    }

    return { buildNominatimUrl, parseGeocodeResults, pickBestResult, initAddressSearch };
});
