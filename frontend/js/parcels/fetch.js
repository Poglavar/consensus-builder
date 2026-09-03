// Network transport for CadastralParcelRepository. No cache and no Leaflet operations live here.
(function attachCadastralTransport(global) {
    'use strict';

    const ID_BATCH_SIZE = 40;
    const OSS_URL = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
    const OSS_TOKEN = global.OSS_PUBLIC_ACCESS_TOKEN || '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';

    if (typeof global.fetchWithRetry !== 'function') {
        global.fetchWithRetry = async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
            let failure = null;
            for (let attempt = 0; attempt < retries; attempt += 1) {
                try {
                    const response = await fetch(url, options);
                    if (response.ok || response.status === 404) return response;
                    failure = new Error(`Parcel request failed: HTTP ${response.status}`);
                    failure.status = response.status;
                    if (response.status >= 400 && response.status < 500) break;
                } catch (error) {
                    failure = error;
                }
                if (attempt + 1 < retries) await new Promise(resolve => setTimeout(resolve, delay));
            }
            throw failure || new Error('Parcel request failed.');
        };
    }

    function chunks(values, size = ID_BATCH_SIZE) {
        const result = [];
        for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
        return result;
    }

    function backendBase() {
        try {
            const value = typeof global.getBackendBase === 'function' ? global.getBackendBase() : null;
            if (value) return String(value).replace(/\/$/, '');
        } catch (_) { }
        return 'https://api.urbangametheory.xyz';
    }

    function currentCity() {
        try {
            return String(typeof global.getCurrentCityId === 'function'
                ? global.getCurrentCityId()
                : global.CityConfigManager?.getCurrentCityId?.() || '');
        } catch (_) {
            return '';
        }
    }

    function currentSource() {
        try { return String(global.getCurrentDataSource?.() || ''); } catch (_) { return ''; }
    }

    function cityConfig(city) {
        try {
            const manager = global.CityConfigManager;
            const configs = manager?.getAvailableCities?.() || [];
            return configs.find(config => String(config?.id || '') === String(city || '')) || null;
        } catch (_) {
            return null;
        }
    }

    function roadConfig(city) {
        const config = cityConfig(city);
        if (config) return config.curatedRoads || null;
        try {
            return String(city || '') === currentCity()
                ? global.CityConfigManager?.getCuratedRoadsConfig?.() || null
                : null;
        } catch (_) {
            return null;
        }
    }

    function normalizeFeatureId(feature) {
        const props = feature && feature.properties || {};
        let value = props.parcelId ?? props.parcel_id ?? props.PARCEL_ID ?? props.id;
        if ((value === undefined || value === null || value === '')
            && props.maticni_broj_ko !== undefined && props.broj_cestice !== undefined) {
            value = `HR-${props.maticni_broj_ko}-${props.broj_cestice}`;
        }
        if (value === undefined || value === null || String(value).trim() === '') return '';
        props.parcelId = String(value).trim();
        props.id = props.parcelId;
        feature.properties = props;
        return props.parcelId;
    }

    function escapeXmlValue(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function buildParcelFilterXml(ids) {
        const clauses = Array.from(ids || []).map(String).filter(Boolean)
            .map(id => `<PropertyIsEqualTo><PropertyName>parcel_id</PropertyName><Literal>${escapeXmlValue(id)}</Literal></PropertyIsEqualTo>`);
        if (!clauses.length) return '';
        return clauses.length === 1
            ? `<Filter>${clauses[0]}</Filter>`
            : `<Filter><Or>${clauses.join('')}</Or></Filter>`;
    }

    async function responseJson(url, options = {}, requestOptions = {}) {
        const response = await global.fetchWithRetry(url, options, requestOptions.retries || 3, requestOptions.delay || 600);
        if (response.status === 404 && requestOptions.notFoundIsEmpty === true) return { __absent: true, features: [] };
        if (!response.ok) {
            const error = new Error(`Parcel request failed: HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        try {
            return await response.json();
        } catch (error) {
            error.message = `Parcel response was not JSON: ${error.message}`;
            throw error;
        }
    }

    async function requestBackendIds(ids) {
        const features = [];
        for (const batch of chunks(ids)) {
            const url = `${backendBase()}/parcels/parcelIds?${new URLSearchParams({ ids: batch.join(',') })}`;
            const payload = await responseJson(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
            if (!Array.isArray(payload.features)) throw new Error('Backend parcelIds response has no features array.');
            features.push(...payload.features);
        }
        return features;
    }

    async function requestOneByOne(ids, route, parameter) {
        const results = await Promise.all(ids.map(async id => {
            const url = `${backendBase()}/${route}?${new URLSearchParams({ [parameter]: id })}`;
            const payload = await responseJson(url, { headers: { Accept: 'application/json' } }, { notFoundIsEmpty: true });
            if (payload.__absent) return [];
            if (!Array.isArray(payload.features)) throw new Error(`${route} response has no features array.`);
            return payload.features;
        }));
        return results.flat();
    }

    async function requestOssIds(ids) {
        const params = new URLSearchParams({
            token: OSS_TOKEN,
            service: 'WFS',
            version: '2.0.0',
            request: 'GetFeature',
            outputFormat: 'json',
            typeName: 'oss:DKP_CESTICE',
            srsName: 'EPSG:3765',
            FILTER: buildParcelFilterXml(ids)
        });
        const payload = await responseJson(`${OSS_URL}?${params}`, { headers: { Accept: 'application/json' } });
        if (!Array.isArray(payload.features)) throw new Error('OSS parcel response has no features array.');
        return payload.features;
    }

    async function fetchByIds(parcelIds, options = {}) {
        const ids = Array.from(new Set(Array.from(parcelIds || []).map(String).filter(Boolean)));
        if (!ids.length) return { status: 'ready', complete: true, features: [], absentIds: [], returnsWGS84: true };
        const city = String(options.city || currentCity());
        const source = currentSource();
        let features;
        let returnsWGS84 = true;
        if (city === 'buenos_aires') features = await requestOneByOne(ids, 'parcel-ba', 'smp');
        else if (city === 'colorado') features = await requestOneByOne(ids, 'parcel-co', 'parcel_id');
        else if (city === 'ljubljana') features = await requestOneByOne(ids, 'parcel-lj', 'parcel_id');
        else if (city === 'new_york') features = await requestOneByOne(ids, 'parcel-nyc', 'parcel_id');
        else if (source === 'oss.uredjenazemlja.hr') {
            features = await requestOssIds(ids);
            returnsWGS84 = false;
        } else features = await requestBackendIds(ids);

        const byId = new Map();
        features.forEach(feature => {
            const id = normalizeFeatureId(feature);
            if (id && !byId.has(id)) byId.set(id, feature);
        });
        const absentIds = ids.filter(id => !byId.has(id));
        options.onProgress?.({ done: ids.length, total: ids.length });
        return {
            status: 'ready',
            complete: true,
            features: Array.from(byId.values()),
            absentIds,
            returnsWGS84
        };
    }

    function datasetToLatLng(easting, northing, city) {
        const manager = global.CityConfigManager;
        if (manager && typeof manager.datasetToLatLng === 'function') {
            const result = manager.datasetToLatLng(easting, northing, city);
            if (Array.isArray(result) && result.length >= 2 && result.every(Number.isFinite)) return result;
        }
        if (typeof global.datasetToWgs84 === 'function') {
            const result = global.datasetToWgs84(easting, northing);
            if (Array.isArray(result) && result.length >= 2 && result.every(Number.isFinite)) return result;
        }
        throw new Error('Dataset-to-WGS84 conversion is unavailable.');
    }

    async function fetchCell(cell, context = {}) {
        const gridSize = Number(context.gridSize);
        if (!(gridSize > 0)) throw new Error('Parcel grid size is unavailable.');
        const [gridE, gridN] = String(cell).split(',').map(Number);
        if (![gridE, gridN].every(Number.isFinite)) throw new Error(`Invalid parcel grid key: ${cell}`);
        const swE = gridE * gridSize;
        const swN = gridN * gridSize;
        const neE = (gridE + 1) * gridSize;
        const neN = (gridN + 1) * gridSize;
        const bbox = `${swE},${swN},${neE},${neN}`;
        const sw = datasetToLatLng(swE, swN, context.city);
        const ne = datasetToLatLng(neE, neN, context.city);
        const latLonBbox = `${Math.min(sw[1], ne[1])},${Math.min(sw[0], ne[0])},${Math.max(sw[1], ne[1])},${Math.max(sw[0], ne[0])}`;
        const builder = context.builder;
        const count = 2000;
        let startIndex = 0;
        let more = true;
        let returnsWGS84 = false;
        const features = [];
        while (more) {
            const request = builder ? builder(bbox, { count, startIndex, latLonBbox, city: context.city }) : null;
            returnsWGS84 = request ? request.returnsWGS84 === true : false;
            const url = request ? request.url : `${OSS_URL}?${new URLSearchParams({
                token: OSS_TOKEN,
                service: 'WFS',
                version: '2.0.0',
                request: 'GetFeature',
                outputFormat: 'json',
                typeName: 'oss:DKP_CESTICE',
                srsName: 'EPSG:3765',
                bbox,
                count: String(count),
                startIndex: String(startIndex)
            })}`;
            const payload = await responseJson(url, {}, { notFoundIsEmpty: true });
            const page = Array.isArray(payload.features) ? payload.features : [];
            features.push(...page);
            const returned = Number(payload.numberReturned ?? page.length);
            const matched = Number(payload.numberMatched);
            if (request?.disablePagination || request?.source === 'parcel-bg' || payload.__absent) more = false;
            else if (Number.isFinite(matched) && matched >= 0) more = returned > 0 && startIndex + returned < matched;
            else more = returned === count && returned > 0;
            startIndex += returned;
        }
        return { features, returnsWGS84 };
    }

    async function fetchBounds(_bounds, options = {}) {
        const city = String(options.city || currentCity());
        const keys = Array.from(new Set(Array.from(options.keys || []).map(String).filter(Boolean)));
        if (!keys.length) throw new Error('Cadastral bounds transport requires repository grid keys.');
        const gridSize = Number(cityConfig(city)?.parcels?.gridSize
            ?? global.ParcelsState?.getParcelGridSize?.()
            ?? global.CityConfigManager?.getParcelGridSize?.()
            ?? global.PARCELS_GRID_SIZE);
        const builder = typeof global.buildParcelRequestParams === 'function' ? global.buildParcelRequestParams : null;
        const context = Object.freeze({ city, gridSize, builder });
        const results = [];
        let done = 0;
        for (const batch of chunks(keys, 6)) {
            const part = await Promise.all(batch.map(cell => fetchCell(cell, context)));
            results.push(...part);
            done += batch.length;
            options.onProgress?.({ done, total: keys.length });
        }
        const modes = new Set(results.map(result => result.returnsWGS84));
        if (modes.size > 1) throw new Error('Parcel bounds response mixed coordinate systems.');
        const byId = new Map();
        results.flatMap(result => result.features).forEach(feature => {
            const id = normalizeFeatureId(feature);
            if (id && !byId.has(id)) byId.set(id, feature);
        });
        return {
            status: 'ready',
            features: Array.from(byId.values()),
            absentIds: [],
            returnsWGS84: modes.has(true)
        };
    }

    async function fetchUnderGeometry(geometry, options = {}) {
        const geom = geometry && geometry.type === 'Feature' ? geometry.geometry : geometry;
        if (!geom || !geom.type) throw new Error('Cadastral footprint geometry is missing.');
        const parcelsOnly = options.parcelsOnly === true;
        const response = await fetch(`${backendBase()}/parcels/under`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ geometry: geom, srid: options.srid || 4326, ...(parcelsOnly ? { parcelsOnly: true } : {}) })
        });
        if (!response.ok) {
            let detail = '';
            try { detail = (await response.json()).error || ''; } catch (_) { }
            const error = new Error(`/parcels/under ${response.status}${detail ? `: ${detail}` : ''}`);
            error.status = response.status;
            throw error;
        }
        const payload = await response.json();
        if (!Array.isArray(payload.features)) throw new Error('/parcels/under response has no features array.');
        return {
            status: 'ready',
            features: payload.features,
            absentIds: [],
            returnsWGS84: true,
            coverage: payload.coverage === undefined ? null : Number(payload.coverage),
            count: Number(payload.count) || payload.features.length,
            queryMs: Number(payload.queryMs) || null
        };
    }

    function boundsArray(bounds) {
        if (Array.isArray(bounds) && bounds.length >= 4) return bounds.slice(0, 4).map(Number);
        if (!bounds || typeof bounds.getWest !== 'function') return null;
        return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map(Number);
    }

    function supportsRoadIds(options = {}) {
        const city = String(options.city || currentCity());
        return Boolean(roadConfig(city)?.url);
    }

    async function fetchRoadIds(bounds, options = {}) {
        const city = String(options.city || currentCity());
        const config = roadConfig(city);
        const bboxValues = boundsArray(bounds);
        if (!config?.url || !bboxValues || bboxValues.some(value => !Number.isFinite(value))) {
            return { status: 'unsupported', ids: [] };
        }
        const bbox = bboxValues.join(',');
        const payload = await responseJson(`${backendBase()}${config.url}?bbox=${encodeURIComponent(bbox)}`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        });
        if (!Array.isArray(payload.features)) throw new Error('Road classification response has no features array.');
        const ids = payload.features.map(feature => normalizeFeatureId(feature)).filter(Boolean);
        options.onProgress?.({ done: ids.length, total: ids.length });
        return { status: 'ready', ids: Array.from(new Set(ids)) };
    }

    async function fetchParcelData(customBounds) {
        if (global.skipParcelFetchUntilProposalLoaded && !customBounds) {
            global.updateStatus?.('Waiting for proposal to load before fetching parcels…');
            return null;
        }
        const repository = global.CadastralParcelRepository;
        if (!repository || typeof repository.ensureBounds !== 'function') throw new Error('Cadastral parcel repository is unavailable.');
        const viewBounds = customBounds || global.map?.getBounds();
        if (!viewBounds) throw new Error('Unable to determine map bounds for parcel fetch.');
        const padding = !customBounds && typeof viewBounds.pad === 'function'
            ? Number(global.ParcelFetchConfig?.getPadding?.() ?? global.PARCEL_FETCH_LATLNG_PADDING ?? 0.12)
            : 0;
        const requestedBounds = padding > 0 ? viewBounds.pad(padding) : viewBounds;
        global._fetchParcelDataInProgress = true;
        global.ParcelsState?.setIsFetchingParcels?.(true);
        global.updateStatus?.('Checking cadastral ground…');
        try {
            const result = await repository.ensureBounds(requestedBounds, {
                onProgress: detail => {
                    if (detail && detail.total) global.updateStatus?.(`Loading cadastral ground ${detail.done || 0}/${detail.total}…`);
                }
            });
            global.updateStatus?.(result.cached
                ? 'Cadastral ground already loaded.'
                : `Loaded ${result.features.length} cadastral parcels.`);
            return result;
        } finally {
            global._fetchParcelDataInProgress = false;
            global.ParcelsState?.setIsFetchingParcels?.(false);
        }
    }

    async function refreshParcelDataWithBusyState(customBounds) {
        const button = typeof document !== 'undefined' ? document.getElementById('refreshParcelDataButton') : null;
        const task = () => fetchParcelData(customBounds);
        return button && typeof global.runWithButtonBusyState === 'function'
            ? global.runWithButtonBusyState(button, 'Refreshing...', task)
            : task();
    }

    global.fetchParcelData = fetchParcelData;
    global.refreshParcelDataWithBusyState = refreshParcelDataWithBusyState;
    global.buildParcelFilterXml = buildParcelFilterXml;
    global.escapeXmlValue = escapeXmlValue;
    global.__cadastralGroundTransport = Object.freeze({
        fetchByIds,
        fetchBounds,
        fetchUnderGeometry,
        supportsRoadIds,
        fetchRoadIds
    });
})(typeof window !== 'undefined' ? window : globalThis);
