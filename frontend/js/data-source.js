// Data source selection and utility for parcel fetching
(function () {
    const CityConfigManager = window.CityConfigManager || null;
    const OSS_BASE = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
    // Prefer localhost:3000 explicitly for dev/file protocols
    const LOCAL_BASE = (function () {
        try {
            if (window.location.protocol === 'file:') return 'http://localhost:3000';
            if ((window.location.hostname || '').toLowerCase() === 'localhost') return 'http://localhost:3000';
            if ((window.location.hostname || '').toLowerCase() === '127.0.0.1') return 'http://127.0.0.1:3000';
        } catch (_) { }
        return 'http://localhost:3000';
    })();
    const UGT_BASE = 'https://api.urbangametheory.xyz'; // placeholder, not used yet
    const GUP_ARCGIS_BASE = 'https://services8.arcgis.com/Usi0jGQwMmBUpFjr/arcgis/rest/services/Ulice_200409/FeatureServer/1/query';

    // Persist choice in PersistentStorage so it survives reloads
    function getStoredDataSource() {
        return PersistentStorage.getItem('cb_data_source');
    }
    function storeDataSource(value) {
        PersistentStorage.setItem('cb_data_source', value);
    }

    function clearAllClientStorage() {
        try {
            if (typeof PersistentStorage !== 'undefined' && PersistentStorage && typeof PersistentStorage.clear === 'function') {
                PersistentStorage.clear();
            }
        } catch (error) {
            console.warn('Failed to clear PersistentStorage during data source switch', error);
        }

        try {
            if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.clear === 'function') {
                window.localStorage.clear();
            }
        } catch (error) {
            console.warn('Failed to clear localStorage during data source switch', error);
        }
    }

    function computeDefaultDataSource() {
        // Default to our backend in production; only fall back to localhost during dev.
        if (CityConfigManager && CityConfigManager.requiresBackendDataSource()) {
            return window.current_environment === 'development' ? 'localhost' : 'api.urbangametheory.xyz';
        }
        if (window.current_environment === 'development') return 'localhost';
        return 'api.urbangametheory.xyz';
    }

    function getDataSource() {
        const stored = getStoredDataSource();
        const requiresBackend = CityConfigManager ? CityConfigManager.requiresBackendDataSource() : false;
        const fallback = computeDefaultDataSource();
        if (requiresBackend && stored !== fallback) {
            storeDataSource(fallback);
            return fallback;
        }
        // If in production and a legacy/non-backend source was stored, reset to backend
        if (window.current_environment !== 'development' && stored === 'oss.uredjenazemlja.hr') {
            storeDataSource(fallback);
            return fallback;
        }
        return stored || fallback;
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
        const dataSource = getDataSource();
        if (dataSource === 'localhost') {
            return LOCAL_BASE;
        }
        if (dataSource === 'api.urbangametheory.xyz') {
            return UGT_BASE;
        }
        const env = typeof window !== 'undefined' ? window.current_environment : 'production';
        if (env === 'development') {
            return LOCAL_BASE;
        }
        return UGT_BASE;
    }

    function isProdHost() {
        try {
            const host = (window.location && window.location.hostname) || '';
            return /urbangametheory\.xyz$/i.test(host);
        } catch (_) {
            return false;
        }
    }

    // Return a URL and params appropriate for the selected source
    // Supports WFS 2.0.0 paging with count/startIndex when talking to OSS
    function buildParcelRequestParams(bbox, options) {
        options = options || {};
        const count = isFinite(Number(options.count)) ? String(Number(options.count)) : '2000';
        const startIndex = isFinite(Number(options.startIndex)) && Number(options.startIndex) > 0
            ? String(Number(options.startIndex))
            : undefined;
        const cityParcelsConfig = CityConfigManager ? CityConfigManager.getCurrentCityConfig()?.parcels : null;

        // Force backend when on production host to avoid OSS fetches and ExceptionReports
        const forcedBackend = isProdHost();

        if (cityParcelsConfig && cityParcelsConfig.source === 'parcel-ba') {
            const base = getBackendBase().replace(/\/$/, '');
            const params = new URLSearchParams();
            if (typeof options.latLonBbox === 'string' && options.latLonBbox.trim().length) {
                params.set('bbox', options.latLonBbox.trim());
            }
            if (startIndex !== undefined) {
                params.set('offset', startIndex);
            }
            if (count) {
                params.set('limit', count);
            }
            const query = params.toString();
            const url = `${base}/parcel-ba${query ? `?${query}` : ''}`;
            const ownershipUrl = `${base}/parcel-ba`;
            return { url, isOSS: false, source: 'parcel-ba', ownershipBase: ownershipUrl, returnsWGS84: true };
        }

        if (cityParcelsConfig && cityParcelsConfig.source === 'parcel-bg') {
            const base = getBackendBase().replace(/\/$/, '');
            const params = new URLSearchParams();
            if (typeof options.latLonBbox === 'string' && options.latLonBbox.trim().length) {
                params.set('bbox', options.latLonBbox.trim());
            }
            if (options.parcelId || options.parcel_id) {
                params.set('parcel_id', (options.parcelId || options.parcel_id).toString());
            }
            if (count) {
                params.set('limit', count);
            }
            const query = params.toString();
            const url = `${base}/parcel-bg${query ? `?${query}` : ''}`;
            const ownershipUrl = `${base}/parcel-bg`;
            return { url, isOSS: false, source: 'parcel-bg', ownershipBase: ownershipUrl, disablePagination: true, returnsWGS84: true };
        }

        if (cityParcelsConfig && cityParcelsConfig.source === 'parcel-lj') {
            const base = getBackendBase().replace(/\/$/, '');
            const params = new URLSearchParams();
            if (typeof options.latLonBbox === 'string' && options.latLonBbox.trim().length) {
                params.set('bbox', options.latLonBbox.trim());
            }
            if (options.parcelId || options.parcel_id) {
                params.set('parcel_id', (options.parcelId || options.parcel_id).toString());
            }
            if (count) {
                params.set('limit', count);
            }
            const query = params.toString();
            const url = `${base}/parcel-lj${query ? `?${query}` : ''}`;
            const ownershipUrl = `${base}/parcel-lj`;
            return { url, isOSS: false, source: 'parcel-lj', ownershipBase: ownershipUrl, disablePagination: true, returnsWGS84: true };
        }

        if (cityParcelsConfig && cityParcelsConfig.source === 'parcel-co') {
            const base = getBackendBase().replace(/\/$/, '');
            const params = new URLSearchParams();
            if (typeof options.latLonBbox === 'string' && options.latLonBbox.trim().length) {
                params.set('bbox', options.latLonBbox.trim());
            }
            if (options.parcelId || options.parcel_id) {
                params.set('parcel_id', (options.parcelId || options.parcel_id).toString());
            }
            if (startIndex !== undefined) {
                params.set('offset', startIndex);
            }
            if (count) {
                params.set('limit', count);
            }
            const query = params.toString();
            const url = `${base}/parcel-co${query ? `?${query}` : ''}`;
            const ownershipUrl = `${base}/parcel-co`;
            return { url, isOSS: false, source: 'parcel-co', ownershipBase: ownershipUrl, returnsWGS84: true };
        }

        if (cityParcelsConfig && cityParcelsConfig.source === 'parcel-nyc') {
            const base = getBackendBase().replace(/\/$/, '');
            const params = new URLSearchParams();
            if (typeof options.latLonBbox === 'string' && options.latLonBbox.trim().length) {
                params.set('bbox', options.latLonBbox.trim());
            }
            if (options.parcelId || options.parcel_id) {
                params.set('parcel_id', (options.parcelId || options.parcel_id).toString());
            }
            if (startIndex !== undefined) {
                params.set('offset', startIndex);
            }
            if (count) {
                params.set('limit', count);
            }
            const query = params.toString();
            const url = `${base}/parcel-nyc${query ? `?${query}` : ''}`;
            const ownershipUrl = `${base}/parcel-nyc`;
            return { url, isOSS: false, source: 'parcel-nyc', ownershipBase: ownershipUrl, returnsWGS84: true };
        }

        const dataSource = forcedBackend ? 'api.urbangametheory.xyz' : getDataSource();
        if (dataSource === 'oss.uredjenazemlja.hr') {
            const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
            const search = new URLSearchParams({
                token: token,
                service: 'WFS',
                version: '2.0.0',
                request: 'GetFeature',
                outputFormat: 'json',
                typeName: 'oss:DKP_CESTICE',
                srsName: 'EPSG:3765',
                bbox: bbox,
                count: count
            });
            if (startIndex !== undefined) search.set('startIndex', startIndex);
            const params = search.toString();
            return { url: `${OSS_BASE}?${params}`, isOSS: true };
        }

        if (dataSource === 'localhost') {
            const url = `${LOCAL_BASE}/parcels?bbox=${encodeURIComponent(bbox)}`;
            return { url, isOSS: false, returnsWGS84: true };
        }

        // Fallback / placeholder for api.urbangametheory.xyz (visible but not used yet)
        const url = `${UGT_BASE}/parcels?bbox=${encodeURIComponent(bbox)}`;
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

    // Return URL for building footprints. `source` picks WHICH SURVEY:
    //
    //   'gdi' (default) — the photogrammetric objects, keyed by object_id. This is the WORKING SET:
    //                     the same features gdi_building_3d meshes, so it is what detection scans
    //                     and what the 3D view renders.
    //   'dgu'           — the cadastre (DKP_ZGRADE), keyed by zgrada_id. Reference layer only.
    //
    // Both come from OUR backend, on every data source. The OSS WFS is not an option here even in
    // `oss.uredjenazemlja.hr` mode: it serves DKP_ZGRADE (cadastre) only, and it cannot serve the
    // GDI objects at all — they exist solely in our database. Routing the working set through a
    // source that can only ever return the OTHER survey is exactly the bug this all came from.
    function buildBuildingRequestParams(bbox, source = 'gdi') {
        const cityConfig = CityConfigManager ? CityConfigManager.getCurrentCityConfig() : null;
        if (cityConfig && cityConfig.buildings && cityConfig.buildings.source === 'none') {
            return null;
        }
        const base = (getDataSource() === 'localhost') ? LOCAL_BASE : UGT_BASE;
        const search = new URLSearchParams({ bbox, source: source === 'dgu' ? 'dgu' : 'gdi' });
        return { url: `${base}/buildings?${search.toString()}`, isOSS: false };
    }

    function initDataSourceUI() {
        const select = document.getElementById('data-source-select');
        if (!select) return;
        const current = getDataSource();
        if (Array.from(select.options).some(o => o.value === current)) {
            select.value = current;
        }
        // Keep selectable even if backend is recommended; enforcement is handled in getDataSource/buildParcelRequestParams.
        select.disabled = false;
        // Track the last confirmed selection to allow cancellation
        let lastConfirmed = select.value;

        select.addEventListener('change', async () => {
            const newValue = select.value;

            const warning = 'Changing the data source will CLEAR all locally saved data (parcels, roads, proposals, plans, user settings, etc.).\n\nDo you want to proceed?';
            const proceed = await window.showStyledConfirm(warning);

            if (!proceed) {
                // Revert dropdown to the last confirmed value and cancel
                select.value = lastConfirmed;
                if (typeof updateStatus === 'function') {
                    updateStatus('Data source change cancelled');
                }
                return;
            }

            try {
                if (typeof clearLocalParcelData === 'function') {
                    clearLocalParcelData();
                }
            } catch (error) {
                console.warn('Error clearing local parcel data during data source switch', error);
            }

            clearAllClientStorage();

            // Commit the change after storage is cleared so the new value persists
            storeDataSource(newValue);
            lastConfirmed = newValue;

            if (typeof updateStatus === 'function') {
                updateStatus(`Data source set to: ${newValue}. Cleared all local data.`);
            }

            try {
                if (typeof fetchParcelData === 'function') {
                    fetchParcelData();
                }
            } catch (error) {
                console.warn('Error fetching parcel data after data source switch', error);
            }
        });
    }

    document.addEventListener('DOMContentLoaded', initDataSourceUI);

    // Expose builder to other modules
    window.buildParcelRequestParams = buildParcelRequestParams;
    window.buildBuildingRequestParams = buildBuildingRequestParams;
    window.buildPlannedRoadRequestParams = buildPlannedRoadRequestParams;
    window.buildStreetRequestParams = buildStreetRequestParams;
    window.getBackendBase = getBackendBase;
    window.getCurrentDataSource = getDataSource;
})();


