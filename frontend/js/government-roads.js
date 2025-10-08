(function () {
    let governmentRoadPlanLayer = null;
    let isFetchingGovernmentPlan = false;
    let lastPlanDescriptor = null;

    const defaultStyle = {
        color: '#c98a00',
        weight: 2,
        fillColor: '#ffd54f',
        fillOpacity: 0.35,
        opacity: 0.9,
        dashArray: '6 6',
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

    function clearGovernmentRoadPlanLayer() {
        if (governmentRoadPlanLayer && window.map) {
            try { window.map.removeLayer(governmentRoadPlanLayer); } catch (_) { }
        }
        governmentRoadPlanLayer = null;
        try { window.governmentRoadPlanLayer = null; } catch (_) { }
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

    function describePlan(plan) {
        if (!plan) return null;
        const pieces = [];
        if (plan.planName) pieces.push(plan.planName);
        if (plan.planVersion) pieces.push(`v${plan.planVersion}`);
        if (plan.governmentName) pieces.push(plan.governmentName);
        return pieces.length ? pieces.join(' · ') : null;
    }

    async function selectPlanForCurrentView() {
        if (typeof turf === 'undefined') {
            console.warn('turf.js is required to select government plans.');
            return null;
        }
        const plans = await loadPlanCatalog();
        if (!plans.length) return null;
        const bounds = window.map.getBounds();
        const mapPolygon = buildMapBoundsPolygon(bounds);

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
                        displayColor: clone.properties?.displayColor || defaultStyle.fillColor,
                        strokeColor: clone.properties?.strokeColor || defaultStyle.color,
                        strokeWeight: clone.properties?.strokeWeight || defaultStyle.weight,
                        fillOpacity: typeof clone.properties?.fillOpacity === 'number'
                            ? clone.properties.fillOpacity
                            : defaultStyle.fillOpacity,
                        descriptor
                    });
                    return clone;
                })
                .filter(Boolean)
        };
    }

    function collectExistingRoadPolygons() {
        if (!window.parcelLayer || typeof window.parcelLayer.eachLayer !== 'function') {
            return [];
        }
        const features = [];
        window.parcelLayer.eachLayer(layer => {
            if (!layer || typeof layer.toGeoJSON !== 'function') return;
            const feature = layer.toGeoJSON();
            if (!feature || !feature.geometry) return;
            const type = feature.geometry.type;
            if (type !== 'Polygon' && type !== 'MultiPolygon') return;
            const props = feature.properties || {};
            const isRoadFlag = props.isRoad === true
                || (typeof window.isRoad === 'function' && props.CESTICA_ID && window.isRoad(props.CESTICA_ID));
            if (!isRoadFlag) return;
            features.push(feature);
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

    function buildExistingRoadUnion() {
        const features = collectExistingRoadPolygons();
        if (!features.length || typeof turf === 'undefined') return null;
        let unionFeature = null;
        for (const feature of features) {
            unionFeature = unionFeature ? safeUnion(unionFeature, feature) : feature;
        }
        return unionFeature;
    }

    function subtractExistingRoadsFromCollection(collection) {
        if (!collection || typeof turf === 'undefined') {
            return collection || { type: 'FeatureCollection', features: [] };
        }
        const existingUnion = buildExistingRoadUnion();
        if (!existingUnion) return collection;

        const output = [];
        for (const feature of collection.features || []) {
            if (!feature || !feature.geometry) continue;
            const type = feature.geometry.type;
            if (type !== 'Polygon' && type !== 'MultiPolygon') {
                output.push(feature);
                continue;
            }
            let diff = null;
            try {
                diff = turf.difference(feature, existingUnion);
            } catch (err) {
                console.warn('turf.difference failed; keeping original planned road polygon.', err);
                diff = null;
            }
            if (!diff || !diff.geometry) {
                continue;
            }
            if (diff.type === 'Feature') {
                diff.properties = Object.assign({}, feature.properties);
                output.push(diff);
            } else if (diff.geometry) {
                output.push({
                    type: 'Feature',
                    geometry: diff.geometry,
                    properties: Object.assign({}, feature.properties)
                });
            }
        }
        return { type: 'FeatureCollection', features: output };
    }

    async function fetchGovernmentPlanFromCatalog() {
        const plan = await selectPlanForCurrentView();
        if (!plan) {
            return {
                collection: { type: 'FeatureCollection', features: [] },
                descriptor: null,
                source: 'catalog'
            };
        }
        const raw = await fetchPlanGeoJSON(plan);
        const decorated = decoratePlanFeatures(raw, plan);
        const cleaned = subtractExistingRoadsFromCollection(decorated);
        return {
            collection: cleaned,
            descriptor: describePlan(plan),
            source: 'catalog'
        };
    }

    async function fetchGovernmentPlanFromBackend(bbox) {
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
        return {
            collection: json,
            descriptor: null,
            source: 'backend'
        };
    }

    async function fetchGovernmentRoadPlanGeoJSON(bbox) {
        const dataSource = getCurrentDataSource();
        if (dataSource === 'localhost' || dataSource === 'api.urbangametheory.xyz') {
            return fetchGovernmentPlanFromBackend(bbox);
        }
        return fetchGovernmentPlanFromCatalog();
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

    function buildFeatureStyle(feature) {
        const props = feature && typeof feature === 'object' ? (feature.properties || {}) : {};
        return {
            color: props.strokeColor || defaultStyle.color,
            weight: Number.isFinite(props.strokeWeight) ? Number(props.strokeWeight) : defaultStyle.weight,
            fillColor: props.displayColor || defaultStyle.fillColor,
            fillOpacity: typeof props.fillOpacity === 'number' ? props.fillOpacity : defaultStyle.fillOpacity,
            opacity: defaultStyle.opacity,
            dashArray: defaultStyle.dashArray,
            interactive: defaultStyle.interactive
        };
    }

    async function applyGovernmentRoadPlan() {
        if (isFetchingGovernmentPlan) {
            return;
        }
        try {
            ensureMapReady();
        } catch (err) {
            if (typeof window.updateStatus === 'function') {
                window.updateStatus('Map is not ready yet. Please wait.');
            }
            console.warn(err.message);
            return;
        }

        const bbox = (typeof window.getBboxFromBounds === 'function' && window.map)
            ? window.getBboxFromBounds(window.map.getBounds())
            : '';

        isFetchingGovernmentPlan = true;
        if (typeof window.updateStatus === 'function') {
            window.updateStatus('Fetching government road plan...');
        }

        try {
            const { collection, descriptor, source } = await fetchGovernmentRoadPlanGeoJSON(bbox);
            lastPlanDescriptor = descriptor;
            const geojson = toLeafletGeoJSON(collection);
            const features = Array.isArray(geojson.features) ? geojson.features.filter(Boolean) : [];

            if (features.length === 0) {
                clearGovernmentRoadPlanLayer();
                if (typeof window.updateStatus === 'function') {
                    if (source === 'catalog') {
                        window.updateStatus('No catalogued government road plan overlaps this map view.');
                    } else {
                        window.updateStatus('Government road plan contains no new segments for this area.');
                    }
                }
                return;
            }

            clearGovernmentRoadPlanLayer();
            governmentRoadPlanLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
                style: buildFeatureStyle
            }).addTo(window.map);
            try { governmentRoadPlanLayer.bringToFront(); } catch (_) { }
            try { window.governmentRoadPlanLayer = governmentRoadPlanLayer; } catch (_) { }

            if (typeof window.updateStatus === 'function') {
                const suffix = lastPlanDescriptor ? ` (${lastPlanDescriptor})` : '';
                window.updateStatus(`Government road plan applied${suffix}: ${features.length} segment(s).`);
            }
        } catch (error) {
            console.error('Failed to apply government road plan:', error);
            if (typeof window.updateStatus === 'function') {
                window.updateStatus('Failed to apply government road plan. Check console for details.');
            }
        } finally {
            isFetchingGovernmentPlan = false;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const button = document.getElementById('applyGovernmentRoadPlanButton');
        if (!button) return;
        button.addEventListener('click', () => {
            applyGovernmentRoadPlan();
        });
    });

    window.applyGovernmentRoadPlan = applyGovernmentRoadPlan;
    window.clearGovernmentRoadPlanLayer = clearGovernmentRoadPlanLayer;
    window.governmentRoadPlanLastDescriptor = () => lastPlanDescriptor;
})();
