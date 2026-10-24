// Browser-side source adapters for existing public readers. URLs and provider qualifications live
// with sources; rendering, city selection, caching and retry policy stay with their consumers.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.BrowserSources = api;
        root.document?.getElementById('source-system-link')?.addEventListener('click', event => {
            const url = new URL('/sources.html', root.location.href);
            const backend = root.getBackendBase?.();
            if (backend) url.searchParams.set('backend', backend);
            event.currentTarget.href = url.href;
        });
    }
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const Runtime = root?.SourceRuntime || (typeof require === 'function' ? require('./source-runtime.js') : null);
    function selected(family, fallback, global = root) {
        const city = global?.CityConfigManager?.getCurrentCityConfig?.();
        return city?.sources?.[family] || fallback;
    }
    const geocoding = Runtime.createRegistry({ abstraction: 'geocoding', runtime: 'shared', required: ['search'],
        adapters: { photon: config => ({
            async search(params, { fetchImpl = fetch, signal, requestJson } = {}) {
                const url = new URL(config.endpoint);
                if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Geocoding requires a public HTTPS endpoint.');
                for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
                if (requestJson) return requestJson(url.href, { signal });
                const response = await fetchImpl(url.href, { signal });
                if (!response.ok) throw new Error(`HTTP ${response.status} from Photon`);
                return response.json();
            }
        }) }, sources: [Runtime.source('geocoding', 'photon', { id: 'photon', endpoint: 'https://photon.komoot.io/api/' })] });
    const transit = Runtime.createRegistry({ abstraction: 'transit-alignments', runtime: 'browser', required: ['load'],
        adapters: { 'static-geojson': config => ({
            async load({ fetchImpl = fetch } = {}) {
                const response = await fetchImpl(config.url);
                if (!response?.ok) throw new Error(`${config.id} responded ${response?.status ?? 'without a status'}`);
                return response.json();
            }
        }) } });
    const terrain = Runtime.createRegistry({ abstraction: 'terrain-profile', runtime: 'browser', required: ['profile', 'url'],
        adapters: { 'dgu-dtm-20m': config => ({
            url(global = root) {
                if (config.endpoint) return new URL(config.endpoint, global?.location?.href).href;
                const override = global?.__CORRIDOR_TERRAIN_PROFILE_URL__;
                if (typeof override === 'string' && override.trim()) return override.trim();
                const base = global?.__ZAGREB_RUNTIME_CONFIG__?.zagrebApiBaseUrl;
                if (base) return String(base).replace(/\/+$/, '') + config.path;
                const host = String(global?.location?.hostname || '').toLowerCase();
                if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:3001/api' + config.path;
                return String(global?.location?.origin || '').replace(/\/+$/, '') + '/api' + config.path;
            },
            async profile(request, { fetchImpl = fetch, signal, global = root } = {}) {
                const response = await fetchImpl(this.url(global), { method: 'POST',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
                if (!response.ok) throw new Error(`Terrain profile HTTP ${response.status}`);
                const result = await response.json();
                if (!result || result.source !== config.source || result.datum !== config.datum
                    || !Array.isArray(result.points) || result.points.length < 2) throw new Error('Invalid terrain source response.');
                return result;
            }
        }) }, sources: [Runtime.source('terrain-profile', 'dgu-dtm-20m', {
            id: 'dgu-dtm-20m', path: '/terrain/profile', source: 'dgu-dtm-20m', datum: 'EVRF2000', resolutionM: 20
        })] });
    const basemaps = Runtime.createRegistry({ abstraction: 'imagery', runtime: 'browser', required: ['basemap'], adapters: {
        'xyz-basemap': config => ({ basemap: () => ({ url: config.url, options: { ...config.options } }) }),
        'maptiler-basemap': config => ({ basemap: ({ apiKey } = {}) => ({
            url: config.url + '?key=' + encodeURIComponent(apiKey || ''), options: { ...config.options }
        }) })
    }, sources: [
        Runtime.source('imagery', 'xyz-basemap', { id: 'openstreetmap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            options: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } }),
        Runtime.source('imagery', 'maptiler-basemap', { id: 'maptiler', url: 'https://api.maptiler.com/maps/basic-v2/{z}/{x}/{y}.png',
            options: { maxZoom: 22, tileSize: 512, zoomOffset: -1,
                attribution: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } })
    ] });
    const reality = Runtime.createRegistry({ abstraction: 'reality-mesh', runtime: 'browser', required: ['authentication'], adapters: {
        'cesium-ion-3dtiles': { custom: false, create: config => ({
            authentication: ({ accessToken }) => ({ apiToken: accessToken, assetId: config.assetId })
        }) }
    }, sources: [Runtime.source('reality-mesh', 'cesium-ion-3dtiles', { id: 'google-photorealistic', assetId: 2275207 })] });
    function loadTransit(source, options) {
        const canonical = source.abstraction ? source : Runtime.source('transit-alignments', 'static-geojson', source);
        if (canonical.kind === 'default') transit.register(canonical, { replace: true });
        return transit.open(canonical).load(options);
    }
    return Object.freeze({ geocoding, transit, terrain, basemaps, reality, loadTransit,
        geocoder: global => geocoding.open(selected('geocoding', 'photon', global)),
        terrainSource: global => terrain.source(selected('terrain-profile', 'dgu-dtm-20m', global)),
        terrainReader: global => terrain.open(selected('terrain-profile', 'dgu-dtm-20m', global)),
        basemap: (id, options) => basemaps.open(id).basemap(options),
        realityAuthentication: (options, global) => reality.open(selected('reality-mesh', 'google-photorealistic', global)).authentication(options)
    });
});
