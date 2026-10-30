// Environment backend routing and per-dataset request builders
(function () {
    const CityConfigManager = window.CityConfigManager || null;
    const localStorage = window.BrowserWorkspace?.storage || window.localStorage;
    // Prefer localhost:3000 explicitly for dev/file protocols
    const LOCAL_BASE = (function () {
        try {
            if (window.location.protocol === 'file:') return 'http://localhost:3000';
            if ((window.location.hostname || '').toLowerCase() === 'localhost') return 'http://localhost:3000';
            if ((window.location.hostname || '').toLowerCase() === '127.0.0.1') return 'http://127.0.0.1:3000';
        } catch (_) { }
        return 'http://localhost:3000';
    })();
    const UGT_BASE = 'https://api.urbangametheory.xyz';
    const GUP_ARCGIS_BASE = 'https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/Ulice_200409/FeatureServer/1/query';

    // Backend mode follows the environment. Dataset provider choices are configured separately.
    function getDataSource() {
        return window.current_environment === 'development' ? 'localhost' : 'api.urbangametheory.xyz';
    }

    // Dev override: when launching a worktree on a custom backend port (see dev.sh at the repo
    // root), the ?backend=<url> query param — persisted to localStorage — repoints every backend
    // call. Localhost/file-only so it can never affect production.
    function getDevBackendOverride() {
        try {
            const host = (window.location.hostname || '').toLowerCase();
            const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || window.location.protocol === 'file:';
            if (!isLocal) return null;
            const param = new URLSearchParams(window.location.search).get('backend');
            if (param) {
                try { localStorage.setItem('cb_dev_backend_base', param); } catch (_) { }
                return param;
            }
            try { return localStorage.getItem('cb_dev_backend_base') || null; } catch (_) { return null; }
        } catch (_) { return null; }
    }

    function getBackendBase() {
        const devOverride = getDevBackendOverride();
        if (devOverride) return devOverride.replace(/\/+$/, '');
        return getDataSource() === 'localhost' ? LOCAL_BASE : UGT_BASE;
    }

    // Return request details for the city's configured parcel provider.
    function buildParcelRequestParams(bbox, options) {
        options = options || {};
        const count = isFinite(Number(options.count)) ? String(Number(options.count)) : '2000';
        const startIndex = isFinite(Number(options.startIndex)) && Number(options.startIndex) > 0
            ? String(Number(options.startIndex))
            : undefined;
        const requestedCity = options.city ? String(options.city) : null;
        const requestedConfig = requestedCity && CityConfigManager
            ? (CityConfigManager.getAvailableCities?.() || []).find(config => String(config?.id || '') === requestedCity)
            : null;
        const cityParcelsConfig = requestedConfig?.parcels
            || (CityConfigManager ? CityConfigManager.getCurrentCityConfig()?.parcels : null);

        const source = cityParcelsConfig?.source;
        if (source === 'none') return null;
        if (source === 'parcel-source') {
            if (!cityParcelsConfig.sourceId) throw new Error('Parcel source ID is missing.');
            return { source, sourceId: cityParcelsConfig.sourceId, browserAdapter: true, returnsWGS84: true,
                completeResponse: true, disablePagination: true };
        }
        const importedSources = {
            'parcel-ba': {}, 'parcel-bg': { disablePagination: true },
            'parcel-lj': { disablePagination: true }, 'parcel-nyc': {}
        };
        if (source && Object.prototype.hasOwnProperty.call(importedSources, source)) {
            const base = getBackendBase().replace(/\/$/, '');
            const params = new URLSearchParams();
            if (options.latLonBbox) params.set('bbox', options.latLonBbox);
            if (options.parcelId || options.parcel_id) params.set('parcel_id', options.parcelId || options.parcel_id);
            if (startIndex !== undefined) params.set('offset', startIndex);
            params.set('limit', count);
            return { url: `${base}/${source}?${params}`, ownershipBase: `${base}/${source}`,
                isOSS: false, source, returnsWGS84: true, ...importedSources[source] };
        }
        if (source && source !== 'oss-wfs') throw new Error(`Unsupported parcel source: ${source}`);

        // Croatian cities (Zagreb, Split, Šibenik) all land here. getBackendBase() rather than
        // LOCAL_BASE/UGT_BASE: it already resolves dev override -> localhost -> prod, and it is what
        // honours a localhost worktree's `?backend=` override. Hardcoding LOCAL_BASE sent every
        // parcel request to port 3000 no matter which port ./dev.sh had actually started the
        // backend on, so a worktree loaded zero parcels while every OTHER city source — which all
        // call getBackendBase() — worked fine.
        const url = `${getBackendBase()}/parcels?bbox=${encodeURIComponent(bbox)}`;
        return { url, isOSS: false, returnsWGS84: true };
    }

    function buildPlannedRoadRequestParams(bbox) {
        const base = getBackendBase();
        const trimmed = typeof bbox === 'string' ? bbox.trim() : '';
        const url = trimmed
            ? `${base}/planned-road?bbox=${encodeURIComponent(trimmed)}`
            : `${base}/planned-road`;
        return { url, base };
    }

    function buildStreetRequestParams(options = {}) {
        const dataSource = getDataSource();
        const backendBase = getBackendBase();
        const bboxHTRS = options.bboxHTRS || options.bbox || '';
        const limit = Number.isFinite(options.limit) ? Number(options.limit) : 2000;
        const offset = Number.isFinite(options.offset) ? Number(options.offset) : 0;

        if (dataSource === 'localhost') {
            const search = bboxHTRS ? `?bbox=${encodeURIComponent(bboxHTRS)}` : '';
            return { url: `${backendBase}/streets${search}`, pageSize: null, source: 'backend' };
        }

        const params = new URLSearchParams({
            where: '1=1',
            outFields: '*',
            outSR: '4326',
            f: 'geojson',
            returnGeometry: 'true',
            resultRecordCount: String(limit),
            resultOffset: String(offset)
        });

        if (options.geometry) {
            params.set('geometry', options.geometry);
            params.set('geometryType', 'esriGeometryEnvelope');
            params.set('inSR', options.geometrySR ? String(options.geometrySR) : '4326');
            params.set('spatialRel', 'esriSpatialRelIntersects');
        }

        return {
            url: `${GUP_ARCGIS_BASE}?${params.toString()}`,
            pageSize: limit,
            source: 'arcgis'
        };
    }

    // Files the backend stores (proposal thumbnails, uploaded images, models, metadata) are served
    // at PATHS: the API returns `/uploads/images/<file>` unless a public origin is pinned on the
    // server. Resolve a path against the backend this page talks to — the `?backend=` override
    // included — and leave absolute, data:, blob: and ipfs: references alone. Rows used to carry
    // whichever localhost port the day's backend ran on, and every one of them went dead.
    function resolveBackendAssetUrl(url) {
        if (url === undefined || url === null) return null;
        const value = String(url).trim();
        if (!value) return null;
        // A local record may still carry the origin of the dev backend that stored it (a plan
        // applied before the rows were repaired copied those values into local storage). Only the
        // path is stable: re-anchor a localhost origin onto the backend this page talks to.
        const staleLocal = value.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/(?:uploads|images)\/.*)$/i);
        if (staleLocal) return `${getBackendBase().replace(/\/+$/, '')}${staleLocal[1]}`;
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value;
        const base = getBackendBase().replace(/\/+$/, '');
        return `${base}${value.startsWith('/') ? '' : '/'}${value}`;
    }

    // Expose builder to other modules
    window.resolveBackendAssetUrl = resolveBackendAssetUrl;
    window.buildParcelRequestParams = buildParcelRequestParams;
    window.buildPlannedRoadRequestParams = buildPlannedRoadRequestParams;
    window.buildStreetRequestParams = buildStreetRequestParams;
    window.getBackendBase = getBackendBase;
    window.getCurrentDataSource = getDataSource;
})();
