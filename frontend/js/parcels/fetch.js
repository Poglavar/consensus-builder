(function (global) {
    'use strict';

    const DIRECT_PARCEL_FETCH_BATCH_SIZE = 40;
    const BACKEND_PARCEL_IDS_CHUNK_SIZE = 40;
    const DIRECT_PARCEL_BACKEND_CHUNK_SIZE = 40; // used for BA-specific smp batching
    const OSS_PARCEL_WFS_BASE_URL = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
    const OSS_PUBLIC_ACCESS_TOKEN = global.OSS_PUBLIC_ACCESS_TOKEN || '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';

    const cityConfigManager = global.CityConfigManager || null;
    const parcelFetchConfig = global.ParcelFetchConfig || null;

    // Provide a resilient fetchWithRetry helper if one has not been registered yet.
    if (typeof global.fetchWithRetry !== 'function') {
        global.fetchWithRetry = async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
            let lastError;
            for (let attempt = 0; attempt < retries; attempt++) {
                try {
                    const response = await fetch(url, options);
                    if (response && response.ok) {
                        return response;
                    }
                    if (response && response.status >= 400 && response.status < 500) {
                        lastError = new Error(`Failed to fetch parcel data with client error: ${response.status}`);
                        break;
                    }
                    lastError = new Error(`Server error: ${response ? response.status : 'unknown status'}`);
                } catch (error) {
                    lastError = error;
                }
                if (attempt < retries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
            throw lastError;
        };
    }

    function chunkArray(values, size) {
        if (!Array.isArray(values) || !Number.isFinite(size) || size <= 0) {
            return [];
        }
        const chunks = [];
        for (let i = 0; i < values.length; i += size) {
            chunks.push(values.slice(i, i + size));
        }
        return chunks;
    }

    function datasetToLatLng(easting, northing) {
        if (cityConfigManager && typeof cityConfigManager.datasetToLatLng === 'function') {
            try {
                const result = cityConfigManager.datasetToLatLng(easting, northing);
                if (Array.isArray(result) && result.length >= 2 && Number.isFinite(result[0]) && Number.isFinite(result[1])) {
                    return result;
                }
            } catch (_) { /* ignore */ }
        }
        if (typeof global.htrs96ToWGS84 === 'function') {
            return global.htrs96ToWGS84(easting, northing);
        }
        return [northing, easting];
    }

    function getFetchPadding() {
        if (parcelFetchConfig && typeof parcelFetchConfig.getPadding === 'function') {
            return parcelFetchConfig.getPadding();
        }
        return Number((typeof global !== 'undefined' && global.PARCEL_FETCH_LATLNG_PADDING !== undefined)
            ? global.PARCEL_FETCH_LATLNG_PADDING
            : 0.12);
    }

    const normalizeFeatureParcelId = global.normalizeFeatureParcelId || function (feature) {
        if (!feature || typeof feature !== 'object') return null;
        if (typeof global.ensureParcelId === 'function') {
            return global.ensureParcelId(feature);
        }
        const props = feature.properties || {};
        const id = props.parcelId;
        if (id !== undefined && id !== null) {
            props.parcelId = String(id);
            feature.properties = props;
            return props.parcelId;
        }
        return null;
    };

    function getFetchGridRadius() {
        if (parcelFetchConfig && typeof parcelFetchConfig.getGridRadius === 'function') {
            return parcelFetchConfig.getGridRadius();
        }
        return Number((typeof global !== 'undefined' && global.PARCEL_FETCH_GRID_RADIUS !== undefined)
            ? global.PARCEL_FETCH_GRID_RADIUS
            : 0);
    }

    const removeAncestorParcelsFromAppliedProposals = global.removeAncestorParcelsFromAppliedProposals || (async function () { return undefined; });

    async function fetchParcelData(customBounds) {
        global._fetchParcelDataInProgress = true;
        if (global.skipParcelFetchUntilProposalLoaded && !customBounds) {
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Waiting for proposal to load before fetching parcels…');
            }
            global._fetchParcelDataInProgress = false;
            return;
        }
        if (global.ParcelsState && global.ParcelsState.setIsFetchingParcels) {
            global.ParcelsState.setIsFetchingParcels(true);
        }
        if (typeof global.updateStatus === 'function') {
            global.updateStatus('Fetching data...');
        }

        const cache = global.parcelCache || (global.ParcelsState && global.ParcelsState.getParcelCache && global.ParcelsState.getParcelCache());

        try {
            const viewBounds = customBounds || global.map?.getBounds();
            if (!viewBounds) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus('Unable to determine map bounds for parcel fetch.');
                }
                return;
            }

            const latLngPadding = (!customBounds && typeof viewBounds.pad === 'function')
                ? getFetchPadding()
                : 0;
            const boundsForCells = (!customBounds && typeof viewBounds.pad === 'function' && latLngPadding > 0)
                ? viewBounds.pad(latLngPadding)
                : viewBounds;
            const gridRadius = getFetchGridRadius();
            const requiredCells = global.getRequiredGridCells ? global.getRequiredGridCells(boundsForCells, gridRadius) : new Set();

            // Find missing cells
            const missingCells = [];
            for (const cell of requiredCells) {
                if (!cache?.grid?.has(cell)) {
                    missingCells.push(cell);
                }
            }

            if (missingCells.length === 0) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus('Parcels up to date.');
                }
                return;
            }

            const totalCells = missingCells.length;
            let completedCells = 0;
            let totalFeaturesIngested = 0;

            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Fetching data for ${totalCells} new grid cells (0/${totalCells})...`);
            }

            // Fetch and ingest each cell as it completes (streaming approach)
            const fetchPromises = missingCells.map(async (cell) => {
                const [gridEasting, gridNorthing] = cell.split(',').map(Number);
                const swEasting = gridEasting * cache.gridSize;
                const swNorthing = gridNorthing * cache.gridSize;
                const neEasting = (gridEasting + 1) * cache.gridSize;
                const neNorthing = (gridNorthing + 1) * cache.gridSize;
                const bbox = `${swEasting},${swNorthing},${neEasting},${neNorthing}`;
                const swLatLng = datasetToLatLng(swEasting, swNorthing);
                const neLatLng = datasetToLatLng(neEasting, neNorthing);
                const latLonBbox = (function () {
                    const latValues = [swLatLng[0], neLatLng[0]].filter(Number.isFinite);
                    const lonValues = [swLatLng[1], neLatLng[1]].filter(Number.isFinite);
                    if (latValues.length < 2 || lonValues.length < 2) return null;
                    const minLat = Math.min(latValues[0], latValues[1]);
                    const maxLat = Math.max(latValues[0], latValues[1]);
                    const minLon = Math.min(lonValues[0], lonValues[1]);
                    const maxLon = Math.max(lonValues[0], lonValues[1]);
                    return `${minLon},${minLat},${maxLon},${maxLat}`;
                })();

                const builder = (typeof global.buildParcelRequestParams === 'function') ? global.buildParcelRequestParams : null;
                let allFeatures = [];
                let startIndex = 0;
                const count = 2000;
                let more = true;
                let requestInfo = null;

                while (more) {
                    const req = builder ? builder(bbox, { count, startIndex, latLonBbox }) : null;
                    requestInfo = req; // Store for later use
                    const useParcelBa = req && req.source === 'parcel-ba';
                    const useParcelBg = req && req.source === 'parcel-bg';
                    const disablePagination = req && req.disablePagination;
                    const url = req ? req.url : (function () {
                        const baseUrl = OSS_PARCEL_WFS_BASE_URL;
                        return `${baseUrl}?${new URLSearchParams({
                            token: OSS_PUBLIC_ACCESS_TOKEN,
                            service: 'WFS',
                            version: '2.0.0',
                            request: 'GetFeature',
                            outputFormat: 'json',
                            typeName: 'oss:DKP_CESTICE',
                            srsName: 'EPSG:3765',
                            bbox: bbox,
                            count: String(count),
                            startIndex: String(startIndex)
                        }).toString()}`;
                    })();

                    let data;
                    if (useParcelBa || useParcelBg) {
                        const response = await fetch(url);
                        if (response.status === 404) {
                            data = { features: [], numberReturned: 0 };
                            more = false;
                        } else {
                            if (!response.ok) {
                                throw new Error(`Failed fetch ${response.status}`);
                            }
                            data = await response.json();
                        }
                    } else {
                        const response = await global.fetchWithRetry(url);
                        data = await response.json();
                    }

                    const features = Array.isArray(data.features) ? data.features : [];
                    allFeatures = allFeatures.concat(features);
                    const numberReturned = Number(data.numberReturned || features.length);
                    const numberMatched = Number(data.numberMatched);

                    if (useParcelBg || disablePagination) {
                        more = false;
                    } else if (Number.isFinite(numberMatched) && numberMatched > 0) {
                        more = startIndex + numberReturned < numberMatched && numberReturned > 0;
                    } else {
                        more = numberReturned === count && numberReturned > 0;
                    }
                    startIndex += numberReturned;
                }

                // Cache the cell data
                cache.grid.set(cell, { type: 'FeatureCollection', features: allFeatures });

                // Ingest immediately - no waiting for other cells
                if (allFeatures.length > 0) {
                    // Determine if we should skip conversion (backend returns WGS84)
                    const skipConversion = requestInfo && requestInfo.returnsWGS84 === true;
                    if (!skipConversion && typeof console !== 'undefined' && console.log) {
                        console.log('Parcel fetch: converting to WGS84 for cell', cell);
                    }
                    await ingestParcelFeatures(allFeatures, { skipConversion, replaceExisting: false, skipExisting: true });
                    totalFeaturesIngested += allFeatures.length;
                }

                completedCells++;
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus(`Fetching data for ${totalCells} new grid cells (${completedCells}/${totalCells})...`);
                }
            });

            // Wait for all fetches to complete
            const results = await Promise.allSettled(fetchPromises);
            results
                .filter(r => r.status === 'rejected')
                .forEach(r => console.error('Failed to fetch parcel grid cell:', r.reason));

            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Loaded ${totalFeaturesIngested} parcels from ${completedCells} cells.`);
            }

            // Force a redraw regardless of size change (Leaflet invalidateSize recalculates and repaints even at same size)
            if (typeof map !== 'undefined' && map && map.invalidateSize && map._loaded) {
                requestAnimationFrame(() => {
                    try { map.invalidateSize(); } catch (_) { }
                });
                setTimeout(() => {
                    try { map.invalidateSize(); } catch (_) { }
                }, 80);
            }

            // Nudge layout the same way a tiny window resize would, to fix grey map tiles without refetching
            if (typeof global.dispatchEvent === 'function' && typeof Event !== 'undefined' && map && map._loaded) {
                const resizeEvent = new Event('resize');
                requestAnimationFrame(() => {
                    try { global.dispatchEvent(resizeEvent); } catch (_) { }
                });
                setTimeout(() => {
                    try { global.dispatchEvent(resizeEvent); } catch (_) { }
                }, 120);
            }

            // Clean up ancestor parcels from applied proposals that may have been re-added
            const tAncestorStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            await removeAncestorParcelsFromAppliedProposals();
            const ancestorMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tAncestorStart;
            if (typeof console !== 'undefined' && console.log) {
                console.log(`[fetchParcelData] Ancestor cleanup took ${ancestorMs.toFixed ? ancestorMs.toFixed(1) : ancestorMs}ms`);
            }
        } finally {
            global._fetchParcelDataInProgress = false;
            if (global.ParcelsState && global.ParcelsState.setIsFetchingParcels) {
                global.ParcelsState.setIsFetchingParcels(false);
            }
        }
    }

    function resolveParcelLayerById(parcelId) {
        if (typeof global.resolveParcelLayerById === 'function' && global.resolveParcelLayerById !== resolveParcelLayerById) {
            return global.resolveParcelLayerById(parcelId);
        }
        return null;
    }

    async function fetchSingleParcelById(parcelId, options = {}) {
        const normalizedId = parcelId !== undefined && parcelId !== null ? parcelId.toString() : null;
        if (!normalizedId) return null;

        const forceRefresh = options.forceRefresh === true;
        const existing = global.resolveParcelLayerById ? global.resolveParcelLayerById(normalizedId) : null;
        if (existing && !forceRefresh) {
            return existing;
        }
        if (forceRefresh && existing && typeof global.removeParcelLayerById === 'function') {
            global.removeParcelLayerById(normalizedId);
        }

        global.setParcelMergeInProgressState(true);
        try {
            const rawFeatures = await fetchParcelFeaturesByIds([normalizedId]);
            if (!rawFeatures.length) {
                throw new Error(`Parcel ${normalizedId} could not be fetched from the upstream data source.`);
            }
            await ingestParcelFeatures(rawFeatures, { replaceExisting: true });
            return global.resolveParcelLayerById ? global.resolveParcelLayerById(normalizedId) : null;
        } finally {
            global.setParcelMergeInProgressState(false);
        }
    }

    async function fetchParcelsByIds(parcelIds, options = {}) {
        if (!Array.isArray(parcelIds) || parcelIds.length === 0) {
            return [];
        }
        const normalizedIds = parcelIds
            .map(value => value !== undefined && value !== null ? value.toString() : null)
            .filter(Boolean);
        if (!normalizedIds.length) {
            return [];
        }

        const forceRefresh = options.forceRefresh === true;
        const missing = [];
        normalizedIds.forEach(id => {
            const existing = global.resolveParcelLayerById ? global.resolveParcelLayerById(id) : null;
            if (!existing || forceRefresh) {
                if (forceRefresh && existing && typeof global.removeParcelLayerById === 'function') {
                    global.removeParcelLayerById(id);
                }
                if (!missing.includes(id)) {
                    missing.push(id);
                }
            }
        });

        if (missing.length) {
            global.setParcelMergeInProgressState(true);
            try {
                const rawFeatures = await fetchParcelFeaturesByIds(missing, {
                    onProgress: (current, total) => {
                        if (options && typeof options.onProgress === 'function') {
                            options.onProgress(current, total);
                        }
                    }
                });
                if (rawFeatures.length) {
                    await ingestParcelFeatures(rawFeatures, { replaceExisting: true });
                }
            } finally {
                global.setParcelMergeInProgressState(false);
            }
        }

        return normalizedIds.map(id => global.resolveParcelLayerById ? global.resolveParcelLayerById(id) : null).filter(Boolean);
    }

    async function fetchParcelFeaturesByIds(parcelIds, options = {}) {
        const normalizedIds = Array.from(new Set(
            (Array.isArray(parcelIds) ? parcelIds : [])
                .map(value => value !== undefined && value !== null ? value.toString() : null)
                .filter(Boolean)
        ));
        if (!normalizedIds.length) {
            return [];
        }

        const batches = [];
        for (let i = 0; i < normalizedIds.length; i += DIRECT_PARCEL_FETCH_BATCH_SIZE) {
            batches.push(normalizedIds.slice(i, i + DIRECT_PARCEL_FETCH_BATCH_SIZE));
        }

        const collected = [];
        let processedCount = 0;
        const totalCount = normalizedIds.length;

        for (const batch of batches) {
            const features = await requestParcelBatchForCurrentCity(batch);
            collected.push(...features);

            processedCount += batch.length;
            if (options && typeof options.onProgress === 'function') {
                options.onProgress(processedCount, totalCount);
            }
        }

        const deduped = [];
        const seen = new Set();
        collected.forEach(feature => {
            const id = normalizeFeatureParcelId(feature);
            if (!id) {
                return;
            }
            const key = id;
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            deduped.push(feature);
        });
        return deduped;
    }

    function isProdHost() {
        try {
            const host = (global.location && global.location.hostname) ? global.location.hostname.toLowerCase() : '';
            return /urbangametheory\.xyz$/.test(host);
        } catch (_) {
            return false;
        }
    }

    async function requestParcelBatchForCurrentCity(ids) {
        const dataSource = typeof global.getCurrentDataSource === 'function' ? global.getCurrentDataSource() : null;
        const currentCityId = (typeof global.getCurrentCityId === 'function') ? global.getCurrentCityId() : null;

        // City-specific routes first
        if (currentCityId === 'buenos_aires') {
            return requestParcelBatchFromParcelBa(ids);
        }

        // Force backend on production hosts or when data source is backend/localhost
        const forceBackend = isProdHost() || dataSource === 'api.urbangametheory.xyz' || dataSource === 'localhost';
        if (forceBackend) {
            return requestParcelBatchFromBackend(ids);
        }

        // Fallback to OSS only when explicitly selected
        if (dataSource === 'oss.uredjenazemlja.hr') {
            return requestParcelBatchFromOss(ids);
        }

        // Default to backend
        return requestParcelBatchFromBackend(ids);
    }

    async function requestParcelBatchFromOss(ids) {
        if (!Array.isArray(ids) || ids.length === 0) {
            return [];
        }
        const filterXml = buildParcelFilterXml(ids);
        const params = new URLSearchParams({
            service: 'WFS',
            version: '2.0.0',
            request: 'GetFeature',
            outputFormat: 'json',
            typeName: 'oss:DKP_CESTICE',
            srsName: 'EPSG:3765'
        });
        if (OSS_PUBLIC_ACCESS_TOKEN) {
            params.set('token', OSS_PUBLIC_ACCESS_TOKEN);
        }
        if (filterXml) {
            params.set('FILTER', filterXml);
        }
        const url = `${OSS_PARCEL_WFS_BASE_URL}?${params.toString()}`;
        const response = await global.fetchWithRetry(url, { headers: { 'Accept': 'application/json' } }, 2, 800);
        if (!response || !response.ok) {
            console.warn('requestParcelBatchFromOss: non-200 response', response && response.status);
            return [];
        }
        const contentType = response.headers ? response.headers.get('content-type') : null;
        try {
            const payload = await response.json();
            const features = Array.isArray(payload?.features) ? payload.features : [];
            return features;
        } catch (err) {
            // OSS may return XML ExceptionReport when auth/rate issues happen; avoid killing caller.
            const snippet = await response.text().catch(() => '') || '';
            console.warn('requestParcelBatchFromOss: failed to parse JSON payload', err, snippet.slice(0, 200));
            return [];
        }
    }

    async function requestParcelBatchFromLocalhost(ids) {
        const normalizedIds = Array.isArray(ids) ? ids.map(value => value !== undefined && value !== null ? value.toString() : null).filter(Boolean) : [];
        if (!normalizedIds.length) {
            return [];
        }
        const backendBase = (function () {
            try {
                if (typeof global.getBackendBase === 'function') {
                    const base = global.getBackendBase();
                    if (base && typeof base === 'string') {
                        return base.replace(/\/$/, '');
                    }
                }
            } catch (_) { }
            return 'http://localhost:3000';
        })();

        const aggregated = [];
        const hrLikeIds = normalizedIds.filter(id => /^HR-\d+-/.test(id));
        for (const chunk of chunkArray(hrLikeIds, BACKEND_PARCEL_IDS_CHUNK_SIZE)) {
            const search = new URLSearchParams({ ids: chunk.join(',') });
            const url = `${backendBase}/parcels/parcelIds?${search.toString()}`;
            try {
                const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!response.ok) {
                    console.warn(`parcelIds request failed (localhost): ${response.status}`);
                    continue;
                }
                const payload = await response.json();
                if (Array.isArray(payload?.features)) {
                    aggregated.push(...payload.features);
                }
            } catch (error) {
                console.warn('parcelIds request error (localhost)', error);
            }
        }

        return aggregated;
    }

    async function requestParcelBatchFromBackend(ids) {
        const normalizedIds = Array.isArray(ids) ? ids.map(value => value !== undefined && value !== null ? value.toString() : null).filter(Boolean) : [];
        if (!normalizedIds.length) {
            return [];
        }
        const backendBase = (function () {
            try {
                if (typeof global.getBackendBase === 'function') {
                    const base = global.getBackendBase();
                    if (base && typeof base === 'string') {
                        return base.replace(/\/$/, '');
                    }
                }
            } catch (_) { }
            return 'https://api.urbangametheory.xyz';
        })();

        const aggregated = [];
        const hrLikeIds = normalizedIds.filter(id => /^HR-\d+-/.test(id));

        for (const chunk of chunkArray(hrLikeIds, BACKEND_PARCEL_IDS_CHUNK_SIZE)) {
            const search = new URLSearchParams({ ids: chunk.join(',') });
            const url = `${backendBase}/parcels/parcelIds?${search.toString()}`;
            try {
                const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
                if (!response.ok) {
                    console.warn(`backend parcelIds request failed: ${response.status}`);
                    continue;
                }
                const payload = await response.json();
                if (Array.isArray(payload?.features)) {
                    aggregated.push(...payload.features);
                }
            } catch (error) {
                console.warn('backend parcelIds request error', error);
            }
        }

        return aggregated;
    }

    async function requestParcelBatchFromParcelBa(ids) {
        const normalizedIds = Array.isArray(ids) ? ids.map(value => value !== undefined && value !== null ? value.toString() : null).filter(Boolean) : [];
        if (!normalizedIds.length) {
            return [];
        }
        const backendBase = (function () {
            try {
                if (typeof global.getBackendBase === 'function') {
                    const base = global.getBackendBase();
                    if (base && typeof base === 'string') {
                        return base.replace(/\/$/, '');
                    }
                }
            } catch (_) { }
            return 'http://localhost:3000';
        })();

        const aggregated = [];
        for (let start = 0; start < normalizedIds.length; start += DIRECT_PARCEL_BACKEND_CHUNK_SIZE) {
            const chunk = normalizedIds.slice(start, start + DIRECT_PARCEL_BACKEND_CHUNK_SIZE);
            await Promise.all(chunk.map(async (smp) => {
                const search = new URLSearchParams({ smp });
                const url = `${backendBase}/parcel-ba?${search.toString()}`;
                try {
                    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
                    if (response.status === 404) return;
                    if (!response.ok) {
                        console.warn(`parcel-ba request failed for ${smp}: ${response.status}`);
                        return;
                    }
                    const payload = await response.json();
                    if (Array.isArray(payload?.features)) {
                        aggregated.push(...payload.features);
                    }
                } catch (error) {
                    console.warn(`parcel-ba request error for ${smp}`, error);
                }
            }));
        }

        return aggregated;
    }

    function buildParcelFilterXml(ids) {
        const clauses = (Array.isArray(ids) ? ids : [])
            .map(value => (value !== undefined && value !== null ? String(value).trim() : ''))
            .filter(Boolean)
            .map(id => `<PropertyIsEqualTo><PropertyName>parcel_id</PropertyName><Literal>${escapeXmlValue(id)}</Literal></PropertyIsEqualTo>`);
        if (!clauses.length) return '';
        if (clauses.length === 1) {
            return `<Filter>${clauses[0]}</Filter>`;
        }
        return `<Filter><Or>${clauses.join('')}</Or></Filter>`;
    }

    function escapeXmlValue(value) {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    const ingestParcelFeatures = global.ingestParcelFeatures || function () {
        throw new Error('ingestParcelFeatures is not available');
    };

    async function refreshParcelDataWithBusyState(customBounds) {
        const button = document.getElementById('refreshParcelDataButton');
        const task = () => fetchParcelData(customBounds);
        if (button && typeof global.runWithButtonBusyState === 'function') {
            return global.runWithButtonBusyState(button, 'Refreshing...', task);
        }
        return task();
    }

    // Listen for newly loaded parcels and disable click handlers if drawing mode is active
    if (typeof global.addEventListener === 'function') {
        global.addEventListener('parcelDataLoaded', function () {
            const isDrawingMode = (typeof global.roadDrawingMode !== 'undefined' && global.roadDrawingMode) ||
                (typeof global.trackDrawingMode !== 'undefined' && global.trackDrawingMode);
            if (isDrawingMode && global.parcelLayer) {
                // Disable click handlers on all parcels (including newly loaded ones)
                global.parcelLayer.eachLayer(layer => {
                    layer.off('click');
                });
            }
        });
    }

    global.fetchParcelData = fetchParcelData;
    global.fetchSingleParcelById = fetchSingleParcelById;
    global.fetchParcelsByIds = fetchParcelsByIds;
    global.fetchParcelFeaturesByIds = fetchParcelFeaturesByIds;
    global.requestParcelBatchForCurrentCity = requestParcelBatchForCurrentCity;
    global.requestParcelBatchFromOss = requestParcelBatchFromOss;
    global.requestParcelBatchFromLocalhost = requestParcelBatchFromLocalhost;
    global.requestParcelBatchFromParcelBa = requestParcelBatchFromParcelBa;
    global.buildParcelFilterXml = buildParcelFilterXml;
    global.escapeXmlValue = escapeXmlValue;
    global.ingestParcelFeatures = ingestParcelFeatures;
    global.refreshParcelDataWithBusyState = refreshParcelDataWithBusyState;
})(typeof window !== 'undefined' ? window : globalThis);

