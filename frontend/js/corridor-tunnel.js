// Detects building collisions for newly drawn corridor edges and stores stable, endpoint-based
// building-tunnel records that survive direction changes, copying and proposal serialization.
(function attachCorridorTunnel(global) {
    let promptActive = false;

    function pointOf(value) {
        if (!value) return null;
        const lat = Number(value.lat !== undefined ? value.lat : value[1]);
        const lng = Number(value.lng !== undefined ? value.lng : value[0]);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }

    function corridorTunnelEdgeKey(from, to) {
        const a = pointOf(from);
        const b = pointOf(to);
        if (!a || !b) return '';
        const key = point => `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
        return [key(a), key(b)].sort().join('|');
    }

    function buildingIdentifier(feature, fallback) {
        const props = feature && feature.properties ? feature.properties : {};
        if (props.proposalId !== undefined && props.proposalId !== null) {
            return `proposal:${props.proposalId}:${props.buildingIndex ?? 0}`;
        }
        const direct = props.object_id ?? props.objectId ?? props.building_id ?? props.buildingId
            ?? props.id ?? feature?.id;
        if (direct !== undefined && direct !== null && String(direct)) return String(direct);
        return String(fallback);
    }

    function normalizeBuildingFeature(value) {
        if (!value) return null;
        if (value.type === 'Feature' && value.geometry) return value;
        if (value.feature && value.feature.geometry) return value.feature;
        if (value.type && value.coordinates) {
            return { type: 'Feature', properties: {}, geometry: value };
        }
        return null;
    }

    function findBuildingTunnelIntersections(corridorFeature, buildings, turfApi, minimumArea = 0.25) {
        if (!corridorFeature || !corridorFeature.geometry || !Array.isArray(buildings)) return [];
        const api = turfApi || global.turf;
        if (!api || typeof api.intersect !== 'function') return [];
        const hits = [];
        const seen = new Set();

        buildings.forEach((candidate, index) => {
            const feature = normalizeBuildingFeature(candidate);
            if (!feature || !feature.geometry) return;
            let intersection = null;
            try { intersection = api.intersect(corridorFeature, feature); } catch (_) { return; }
            if (!intersection) return;
            let area = minimumArea;
            try {
                if (typeof api.area === 'function') area = Number(api.area(intersection));
            } catch (_) { area = minimumArea; }
            if (!Number.isFinite(area) || area < minimumArea) return;
            const id = buildingIdentifier(feature, `building:${index}`);
            if (seen.has(id)) return;
            seen.add(id);
            hits.push({ id, feature, area });
        });
        return hits;
    }

    function collectLoadedCorridorBuildings() {
        const buildings = [];
        const layer = global.buildingLayer;
        if (layer && typeof layer.eachLayer === 'function') {
            layer.eachLayer(entry => {
                if (entry && entry.feature && entry.feature.geometry) buildings.push(entry.feature);
            });
        }
        if (Array.isArray(global.proposedBuildings)) {
            global.proposedBuildings.forEach(feature => {
                if (feature && feature.geometry) buildings.push(feature);
            });
        }
        return buildings;
    }

    async function ensureCorridorBuildingFootprintsLoaded() {
        if (collectLoadedCorridorBuildings().length) return true;
        try {
            const config = global.CityConfigManager?.getCurrentCityConfig?.();
            if (config?.buildings?.source === 'none') return false;
            const zoom = global.map?.getZoom?.();
            if (!Number.isFinite(zoom) || zoom < 17 || zoom > 19) return false;
            if (typeof global.fetchBuildings !== 'function') return false;
            await global.fetchBuildings();
            const loaded = collectLoadedCorridorBuildings().length > 0;
            if (loaded) {
                const checkbox = global.document?.getElementById('showBuildings');
                if (checkbox) checkbox.checked = true;
            }
            return loaded;
        } catch (error) {
            console.warn('[corridor-tunnel] building footprints could not be prepared', error);
            return false;
        }
    }

    function corridorFeatureFromLatLngRing(ring, turfApi) {
        const api = turfApi || global.turf;
        if (!api || typeof api.polygon !== 'function' || !Array.isArray(ring) || ring.length < 3) return null;
        const coords = ring.map(point => [Number(point.lng), Number(point.lat)])
            .filter(pair => Number.isFinite(pair[0]) && Number.isFinite(pair[1]));
        if (coords.length < 3) return null;
        const first = coords[0];
        const last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first.slice());
        try { return api.polygon([coords]); } catch (_) { return null; }
    }

    function detectLoadedBuildingTunnelIntersections(corridorRing) {
        const feature = corridorFeatureFromLatLngRing(corridorRing);
        return findBuildingTunnelIntersections(feature, collectLoadedCorridorBuildings(), global.turf);
    }

    function makeBuildingTunnelRecord(from, to, hits, options = {}) {
        const start = pointOf(from);
        const end = pointOf(to);
        const edgeKey = corridorTunnelEdgeKey(start, end);
        if (!start || !end || !edgeKey) return null;
        return {
            id: `building-tunnel:${edgeKey}`,
            kind: 'building',
            edgeKey,
            from: start,
            to: end,
            segmentId: options.segmentId || null,
            buildingIds: Array.from(new Set((hits || []).map(hit => String(hit.id || hit)).filter(Boolean)))
        };
    }

    function addBuildingTunnelRecord(records, record) {
        const list = Array.isArray(records) ? records : [];
        if (!record || !record.edgeKey) return list;
        const index = list.findIndex(item => item && item.edgeKey === record.edgeKey);
        if (index >= 0) list[index] = record;
        else list.push(record);
        return list;
    }

    function removeBuildingTunnelEdge(records, from, to) {
        if (!Array.isArray(records)) return [];
        const edgeKey = corridorTunnelEdgeKey(from, to);
        return records.filter(record => !record || record.edgeKey !== edgeKey);
    }

    function tunnelText(key, fallback, params = {}) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const value = global.i18n.t(key, params);
                if (value && value !== key) return value;
            }
        } catch (_) { }
        return fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => params[name] ?? '');
    }

    async function offerBuildingTunnel(hits, corridorKind = 'road') {
        if (!Array.isArray(hits) || !hits.length || promptActive) return false;
        promptActive = true;
        const count = hits.length;
        const kind = corridorKind === 'track'
            ? tunnelText('modal.corridorTunnel.track', 'track')
            : tunnelText('modal.corridorTunnel.road', 'road');
        const message = tunnelText(
            'modal.corridorTunnel.offer',
            'This {{kind}} would pass through {{count}} building(s). Create a tunnel through the building?',
            { kind, count }
        );
        try {
            if (typeof global.showStyledConfirm === 'function') {
                return await global.showStyledConfirm(message, {
                    okText: tunnelText('modal.corridorTunnel.confirm', 'Tunnel through'),
                    cancelText: tunnelText('modal.corridorTunnel.cancel', 'Choose another route')
                });
            }
            return !!global.confirm?.(message);
        } finally {
            promptActive = false;
        }
    }

    Object.assign(global, {
        corridorTunnelEdgeKey,
        findBuildingTunnelIntersections,
        collectLoadedCorridorBuildings,
        ensureCorridorBuildingFootprintsLoaded,
        corridorFeatureFromLatLngRing,
        detectLoadedBuildingTunnelIntersections,
        makeBuildingTunnelRecord,
        addBuildingTunnelRecord,
        removeBuildingTunnelEdge,
        offerBuildingTunnel
    });

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            corridorTunnelEdgeKey,
            findBuildingTunnelIntersections,
            corridorFeatureFromLatLngRing,
            makeBuildingTunnelRecord,
            addBuildingTunnelRecord,
            removeBuildingTunnelEdge
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
