// Pure imagery configuration and tile request shaping, shared by the settings and Leaflet adapter.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ImagerySource = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const DGU_BOUNDS = [13.419167, 43.572269, 16.5, 46.417688];
    const CATALOG = [2022, 2024].map(year => Object.freeze({
        key: 'dgu' + year, countryCode: 'HR', name: 'DGU orthophoto ' + year,
        endpoint: 'https://geoportal.dgu.hr/services/inspire/orthophoto_' + year + '/wms',
        layers: ['OI.OrthoimageCoverage'], bounds: DGU_BOUNDS
    }));
    const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[<>\r\n]/.test(value);
    function decode(id, city) {
        try {
            if (typeof id !== 'string' || !/^imagery\.[A-Za-z0-9_-]{1,6500}$/.test(id)) return null;
            const encoded = id.slice(8).replace(/-/g, '+').replace(/_/g, '/');
            const json = typeof Buffer !== 'undefined' ? Buffer.from(encoded, 'base64').toString('utf8')
                : new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
            const source = JSON.parse(json), url = new URL(source.endpoint);
            if (source.kind !== 'imagery' || !['xyz', 'wms'].includes(source.adapter)
                || source.cityIds?.length !== 1 || source.cityIds[0] !== city
                || !/^CUSTOM-I-[0-9a-f]{20}-$/.test(source.idPrefix)
                || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443'
                || [...url.searchParams.keys()].some(key => /auth|token|key|secret|password|signature|^sig$/i.test(key))
                || !label(source.name) || source.attribution !== undefined && !label(source.attribution)) return null;
            if (source.bounds !== undefined && (!Array.isArray(source.bounds) || source.bounds.length !== 4
                || !source.bounds.every(Number.isFinite) || source.bounds[0] < -180 || source.bounds[2] > 180
                || source.bounds[1] < -90 || source.bounds[3] > 90 || source.bounds[0] >= source.bounds[2] || source.bounds[1] >= source.bounds[3])) return null;
            for (const key of ['minZoom', 'maxZoom']) if (source[key] !== undefined
                && (!Number.isInteger(source[key]) || source[key] < 0 || source[key] > 22)) return null;
            if ((source.maxZoom ?? 22) < (source.minZoom ?? 0)) return null;
            if (source.adapter === 'xyz' && (!['z', 'x', 'y'].every(token => source.endpoint.split('{' + token + '}').length === 2)
                || /[{}]/.test(source.endpoint.replace(/\{[zxy]\}/g, ''))
                || ['layers', 'version', 'crs', 'format'].some(key => source[key] !== undefined))) return null;
            if (source.adapter === 'wms' && (!Array.isArray(source.layers) || !source.layers.length
                || !['EPSG:3857', 'EPSG:4326', 'CRS:84'].includes(source.crs)
                || !['1.1.1', '1.3.0'].includes(source.version)
                || source.layers.length > 8 || source.layers.some(layer => typeof layer !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(layer))
                || !['image/png', 'image/jpeg'].includes(source.format)
                || source.version === '1.1.1' && source.crs === 'CRS:84'
                || source.minZoom !== undefined || source.maxZoom !== undefined)) return null;
            return { ...source, id };
        } catch (_) { return null; }
    }
    function suggestions(city, center) {
        if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return [];
        return CATALOG.filter(source => source.countryCode === city?.countryCode && center.lng >= source.bounds[0] && center.lng <= source.bounds[2]
            && center.lat >= source.bounds[1] && center.lat <= source.bounds[3]);
    }
    // Both adapters return Web Mercator tiles through the protected imagery gateway.
    function tileUrl(base, source, coords) {
        return base.replace(/\/+$/, '') + '/imagery-sources/' + encodeURIComponent(source.id)
            + '/tiles/' + coords.z + '/' + coords.x + '/' + coords.y;
    }
    function escapeAttribution(text) {
        return String(text || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    return Object.freeze({ CATALOG, decode, suggestions, tileUrl, escapeAttribution });
});
