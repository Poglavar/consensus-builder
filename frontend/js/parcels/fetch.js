(function (global) {
    'use strict';

    const DIRECT_PARCEL_FETCH_BATCH_SIZE = 8;
    const DIRECT_PARCEL_BACKEND_CHUNK_SIZE = 4;
    const OSS_PARCEL_WFS_BASE_URL = 'https://oss.uredjenazemlja.hr/OssWebServices/wfs';
    const OSS_PUBLIC_ACCESS_TOKEN = global.OSS_PUBLIC_ACCESS_TOKEN || '7effb6395af73ee111123d3d1317471357a1f012d4df977d3ab05ebdc184a46e';

    const cityConfigManager = global.CityConfigManager || null;

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

    function fetchBoundsPadding() {
        return Number((typeof global !== 'undefined' && global.PARCEL_FETCH_LATLNG_PADDING !== undefined)
            ? global.PARCEL_FETCH_LATLNG_PADDING
            : 0.12);
    }

    function fetchGridRadius() {
        return Number((typeof global !== 'undefined' && global.PARCEL_FETCH_GRID_RADIUS !== undefined)
            ? global.PARCEL_FETCH_GRID_RADIUS
            : 0);
    }

    async function fetchParcelData(customBounds) {
        if (global.ParcelsState && global.ParcelsState.isFetchingParcels && global.ParcelsState.isFetchingParcels()) {
            return;
        }
        if (global.ParcelsState && global.ParcelsState.setIsFetchingParcels) {
            global.ParcelsState.setIsFetchingParcels(true);
        }
        global.setParcelMergeInProgressState(true);
        if (typeof global.updateStatus === 'function') {
            global.updateStatus('Fetching data...');
        }
        const cache = global.parcelCache || (global.ParcelsState && global.ParcelsState.getParcelCache && global.ParcelsState.getParcelCache());
        const newParcelIdsSet = new Set();
        try {
            const viewBounds = customBounds || global.map?.getBounds();
            if (!viewBounds) {
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus('Unable to determine map bounds for parcel fetch.');
                }
                return;
            }
            const latLngPadding = (!customBounds && typeof viewBounds.pad === 'function')
                ? fetchBoundsPadding()
                : 0;
            const boundsForCells = (!customBounds && typeof viewBounds.pad === 'function' && latLngPadding > 0)
                ? viewBounds.pad(latLngPadding)
                : viewBounds;
            const gridRadius = fetchGridRadius();
            const requiredCells = global.getRequiredGridCells ? global.getRequiredGridCells(boundsForCells, gridRadius) : new Set();
            const missingCells = new Set(requiredCells);
            for (const cell of requiredCells) {
                if (cache?.grid?.has(cell)) {
                    missingCells.delete(cell);
                }
            }
            if (missingCells.size > 0) {
                const totalCells = missingCells.size;
                let completedCells = 0;
                if (typeof global.updateStatus === 'function') {
                    global.updateStatus(`Fetching data for ${totalCells} new grid cells (0/${totalCells})...`);
                }
                const fetchPromises = Array.from(missingCells).map(async (cell) => {
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
                    while (more) {
                        const req = builder ? builder(bbox, { count, startIndex, latLonBbox }) : null;
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
                            try {
                                const response = await fetch(url);
                                if (response.status === 404) {
                                    data = { features: [], numberReturned: 0 };
                                    more = false;
                                } else {
                                    if (!response.ok) {
                                        const routeId = useParcelBg ? 'parcel-bg' : 'parcel-ba';
                                        throw new Error(`Failed ${routeId} fetch ${response.status}`);
                                    }
                                    data = await response.json();
                                }
                            } catch (error) {
                                const routeId = useParcelBg ? 'parcel-bg' : 'parcel-ba';
                                console.warn(`${routeId} fetch failed`, error);
                                throw error;
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
                    const cellData = { type: 'FeatureCollection', features: allFeatures };
                    cache.grid.set(cell, cellData);
                    completedCells++;
                    if (typeof global.updateStatus === 'function') {
                        global.updateStatus(`Fetching data for ${totalCells} new grid cells (${completedCells}/${totalCells})...`);
                    }
                    allFeatures.forEach(feature => {
                        const parcelId = feature?.properties?.CESTICA_ID;
                        if (parcelId !== undefined && parcelId !== null) {
                            newParcelIdsSet.add(String(parcelId));
                        }
                    });
                });
                const settledPromises = await Promise.allSettled(fetchPromises);
                settledPromises
                    .filter(p => p.status === 'rejected')
                    .forEach(p => console.error('Failed to fetch parcel grid cell:', p.reason));
            }

            global.setParcelMergeInProgressState(true);
            if (typeof global.updateStatus === 'function') {
                global.updateStatus('Merging parcel data...');
            }

            const existingParcelIds = new Set();
            if (global.parcelLayer) {
                global.parcelLayer.eachLayer(layer => {
                    const parcelId = layer.feature?.properties?.CESTICA_ID;
                    if (parcelId !== undefined && parcelId !== null) {
                        existingParcelIds.add(String(parcelId));
                    }
                });
            }

            const featuresMap = new Map();
            const serverParcelIds = new Set();
            const modifiedParcelSet = (typeof global.ProposalManager !== 'undefined' && typeof global.ProposalManager._getModifiedParcelsSet === 'function')
                ? global.ProposalManager._getModifiedParcelsSet()
                : (function () {
                    try {
                        const list = JSON.parse(global.PersistentStorage.getItem('modified_parcels') || '[]');
                        if (Array.isArray(list)) return new Set(list.map(String));
                    } catch (_) { }
                    return new Set();
                })();

            let storedGeometryCount = 0;
            let storedPropertiesCount = 0;
            let processedFeatureCount = 0;

            for (const cell of requiredCells) {
                const cellData = cache?.grid?.get(cell);
                if (!cellData || !Array.isArray(cellData.features)) continue;
                for (const feature of cellData.features) {
                    const parcelId = String(feature.properties.CESTICA_ID);
                    serverParcelIds.add(parcelId);
                    if (modifiedParcelSet.has(parcelId) || existingParcelIds.has(parcelId)) {
                        continue;
                    }
                    const storedGeometryStr = global.PersistentStorage.getItem(`parcel_${parcelId}_geometry`);
                    const storedPropertiesStr = global.PersistentStorage.getItem(`parcel_${parcelId}_properties`);
                    if (storedGeometryStr) {
                        try {
                            const storedGeometry = JSON.parse(storedGeometryStr);
                            feature.geometry = {
                                type: 'Polygon',
                                coordinates: [storedGeometry]
                            };
                            feature.properties.calculatedArea = global.calculateArea([storedGeometry]);
                            storedGeometryCount++;
                        } catch (e) { console.error(`Error parsing stored geometry for ${parcelId}:`, e); }
                    }
                    if (storedPropertiesStr) {
                        try {
                            const storedProperties = JSON.parse(storedPropertiesStr);
                            const originalCalculatedArea = feature.properties.calculatedArea;
                            feature.properties = { ...feature.properties, ...storedProperties };
                            if (originalCalculatedArea !== undefined && originalCalculatedArea !== null) {
                                feature.properties.calculatedArea = originalCalculatedArea;
                            }
                            storedPropertiesCount++;
                        } catch (e) { console.error(`Error parsing stored properties for ${parcelId}:`, e); }
                    }
                    featuresMap.set(parcelId, feature);
                    processedFeatureCount++;
                }
            }

            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Merging parcel data... (${processedFeatureCount} new, ${storedGeometryCount} from storage, ${storedPropertiesCount} stored properties)`);
            }

            const newFeatures = Array.from(featuresMap.values());
            await ingestParcelFeatures(newFeatures);

            if (typeof global.updateStatus === 'function') {
                global.updateStatus(`Loaded ${newFeatures.length} new parcels.`);
            }

            try {
                const allParcelIds = Array.from(new Set([...serverParcelIds, ...newParcelIdsSet]));
                global.PersistentStorage.setItem('last_loaded_parcel_ids', JSON.stringify(allParcelIds.slice(0, 5000)));
            } catch (_) { }
        } finally {
            if (global.ParcelsState && global.ParcelsState.setIsFetchingParcels) {
                global.ParcelsState.setIsFetchingParcels(false);
            }
            global.setParcelMergeInProgressState(false);
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
                const rawFeatures = await fetchParcelFeaturesByIds(missing);
                if (rawFeatures.length) {
                    await ingestParcelFeatures(rawFeatures, { replaceExisting: true });
                }
            } finally {
                global.setParcelMergeInProgressState(false);
            }
        }

        return normalizedIds.map(id => global.resolveParcelLayerById ? global.resolveParcelLayerById(id) : null).filter(Boolean);
    }

    async function fetchParcelFeaturesByIds(parcelIds) {
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
        for (const batch of batches) {
            const features = await requestParcelBatchForCurrentCity(batch);
            collected.push(...features);
        }

        const deduped = [];
        const seen = new Set();
        collected.forEach(feature => {
            const id = feature?.properties?.CESTICA_ID;
            if (id === undefined || id === null) {
                return;
            }
            const key = id.toString();
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            deduped.push(feature);
        });
        return deduped;
    }

    async function requestParcelBatchForCurrentCity(ids) {
        if (typeof global.getCurrentCityId === 'function' && global.getCurrentCityId() === 'buenos_aires') {
            return requestParcelBatchFromParcelBa(ids);
        }
        return requestParcelBatchFromOss(ids);
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
        const payload = await response.json();
        const features = Array.isArray(payload?.features) ? payload.features : [];
        return features;
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
            .map(value => value !== undefined && value !== null ? value.toString() : null)
            .filter(Boolean)
            .map(id => `<PropertyIsEqualTo><PropertyName>CESTICA_ID</PropertyName><Literal>${escapeXmlValue(id)}</Literal></PropertyIsEqualTo>`);
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

    async function ingestParcelFeatures(rawFeatures, options = {}) {
        if (!Array.isArray(rawFeatures) || rawFeatures.length === 0) {
            return [];
        }
        const converted = global.convertGeoJSON({
            type: 'FeatureCollection',
            features: rawFeatures
        });
        const convertedFeatures = Array.isArray(converted?.features) ? converted.features : [];
        if (!convertedFeatures.length) {
            return [];
        }

        if (typeof global.ensureParcelLayerInitialized === 'function') {
            global.ensureParcelLayerInitialized();
        }

        const addedLayers = [];
        const styleFeature = (feature) => {
            const parcelId = feature?.properties?.CESTICA_ID;
            const isRoad = global.PersistentStorage.getItem(`parcel_${parcelId}_isRoad`) === 'true';
            return global.getParcelBaseStyle(parcelId, { isRoad });
        };
        const attachParcelEvents = (feature, layer) => {
            layer.on({
                mouseover: typeof global.highlightFeature === 'function' ? global.highlightFeature : () => { },
                mouseout: typeof global.resetHighlight === 'function' ? global.resetHighlight : () => { },
                click: global.onParcelClick
            });
            if (layer.options) layer.options.interactive = true;
            if (typeof layer.setInteractive === 'function') {
                layer.setInteractive(true);
            }
        };

        const shouldReplace = options.replaceExisting !== false;

        convertedFeatures.forEach(feature => {
            const parcelId = feature?.properties?.CESTICA_ID;
            if (parcelId === undefined || parcelId === null) {
                return;
            }
            const normalizedId = parcelId.toString();
            if (shouldReplace && typeof global.removeParcelLayerById === 'function') {
                global.removeParcelLayerById(normalizedId);
            }
            L.geoJSON({
                type: 'FeatureCollection',
                features: [feature]
            }, {
                style: styleFeature,
                onEachFeature: attachParcelEvents
            }).eachLayer(layer => {
                global.parcelLayer.addLayer(layer);
                if (typeof global.indexParcelLayer === 'function') {
                    global.indexParcelLayer(layer);
                }
                const storedRoad = global.PersistentStorage.getItem(`parcel_${normalizedId}_isRoad`) === 'true';
                if (storedRoad) {
                    const roadName = global.PersistentStorage.getItem(`parcel_${normalizedId}_roadName`) || 'Unnamed Road';
                    layer.bindTooltip(roadName, {
                        permanent: false,
                        direction: 'center',
                        className: 'road-name-tooltip'
                    });
                    layer.feature.properties.isRoad = true;
                    layer.feature.properties.roadName = roadName;
                    layer.feature.properties.roadId = global.PersistentStorage.getItem(`parcel_${normalizedId}_roadId`) || '';
                    layer.feature.properties.roadConfidence =
                        global.PersistentStorage.getItem(`parcel_${normalizedId}_roadConfidence`) || '0';
                }
                addedLayers.push(layer);
            });
        });

        if (addedLayers.length) {
            if (global.ParcelsState && global.ParcelsState.bumpParcelCoverageVersion) {
                global.ParcelsState.bumpParcelCoverageVersion();
            }
            try {
                global.dispatchEvent(new CustomEvent('parcelCoverageUpdated', {
                    detail: {
                        version: global.parcelCoverageVersion,
                        source: 'id-fetch',
                        timestamp: Date.now()
                    }
                }));
            } catch (_) { }
            try {
                const parcelIds = convertedFeatures.map(feature => String(feature.properties.CESTICA_ID));
                global.dispatchEvent(new CustomEvent('parcelDataLoaded', {
                    detail: {
                        features: convertedFeatures,
                        parcelIds,
                        newFeatures: convertedFeatures,
                        newParcelIds: parcelIds
                    }
                }));
            } catch (_) { }
            if (typeof global.refreshParcelStylesForAppliedProposals === 'function') {
                global.refreshParcelStylesForAppliedProposals();
            }
            if (typeof global.updateVisibleParcelsCount === 'function') {
                global.updateVisibleParcelsCount();
            }
            if (typeof global.refreshParcelNumberLabelsIfVisible === 'function') {
                global.refreshParcelNumberLabelsIfVisible();
            }
        }

        return addedLayers;
    }

    async function refreshParcelDataWithBusyState(customBounds) {
        const button = document.getElementById('refreshParcelDataButton');
        const task = () => fetchParcelData(customBounds);
        if (button && typeof global.runWithButtonBusyState === 'function') {
            return global.runWithButtonBusyState(button, 'Refreshing...', task);
        }
        return task();
    }

    global.fetchParcelData = fetchParcelData;
    global.fetchSingleParcelById = fetchSingleParcelById;
    global.fetchParcelsByIds = fetchParcelsByIds;
    global.fetchParcelFeaturesByIds = fetchParcelFeaturesByIds;
    global.requestParcelBatchForCurrentCity = requestParcelBatchForCurrentCity;
    global.requestParcelBatchFromOss = requestParcelBatchFromOss;
    global.requestParcelBatchFromParcelBa = requestParcelBatchFromParcelBa;
    global.buildParcelFilterXml = buildParcelFilterXml;
    global.escapeXmlValue = escapeXmlValue;
    global.ingestParcelFeatures = ingestParcelFeatures;
    global.refreshParcelDataWithBusyState = refreshParcelDataWithBusyState;
})(typeof window !== 'undefined' ? window : globalThis);

