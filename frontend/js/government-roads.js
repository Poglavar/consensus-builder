(function () {
    let isFetchingGovernmentPlan = false;
    let cachedPlanCollection = null;
    let cachedPlanSource = null;
    let lastPlanDescriptor = null;
    let planLayer = null;
    let highlightEnabled = false;
    let mapListenersAttached = false;
    let renderTimeout = null;
    let lastSubtractGridKey = null;
    let lastSubtractBoundsSignature = null;
    let lastSubtractedPieces = null;

    function resetSubtractionCache() {
        lastSubtractGridKey = null;
        lastSubtractBoundsSignature = null;
        lastSubtractedPieces = null;
    }

    function describeBoundsSignature(bounds) {
        if (!bounds || typeof bounds.toBBoxString !== 'function') {
            return null;
        }
        try {
            return bounds.toBBoxString();
        } catch (_) {
            return null;
        }
    }

    function areParcelsVisibleAtCurrentZoom() {
        try {
            if (typeof window.isZoomWithinParcelRange === 'function') {
                return !!window.isZoomWithinParcelRange();
            }
        } catch (_) { }
        return true;
    }

    function describeSubtractGrid(bounds) {
        if (!bounds || typeof bounds.getCenter !== 'function' || typeof window.wgs84ToHTRS96 !== 'function') {
            return null;
        }
        try {
            const center = bounds.getCenter();
            const [easting, northing] = window.wgs84ToHTRS96(center.lat, center.lng);
            const gridSize = (window.parcelCache && window.parcelCache.gridSize) ? window.parcelCache.gridSize : 500;
            const gridE = Math.floor(easting / gridSize);
            const gridN = Math.floor(northing / gridSize);
            return `${gridE},${gridN}`;
        } catch (err) {
            console.warn('Failed to describe subtract grid', err);
            return null;
        }
    }

    const basePlanStyle = {
        color: '#c98a00',
        weight: 2,
        fillColor: '#ffd54f',
        fillOpacity: 0.35,
        opacity: 0.9,
        dashArray: '6 6',
        interactive: false
    };

    const highlightPlanStyle = {
        color: '#1c54b2',
        weight: 2,
        fillColor: '#4f83ff',
        fillOpacity: 0.6,
        opacity: 0.95,
        dashArray: '',
        interactive: false
    };

    const planCatalogState = {
        promise: null
    };
    const planGeoCache = new Map();

    function ensureMapReady() {
        if (typeof window === 'undefined' || typeof window.map === 'undefined' || !window.map) {
            throw new Error('Map is not initialized yet.');
        }
    }

    function getActiveMapBounds() {
        if (!window.map || typeof window.map.getBounds !== 'function') {
            return null;
        }
        return window.map.getBounds();
    }

    function getBboxFromBounds(bounds) {
        if (!bounds || typeof window.getBboxFromBounds !== 'function') {
            return '';
        }
        try {
            return window.getBboxFromBounds(bounds);
        } catch (err) {
            console.warn('Failed to obtain bbox from bounds.', err);
            return '';
        }
    }

    function buildBoundsPolygon(bounds) {
        if (!bounds || typeof turf === 'undefined') {
            return null;
        }
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const nw = bounds.getNorthWest();
        const se = bounds.getSouthEast();
        return turf.polygon([[
            [sw.lng, sw.lat],
            [se.lng, se.lat],
            [ne.lng, ne.lat],
            [nw.lng, nw.lat],
            [sw.lng, sw.lat]
        ]]);
    }

    function isPolygonGeometry(feature) {
        if (!feature || !feature.geometry) return false;
        const type = feature.geometry.type;
        if (type === 'Polygon' || type === 'MultiPolygon') {
            const coords = feature.geometry.coordinates;
            return Array.isArray(coords) && coords.length > 0;
        }
        return false;
    }

    function cloneFeatureSafely(feature) {
        try {
            return JSON.parse(JSON.stringify(feature));
        } catch (_) {
            return feature;
        }
    }

    function sanitizeFeatureCollection(collection) {
        if (!collection || typeof collection !== 'object') {
            return { type: 'FeatureCollection', features: [] };
        }
        const features = Array.isArray(collection.features) ? collection.features : [];
        const sanitized = [];
        for (const feature of features) {
            if (!isPolygonGeometry(feature)) continue;
            const clone = cloneFeatureSafely(feature);
            if (!isPolygonGeometry(clone)) continue;
            clone.properties = Object.assign({}, clone.properties || {});
            sanitized.push(clone);
        }
        return { type: 'FeatureCollection', features: sanitized };
    }

    function deepCloneFeatureCollection(collection) {
        try {
            return JSON.parse(JSON.stringify(collection));
        } catch (_) {
            return collection;
        }
    }

    function normalizeSingleFeature(feature, templateProps) {
        if (!feature) return null;
        let base = feature;
        if (feature.type !== 'Feature' && feature.geometry) {
            base = {
                type: 'Feature',
                geometry: feature.geometry,
                properties: {}
            };
        }
        if (!isPolygonGeometry(base)) {
            return null;
        }
        base.properties = Object.assign({}, base.properties || {}, templateProps || {});
        return base;
    }

    function normalizeFeatureLike(result, templateProps) {
        const output = [];
        if (!result) {
            return output;
        }
        if (result.type === 'FeatureCollection' && Array.isArray(result.features)) {
            result.features.forEach(f => {
                const normalized = normalizeSingleFeature(f, templateProps);
                if (normalized) {
                    output.push(normalized);
                }
            });
            return output;
        }
        const normalized = normalizeSingleFeature(result, templateProps);
        if (normalized) {
            output.push(normalized);
        }
        return output;
    }

    function describePlan(plan) {
        if (!plan) return null;
        const pieces = [];
        if (plan.planName) pieces.push(plan.planName);
        if (plan.planVersion) pieces.push(`v${plan.planVersion}`);
        if (plan.governmentName) pieces.push(plan.governmentName);
        return pieces.length ? pieces.join(' · ') : null;
    }

    function normalizePlanEntry(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const geometry = raw.plan_geometry || raw.geometry || null;
        if (!geometry || !geometry.type || !geometry.coordinates) return null;
        const dataSource = raw['data source'] || raw.data_source || raw.source || raw.url || '';
        if (!dataSource) return null;
        return {
            governmentName: raw.government_name || raw.governmentName || '',
            planName: raw.plan_name || raw.planName || '',
            planVersion: raw.plan_version || raw.planVersion || '',
            dataSource,
            geometry
        };
    }

    async function loadPlanCatalog() {
        if (planCatalogState.promise) {
            return planCatalogState.promise;
        }
        planCatalogState.promise = Promise.resolve().then(() => {
            try {
                if (typeof window === 'undefined') return [];
                const catalog = window.government_plans;
                if (!Array.isArray(catalog)) {
                    console.warn('government_plans global is missing or not an array.');
                    return [];
                }
                return catalog.map(normalizePlanEntry).filter(Boolean);
            } catch (err) {
                console.error('Unable to access government_plans catalog:', err);
                return [];
            }
        });
        return planCatalogState.promise;
    }

    function buildMapBoundsPolygon(bounds) {
        return buildBoundsPolygon(bounds);
    }

    async function selectPlanForBounds(bounds) {
        if (typeof turf === 'undefined') {
            console.warn('turf.js is required to select government plans.');
            return null;
        }
        const plans = await loadPlanCatalog();
        if (!plans.length) return null;
        const mapPolygon = buildMapBoundsPolygon(bounds);
        if (!mapPolygon) return null;

        let bestPlan = null;
        let bestOverlapArea = 0;

        for (const plan of plans) {
            const planFeature = turf.feature(plan.geometry);
            let intersects = false;
            try {
                intersects = turf.booleanIntersects(planFeature, mapPolygon);
            } catch (err) {
                console.warn('booleanIntersects failed for plan geometry.', err);
                continue;
            }
            if (!intersects) continue;

            let overlapArea = 0;
            try {
                const intersection = turf.intersect(planFeature, mapPolygon);
                overlapArea = intersection ? turf.area(intersection) : 1;
            } catch (err) {
                overlapArea = 1;
            }

            if (!bestPlan || overlapArea > bestOverlapArea) {
                bestPlan = plan;
                bestOverlapArea = overlapArea;
            }
        }

        return bestPlan;
    }

    function getCurrentDataSource() {
        if (typeof window.getCurrentDataSource === 'function') {
            return window.getCurrentDataSource();
        }
        return 'oss.uredjenazemlja.hr';
    }

    async function fetchPlanGeoJSON(plan) {
        if (!plan || !plan.dataSource) {
            throw new Error('Plan is missing data source URL.');
        }
        if (planGeoCache.has(plan.dataSource)) {
            return planGeoCache.get(plan.dataSource);
        }
        const promise = (async () => {
            const response = await fetch(plan.dataSource, { headers: { 'Accept': 'application/json' } });
            if (!response.ok) {
                throw new Error(`Failed to fetch plan data from ${plan.dataSource} (status ${response.status})`);
            }
            return response.json();
        })();
        planGeoCache.set(plan.dataSource, promise);
        try {
            return await promise;
        } catch (err) {
            planGeoCache.delete(plan.dataSource);
            throw err;
        }
    }

    function decoratePlanFeatures(collection, plan) {
        const features = Array.isArray(collection?.features) ? collection.features : [];
        const descriptor = describePlan(plan) || 'Government Plan';
        return {
            type: 'FeatureCollection',
            features: features
                .map(feature => {
                    if (!feature || !feature.geometry) return null;
                    const clone = JSON.parse(JSON.stringify(feature));
                    clone.properties = Object.assign({}, clone.properties, {
                        planStatus: (clone.properties && clone.properties.planStatus) || 'planned',
                        planName: clone.properties?.planName || plan?.planName || '',
                        planVersion: clone.properties?.planVersion || plan?.planVersion || '',
                        planGovernment: clone.properties?.planGovernment || plan?.governmentName || '',
                        source: clone.properties?.source || 'government_plan',
                        displayColor: clone.properties?.displayColor || basePlanStyle.fillColor,
                        strokeColor: clone.properties?.strokeColor || basePlanStyle.color,
                        strokeWeight: clone.properties?.strokeWeight || basePlanStyle.weight,
                        fillOpacity: typeof clone.properties?.fillOpacity === 'number'
                            ? clone.properties.fillOpacity
                            : basePlanStyle.fillOpacity,
                        descriptor
                    });
                    return clone;
                })
                .filter(Boolean)
        };
    }

    async function fetchGovernmentPlanFromCatalog(bounds) {
        const plan = await selectPlanForBounds(bounds);
        if (!plan) {
            return {
                collection: { type: 'FeatureCollection', features: [] },
                descriptor: null,
                source: 'catalog'
            };
        }
        const raw = await fetchPlanGeoJSON(plan);
        const decorated = decoratePlanFeatures(raw, plan);
        const projected = toLeafletGeoJSON(decorated);
        return {
            collection: projected,
            descriptor: describePlan(plan),
            source: 'catalog'
        };
    }

    async function fetchGovernmentPlanFromBackend(bounds) {
        const bbox = getBboxFromBounds(bounds);
        const builder = (typeof window.buildPlannedRoadRequestParams === 'function') ? window.buildPlannedRoadRequestParams : null;
        let request = null;
        if (builder) {
            request = builder(bbox || '');
        } else {
            const fallbackBase = (typeof window.getBackendBase === 'function') ? window.getBackendBase() : 'http://localhost:3000';
            const trimmed = typeof bbox === 'string' ? bbox.trim() : '';
            const url = trimmed ? `${fallbackBase}/planned-road?bbox=${encodeURIComponent(trimmed)}` : `${fallbackBase}/planned-road`;
            request = { url, base: fallbackBase };
        }
        if (!request || !request.url) {
            throw new Error('Unable to resolve backend endpoint for planned roads.');
        }
        const response = await fetch(request.url, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) {
            throw new Error(`Failed to fetch planned roads (status ${response.status})`);
        }
        const json = await response.json();
        const projected = toLeafletGeoJSON(json);
        return {
            collection: projected,
            descriptor: null,
            source: 'backend'
        };
    }

    async function fetchGovernmentPlan(bounds) {
        const dataSource = getCurrentDataSource();
        if (dataSource === 'localhost' || dataSource === 'api.urbangametheory.xyz') {
            return fetchGovernmentPlanFromBackend(bounds);
        }
        return fetchGovernmentPlanFromCatalog(bounds);
    }

    function toLeafletGeoJSON(rawData) {
        if (!rawData) return { type: 'FeatureCollection', features: [] };
        let geojson = rawData;
        try {
            if (typeof window.convertGeoJSON === 'function') {
                geojson = window.convertGeoJSON(rawData) || rawData;
            }
        } catch (err) {
            console.warn('convertGeoJSON failed for planned roads, using original data.', err);
            geojson = rawData;
        }
        if (!geojson || !Array.isArray(geojson.features)) {
            return { type: 'FeatureCollection', features: [] };
        }
        return geojson;
    }

    function clearGovernmentRoadPlanLayer() {
        if (planLayer && window.map) {
            try { window.map.removeLayer(planLayer); } catch (_) { }
        }
        planLayer = null;
        try { window.governmentRoadPlanLayer = null; } catch (_) { }
    }

    function setPlanLayerFeatures(features, useHighlightStyle) {
        clearGovernmentRoadPlanLayer();
        if (!Array.isArray(features) || !features.length) {
            return;
        }
        planLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
            style: () => (useHighlightStyle ? highlightPlanStyle : basePlanStyle)
        }).addTo(window.map);
        try { planLayer.bringToFront(); } catch (_) { }
        try { window.governmentRoadPlanLayer = planLayer; } catch (_) { }
    }

    function isRoadParcelProperties(props) {
        const normalizedCategory = typeof props?.category === 'string' ? props.category.toLowerCase() : '';
        const normalizedCurrent = typeof props?.current === 'string' ? props.current.toLowerCase() : '';
        const explicitRoadFlag = props?.isRoad === true
            || props?.isRoad === 'true'
            || props?.road === true
            || props?.road === 'true'
            || normalizedCurrent === 'road'
            || normalizedCategory === 'road';
        const storedRoadFlag = (typeof window.isRoad === 'function' && props?.CESTICA_ID)
            ? window.isRoad(props.CESTICA_ID)
            : false;
        return explicitRoadFlag || storedRoadFlag;
    }

    function collectRoadParcelsInView(bounds) {
        const features = [];
        if (!window.parcelLayer || typeof window.parcelLayer.eachLayer !== 'function') {
            return features;
        }
        window.parcelLayer.eachLayer(layer => {
            if (!layer || typeof layer.toGeoJSON !== 'function' || typeof layer.getBounds !== 'function') {
                return;
            }
            let intersects = true;
            try {
                const layerBounds = layer.getBounds();
                intersects = layerBounds && layerBounds.isValid && layerBounds.isValid() && layerBounds.intersects(bounds);
            } catch (_) { }
            if (!intersects) return;
            const feature = layer.toGeoJSON();
            if (!isPolygonGeometry(feature)) return;
            if (!isRoadParcelProperties(feature.properties || {})) return;
            features.push(cloneFeatureSafely(feature));
        });
        return features;
    }

    function safeUnion(base, addition) {
        if (typeof turf === 'undefined') return base;
        try {
            const result = turf.union(base, addition);
            return result || base;
        } catch (err) {
            console.warn('turf.union failed, keeping existing geometry.', err);
            return base;
        }
    }

    function unionFeatures(features) {
        if (!Array.isArray(features) || !features.length) {
            return null;
        }
        if (typeof turf === 'undefined') {
            return null;
        }
        let unionFeature = null;
        for (const feature of features) {
            unionFeature = unionFeature ? safeUnion(unionFeature, feature) : feature;
        }
        return unionFeature;
    }

    function computePlanPiecesForView(bounds, options) {
        const opts = Object.assign({ subtractRoads: false }, options || {});
        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features)) {
            return [];
        }
        if (typeof turf === 'undefined') {
            return cachedPlanCollection.features.slice();
        }

        const mapPolygon = buildBoundsPolygon(bounds);
        const subtractRoads = !!opts.subtractRoads;
        let roadUnion = null;
        if (subtractRoads) {
            const roadParcels = collectRoadParcelsInView(bounds);
            roadUnion = unionFeatures(roadParcels);
        }

        const pieces = [];
        for (const planFeature of cachedPlanCollection.features) {
            if (!isPolygonGeometry(planFeature)) continue;
            let workingFeature = planFeature;
            if (mapPolygon) {
                try {
                    const intersection = turf.intersect(planFeature, mapPolygon);
                    if (!intersection) {
                        continue;
                    }
                    workingFeature = intersection;
                } catch (err) {
                    console.warn('turf.intersect failed for plan feature; using original geometry.', err);
                }
            }
            const clippedPieces = normalizeFeatureLike(workingFeature, planFeature.properties);
            if (!clippedPieces.length) {
                continue;
            }
            if (!subtractRoads || !roadUnion) {
                pieces.push(...clippedPieces);
                continue;
            }
            for (const piece of clippedPieces) {
                try {
                    const diff = turf.difference(piece, roadUnion);
                    if (!diff) {
                        continue;
                    }
                    const diffPieces = normalizeFeatureLike(diff, piece.properties);
                    if (diffPieces.length) {
                        pieces.push(...diffPieces);
                    }
                } catch (err) {
                    console.warn('Failed to subtract road parcels from plan piece.', err);
                    pieces.push(piece);
                }
            }
        }
        return pieces;
    }

    function renderGovernmentPlanForView(options) {
        const opts = Object.assign({ subtractRoads: false, skipStatus: false, statusMessage: null }, options || {});
        const bounds = getActiveMapBounds();
        if (!bounds) {
            clearGovernmentRoadPlanLayer();
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Unable to determine map bounds for government plans.');
            }
            return;
        }
        const parcelsVisible = areParcelsVisibleAtCurrentZoom();
        const subtractAllowed = opts.subtractRoads && parcelsVisible;
        const rawStatusMessage = typeof opts.statusMessage === 'string' ? opts.statusMessage.trim() : '';
        const statusSuffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
        const usingCustomStatus = !!rawStatusMessage && !opts.skipStatus && typeof window.updateStatus === 'function';
        const statusPrefix = usingCustomStatus ? `${rawStatusMessage}${statusSuffix}` : '';

        if (usingCustomStatus) {
            window.updateStatus(`${statusPrefix}…`);
        }
        const boundsSignature = describeBoundsSignature(bounds);
        let pieces;
        if (subtractAllowed) {
            const gridKey = describeSubtractGrid(bounds);
            if (gridKey && lastSubtractGridKey === gridKey && lastSubtractBoundsSignature === boundsSignature && Array.isArray(lastSubtractedPieces)) {
                pieces = lastSubtractedPieces;
            } else {
                pieces = computePlanPiecesForView(bounds, { subtractRoads: true });
                lastSubtractGridKey = gridKey;
                lastSubtractBoundsSignature = boundsSignature;
                lastSubtractedPieces = pieces;
            }
        } else {
            pieces = computePlanPiecesForView(bounds, { subtractRoads: false });
            resetSubtractionCache();
            lastSubtractBoundsSignature = boundsSignature;
        }

        setPlanLayerFeatures(pieces, subtractAllowed);
        if (!opts.skipStatus && typeof window.updateStatus === 'function') {
            if (usingCustomStatus) {
                let finalMessage;
                const base = `${statusPrefix} done.`;
                if (!pieces.length) {
                    finalMessage = `${base} No government plan segments remain in this view.`;
                } else if (opts.subtractRoads) {
                    if (subtractAllowed) {
                        finalMessage = `${base} Highlighted ${pieces.length} planned segment piece(s) needing roads.`;
                    } else {
                        finalMessage = `${base} Government plan drawn without subtraction at this zoom. Zoom in to see highlight differences.`;
                    }
                } else {
                    const sourceLabel = cachedPlanSource || 'catalog';
                    finalMessage = `${base} Government road plan drawn: ${pieces.length} feature(s) from ${sourceLabel}.`;
                }
                window.updateStatus(finalMessage);
                return;
            }

            const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
            if (!pieces.length) {
                window.updateStatus(`No government plan segments remain in this view${suffix}.`);
            } else if (opts.subtractRoads) {
                if (subtractAllowed) {
                    window.updateStatus(`Highlighted ${pieces.length} planned segment piece(s) needing roads${suffix}.`);
                } else {
                    window.updateStatus(`Government plan drawn without subtraction at this zoom${suffix}. Zoom in to see highlight differences.`);
                }
            } else {
                const sourceLabel = cachedPlanSource || 'catalog';
                window.updateStatus(`Government road plan drawn${suffix}: ${pieces.length} feature(s) from ${sourceLabel}.`);
            }
        }
    }

    function scheduleRenderGovernmentPlan(options) {
        const opts = Object.assign({ subtractRoads: highlightEnabled, skipStatus: true, statusMessage: null }, options || {});
        if (renderTimeout) {
            clearTimeout(renderTimeout);
        }
        renderTimeout = setTimeout(() => {
            renderTimeout = null;
            renderGovernmentPlanForView(opts);
        }, 75);
    }

    function attachMapViewportListeners() {
        if (mapListenersAttached || !window.map || typeof window.map.on !== 'function') {
            return;
        }
        const handler = () => scheduleRenderGovernmentPlan({ subtractRoads: highlightEnabled, skipStatus: true });
        try {
            window.map.on('moveend', handler);
            window.map.on('zoomend', handler);
            mapListenersAttached = true;
        } catch (err) {
            console.warn('Unable to register government road map listeners.', err);
        }
    }

    async function drawGovernmentRoadPlan(options) {
        const opts = Object.assign({ forceRefetch: false, skipStatus: false }, options || {});
        if (isFetchingGovernmentPlan) {
            return;
        }
        try {
            ensureMapReady();
        } catch (err) {
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Map is not ready yet. Please wait.');
            }
            console.warn(err.message);
            return;
        }

        const bounds = getActiveMapBounds();
        if (!bounds) {
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Unable to determine map bounds for government plans.');
            }
            return;
        }

        if (!opts.skipStatus && typeof window.updateStatus === 'function') {
            window.updateStatus('Fetching government road plan...');
        }

        isFetchingGovernmentPlan = true;
        try {
            const result = await fetchGovernmentPlan(bounds);
            const sanitized = sanitizeFeatureCollection(result.collection);
            cachedPlanCollection = deepCloneFeatureCollection(sanitized);
            cachedPlanSource = result.source || null;
            lastPlanDescriptor = result.descriptor || null;
            if (!Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
                clearGovernmentRoadPlanLayer();
                if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                    window.updateStatus('No government plan segments overlap this view.');
                }
                highlightEnabled = false;
                const toggle = document.getElementById('applyGovernmentRoadPlanToggle');
                if (toggle) {
                    toggle.checked = false;
                }
                try { window.governmentRoadPlanLastDescriptor = () => lastPlanDescriptor; } catch (_) { }
                return;
            }

            attachMapViewportListeners();
            renderGovernmentPlanForView({ subtractRoads: highlightEnabled, skipStatus: opts.skipStatus });
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
                window.updateStatus(`Government road plan loaded${suffix}.`);
            }
        } catch (error) {
            console.error('Failed to draw government road plan:', error);
            clearGovernmentRoadPlanLayer();
            if (!opts.skipStatus && typeof window.updateStatus === 'function') {
                window.updateStatus('Failed to draw government road plan. Check console for details.');
            }
        } finally {
            isFetchingGovernmentPlan = false;
        }
    }

    async function applyGovernmentRoadPlan(options) {
        const opts = Object.assign({ skipStatus: false }, options || {});
        highlightEnabled = true;
        const toggle = document.getElementById('applyGovernmentRoadPlanToggle');
        if (toggle) {
            toggle.checked = true;
        }
        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
            await drawGovernmentRoadPlan({ skipStatus: opts.skipStatus });
            return;
        }
        renderGovernmentPlanForView({ subtractRoads: true, skipStatus: opts.skipStatus });
    }

    function clearGovernmentRoadPlanDiffLayer() {
        highlightEnabled = false;
        resetSubtractionCache();
        const toggle = document.getElementById('applyGovernmentRoadPlanToggle');
        if (toggle) {
            toggle.checked = false;
        }
        if (cachedPlanCollection && Array.isArray(cachedPlanCollection.features) && cachedPlanCollection.features.length) {
            renderGovernmentPlanForView({ subtractRoads: false, skipStatus: true });
        } else {
            clearGovernmentRoadPlanLayer();
        }
        try { window.governmentRoadPlanDiffLayer = null; } catch (_) { }
    }

    function handleHighlightToggleChange(event) {
        const enabled = !!(event && event.target && event.target.checked);
        highlightEnabled = enabled;
        if (!cachedPlanCollection || !Array.isArray(cachedPlanCollection.features) || !cachedPlanCollection.features.length) {
            if (enabled) {
                applyGovernmentRoadPlan();
            }
            return;
        }
        if (enabled) {
            if (typeof window.updateStatus === 'function') {
                const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
                window.updateStatus(`Government plan highlights enabled${suffix}. Calculating overlaps...`);
            }
            renderGovernmentPlanForView({ subtractRoads: true, skipStatus: true });
        } else {
            if (typeof window.updateStatus === 'function') {
                window.updateStatus('Government plan highlights disabled.');
            }
            renderGovernmentPlanForView({ subtractRoads: false, skipStatus: true });
        }
    }

    function onParcelDataLoaded() {
        resetSubtractionCache();
        if (!highlightEnabled) {
            return;
        }
        scheduleRenderGovernmentPlan({ subtractRoads: true, skipStatus: true });
    }

    function onParcelRoadStatusChanged() {
        resetSubtractionCache();
        if (!highlightEnabled) {
            return;
        }
        scheduleRenderGovernmentPlan({
            subtractRoads: true,
            skipStatus: false,
            statusMessage: 'Recalculating government plan highlights'
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        try { window.addEventListener('parcelDataLoaded', onParcelDataLoaded); } catch (_) { }
        try { window.addEventListener('parcelRoadStatusChanged', onParcelRoadStatusChanged); } catch (_) { }

        const drawButton = document.getElementById('drawGovernmentRoadPlanButton');
        if (drawButton) {
            drawButton.addEventListener('click', () => {
                drawGovernmentRoadPlan();
            });
        }

        const highlightToggle = document.getElementById('applyGovernmentRoadPlanToggle');
        if (highlightToggle) {
            highlightToggle.addEventListener('change', handleHighlightToggleChange);
        }
    });

    window.drawGovernmentRoadPlan = drawGovernmentRoadPlan;
    window.applyGovernmentRoadPlan = applyGovernmentRoadPlan;
    window.clearGovernmentRoadPlanLayer = clearGovernmentRoadPlanLayer;
    window.clearGovernmentRoadPlanDiffLayer = clearGovernmentRoadPlanDiffLayer;
    window.governmentRoadPlanLastDescriptor = () => lastPlanDescriptor;
})();
