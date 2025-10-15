// Data source selection and utility for parcel fetching
(function () {
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

    // Persist choice in PersistentStorage so it survives reloads
    function getStoredDataSource() {
        return PersistentStorage.getItem('cb_data_source');
    }
    function storeDataSource(value) {
        PersistentStorage.setItem('cb_data_source', value);
    }

    function computeDefaultDataSource() {
        if (window.current_environment === 'development') return 'localhost';
        return 'oss.uredjenazemlja.hr';
    }

    function getDataSource() {
        const stored = getStoredDataSource();
        return stored || computeDefaultDataSource();
    }

    function getBackendBase() {
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

    // Return a URL and params appropriate for the selected source
    // Supports WFS 2.0.0 paging with count/startIndex when talking to OSS
    function buildParcelRequestParams(bbox, options) {
        options = options || {};
        const count = isFinite(Number(options.count)) ? String(Number(options.count)) : '2000';
        const startIndex = isFinite(Number(options.startIndex)) && Number(options.startIndex) > 0
            ? String(Number(options.startIndex))
            : undefined;
        const dataSource = getDataSource();
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
            return { url, isOSS: false };
        }

        // Fallback / placeholder for api.urbangametheory.xyz (visible but not used yet)
        const url = `${UGT_BASE}/parcels?bbox=${encodeURIComponent(bbox)}`;
        return { url, isOSS: false };
    }

    function buildPlannedRoadRequestParams(bbox) {
        const base = getBackendBase();
        const trimmed = typeof bbox === 'string' ? bbox.trim() : '';
        const url = trimmed
            ? `${base}/planned-road?bbox=${encodeURIComponent(trimmed)}`
            : `${base}/planned-road`;
        return { url, base };
    }

    // Return URL for buildings depending on selected data source
    function buildBuildingRequestParams(bbox) {
        const dataSource = getDataSource();
        if (dataSource === 'oss.uredjenazemlja.hr') {
            const token = '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';
            const search = new URLSearchParams({
                token: token,
                service: 'WFS',
                version: '1.0.0',
                request: 'GetFeature',
                maxFeatures: '2000',
                outputFormat: 'json',
                typeName: 'oss:DKP_ZGRADE',
                srsName: 'EPSG:3765',
                bbox: bbox
            });
            const url = `${OSS_BASE}?${search.toString()}`;
            return { url, isOSS: true };
        }

        if (dataSource === 'localhost') {
            const url = `${LOCAL_BASE}/buildings?bbox=${encodeURIComponent(bbox)}`;
            return { url, isOSS: false };
        }

        // api.urbangametheory.xyz
        const url = `${UGT_BASE}/buildings?bbox=${encodeURIComponent(bbox)}`;
        return { url, isOSS: false };
    }

    function initDataSourceUI() {
        const select = document.getElementById('data-source-select');
        if (!select) return;
        const current = getDataSource();
        if (Array.from(select.options).some(o => o.value === current)) {
            select.value = current;
        }
        // Track the last confirmed selection to allow cancellation
        let lastConfirmed = select.value;

        select.addEventListener('change', () => {
            const newValue = select.value;

            const warning = 'Changing the data source will CLEAR local parcel data, including your work (road markings, newly added road parcels, split parcels, etc.).\n\nDo you want to proceed?';
            const proceed = window.confirm(warning);

            if (!proceed) {
                // Revert dropdown to the last confirmed value and cancel
                select.value = lastConfirmed;
                if (typeof updateStatus === 'function') {
                    updateStatus('Data source change cancelled');
                }
                return;
            }

            // Commit the change
            storeDataSource(newValue);
            lastConfirmed = newValue;

            if (typeof updateStatus === 'function') {
                updateStatus(`Data source set to: ${newValue}`);
            }
            // Clear existing and fetch from the newly selected source
            try {
                if (typeof clearLocalParcelData === 'function') {
                    clearLocalParcelData();
                }
            } catch (_) { }
            try {
                if (typeof fetchParcelData === 'function') {
                    fetchParcelData();
                }
            } catch (_) { }
        });
    }

    document.addEventListener('DOMContentLoaded', initDataSourceUI);

    // Expose builder to other modules
    window.buildParcelRequestParams = buildParcelRequestParams;
    window.buildBuildingRequestParams = buildBuildingRequestParams;
    window.buildPlannedRoadRequestParams = buildPlannedRoadRequestParams;
    window.getBackendBase = getBackendBase;
    window.getCurrentDataSource = getDataSource;
})();


