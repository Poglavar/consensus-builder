// The default frontage of a drawn site (window.StreetFrontage): fetch the street centrelines around
// the site (GET /streets/near: osm_road in Croatia, Overpass elsewhere) and let the pure scorer in
// proposals/site-plots.js pick the edge that faces one, else the longest edge. Used by the site
// tool's detached/row plots. basisText() says which basis was used, so the panel never presents the
// longest edge as a street. PARCEL-OPTIONAL.md phase 7a.
(function (win) {
    'use strict';

    // Answers per site bbox; a site edited back to the same shape asks nothing new.
    const cache = new Map();
    const CACHE_MAX = 50;

    const log = (...args) => console.info(`[${new Date().toISOString()}] [StreetFrontage]`, ...args);

    const t = (key, fallback, params) => {
        const i18n = win.i18n;
        if (i18n && typeof i18n.t === 'function') {
            const value = i18n.t(key, params || {});
            if (typeof value === 'string' && value && value !== key) return value;
        }
        if (!params) return fallback;
        return String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match));
    };

    function backendBase() {
        if (typeof win.resolveBackendBaseUrl === 'function') return win.resolveBackendBaseUrl();
        if (typeof win.getBackendBase === 'function') return win.getBackendBase();
        throw new Error('StreetFrontage: the backend base URL is unavailable');
    }

    // The site's bbox grown by the scorer's reach, so a street just past an edge is in the answer.
    function searchBox(site) {
        const plots = win.__sitePlots;
        const [w, s, e, n] = win.turf.bbox(site);
        const marginM = plots.FRONTAGE_STREET_MAX_DISTANCE_M + 5;
        const dLat = marginM / 111320;
        const dLng = marginM / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
        const round = value => Math.round(value * 1e6) / 1e6;
        return [round(w - dLng), round(s - dLat), round(e + dLng), round(n + dLat)];
    }

    async function streetsAround(box) {
        const key = box.join(',');
        if (cache.has(key)) return cache.get(key);
        const response = await fetch(`${String(backendBase()).replace(/\/$/, '')}/streets/near?bbox=${encodeURIComponent(key)}`);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(`HTTP ${response.status}${body && body.error ? `: ${body.error}` : ''}`);
        }
        const data = await response.json();
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(key, data);
        return data;
    }

    /**
     * The frontage a site defaults to.
     * @returns {Promise<{ frontageEdgeIndex, basis: 'street', street, distanceM, source }
     *   | { frontageEdgeIndex, basis: 'longest', reason: 'no-street'|'unavailable', error? }>}
     */
    async function find(site) {
        const plots = win.__sitePlots;
        if (!plots || !win.turf || !site) throw new Error('StreetFrontage: site-plots or turf is not loaded');
        const longest = () => plots.defaultFrontageEdge(site, { turf: win.turf });
        let data = null;
        try {
            data = await streetsAround(searchBox(site));
        } catch (error) {
            console.warn('[StreetFrontage] street lookup failed; the frontage stays the longest edge', error);
            return { frontageEdgeIndex: longest(), basis: 'longest', reason: 'unavailable', error: error.message };
        }
        const streets = Array.isArray(data && data.features) ? data.features : [];
        const result = plots.frontageFromStreets(site, streets, { turf: win.turf });
        log(`${streets.length} street line(s) from ${data.source}${data.partial ? ' (partial)' : ''}: ${result.basis === 'street'
            ? `edge ${result.frontageEdgeIndex} faces ${result.street.name || result.street.highway || 'a street'} at ${result.distanceM} m`
            : `no street faces the site; longest edge ${result.frontageEdgeIndex}`}`);
        if (result.basis === 'street') return { ...result, source: data.source };
        // An Overpass answer missing cells cannot say "no street here".
        return { ...result, reason: data.partial ? 'unavailable' : 'no-street', source: data.source };
    }

    // One line saying which basis the frontage stands on, or '' when there is nothing to say.
    function basisText(result) {
        if (!result) return '';
        if (result.basis === 'pending') return t('siteTool.frontage.pending', 'Looking for the street this site faces…');
        if (result.basis === 'user') return t('siteTool.frontage.user', 'Frontage: the edge you chose.');
        if (result.basis === 'street') {
            const name = result.street && result.street.name;
            return name
                ? t('siteTool.frontage.facing', 'Frontage facing {{street}} ({{distance}} m away).', { street: name, distance: Math.round(result.distanceM) })
                : t('siteTool.frontage.facingUnnamed', 'Frontage facing an unnamed street ({{distance}} m away).', { distance: Math.round(result.distanceM) });
        }
        if (result.basis === 'longest') {
            return result.reason === 'unavailable'
                ? t('siteTool.frontage.longestNoData', 'Frontage: the longest edge (street data is unavailable here).')
                : t('siteTool.frontage.longestNoStreet', 'Frontage: the longest edge (no street within {{distance}} m).', {
                    distance: win.__sitePlots ? win.__sitePlots.FRONTAGE_STREET_MAX_DISTANCE_M : 30
                });
        }
        return '';
    }

    win.StreetFrontage = { find, basisText };
})(window);
