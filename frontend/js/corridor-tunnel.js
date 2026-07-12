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
        const seenProposalBuildings = new Set();
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
        // Applied building proposals of EVERY typology (block, row, parcel-based, single) block
        // corridors too — the shared proposedBuildings array does not reliably carry all of them.
        try {
            (global.proposalStorage?.getAllProposals?.() || []).forEach(proposal => {
                const bp = proposal?.buildingProposal;
                if (!bp) return;
                const status = String(bp.status || proposal.status || '').toLowerCase();
                if (status !== 'applied' && status !== 'executed') return;
                const proposalId = proposal.proposalId || proposal.id;
                if (!proposalId) return;
                const features = Array.isArray(proposal.geometry?.buildings) && proposal.geometry.buildings.length
                    ? proposal.geometry.buildings
                    : (Array.isArray(bp.buildings) && bp.buildings.length
                        ? bp.buildings
                        : (bp.buildingFeature ? [bp.buildingFeature] : []));
                features.forEach((candidate, index) => {
                    const feature = normalizeBuildingFeature(candidate);
                    if (!feature || !feature.geometry) return;
                    const dedupeKey = `proposal:${proposalId}:${index}`;
                    if (seenProposalBuildings.has(dedupeKey)) return;
                    seenProposalBuildings.add(dedupeKey);
                    buildings.push({
                        ...feature,
                        properties: { ...(feature.properties || {}), proposalId: String(proposalId), buildingIndex: index }
                    });
                });
            });
        } catch (_) { }
        return buildings;
    }

    // Tunnel spans are covered structures that acquire nothing: splits each centerline segment
    // into maximal runs of consecutive NON-tunnel edges. Parcel parents and parcel cuts are
    // computed from these surface runs only; the full centerline keeps driving the rendering.
    function corridorSurfaceRuns(segments, tunnelRecords) {
        const isPoint = value => !!value && (value.lat !== undefined || (Array.isArray(value) && typeof value[0] === 'number'));
        const list = Array.isArray(segments)
            ? (segments.length && isPoint(segments[0]) ? [segments] : segments)
            : [];
        const tunnelKeys = new Set((tunnelRecords || [])
            .map(record => record && record.edgeKey)
            .filter(Boolean));
        const runs = [];
        list.forEach(segment => {
            if (!Array.isArray(segment) || segment.length < 2) return;
            let current = [];
            for (let i = 0; i < segment.length - 1; i++) {
                const key = corridorTunnelEdgeKey(segment[i], segment[i + 1]);
                if (key && tunnelKeys.has(key)) {
                    if (current.length >= 2) runs.push(current);
                    current = [];
                } else {
                    if (!current.length) current.push(segment[i]);
                    current.push(segment[i + 1]);
                }
            }
            if (current.length >= 2) runs.push(current);
        });
        return runs;
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

    function tunnelHitProposalId(hit) {
        const fromProps = hit?.feature?.properties?.proposalId;
        if (fromProps !== undefined && fromProps !== null && String(fromProps)) return String(fromProps);
        const id = String(hit?.id || '');
        if (id.startsWith('proposal:')) {
            const parts = id.split(':');
            if (parts.length >= 2 && parts[1]) return parts[1];
        }
        return null;
    }

    async function promptBuildingObstacle(hits, corridorKind, offerUnapply) {
        const count = hits.length;
        const kind = corridorKind === 'track'
            ? tunnelText('modal.corridorTunnel.track', 'track')
            : tunnelText('modal.corridorTunnel.road', 'road');
        const message = tunnelText(
            'modal.corridorTunnel.offer',
            'This {{kind}} would pass through {{count}} building(s). Create a tunnel through the building?',
            { kind, count }
        );
        const choices = [];
        if (offerUnapply) {
            choices.push({ value: 'unapply', label: tunnelText('modal.corridorTunnel.unapply', 'Unapply existing proposal') });
        }
        choices.push({ value: 'tunnel', label: tunnelText('modal.corridorTunnel.confirm', 'Tunnel through'), primary: true });
        choices.push({ value: 'cancel', label: tunnelText('modal.corridorTunnel.cancel', 'Choose another route') });
        if (typeof global.showStyledChoice === 'function') {
            const answer = await global.showStyledChoice(message, choices);
            return answer || 'cancel';
        }
        if (typeof global.showStyledConfirm === 'function') {
            const ok = await global.showStyledConfirm(message, {
                okText: tunnelText('modal.corridorTunnel.confirm', 'Tunnel through'),
                cancelText: tunnelText('modal.corridorTunnel.cancel', 'Choose another route')
            });
            return ok ? 'tunnel' : 'cancel';
        }
        return global.confirm?.(message) ? 'tunnel' : 'cancel';
    }

    // Walks the user through the buildings a new corridor edge collides with. Proposal-owned
    // buildings can be unapplied in place; the remaining (built) ones can be tunnelled or the
    // route abandoned. Returns { action: 'tunnel' | 'clear' | 'cancel', removedProposalIds }:
    // 'clear' means every obstacle was unapplied and no tunnel record is needed.
    async function resolveBuildingObstacles(hits, corridorKind = 'road') {
        const removedProposalIds = [];
        if (!Array.isArray(hits) || !hits.length) return { action: 'clear', removedProposalIds };
        if (promptActive) return { action: 'cancel', removedProposalIds };
        promptActive = true;
        try {
            let remaining = hits.slice();
            while (remaining.length) {
                const unappliable = Array.from(new Set(remaining.map(tunnelHitProposalId).filter(Boolean)));
                const answer = await promptBuildingObstacle(remaining, corridorKind, unappliable.length > 0);
                if (answer === 'tunnel') return { action: 'tunnel', removedProposalIds };
                if (answer !== 'unapply') return { action: 'cancel', removedProposalIds };
                for (const proposalId of unappliable) {
                    try {
                        const done = await global.ProposalManager?.unapplyProposal?.(proposalId, { skipConfirm: true });
                        if (done !== false) removedProposalIds.push(proposalId);
                    } catch (error) {
                        console.warn('[corridor-tunnel] could not unapply obstacle proposal', proposalId, error);
                    }
                }
                const removed = new Set(removedProposalIds);
                remaining = remaining.filter(hit => {
                    const owner = tunnelHitProposalId(hit);
                    return !owner || !removed.has(owner);
                });
            }
            return { action: 'clear', removedProposalIds };
        } finally {
            promptActive = false;
        }
    }

    // Boolean legacy wrapper: true when drawing may continue with tunnel records for the hits.
    async function offerBuildingTunnel(hits, corridorKind = 'road') {
        const resolution = await resolveBuildingObstacles(hits, corridorKind);
        return resolution.action === 'tunnel';
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
        corridorSurfaceRuns,
        corridorTunnelHitProposalId: tunnelHitProposalId,
        resolveBuildingObstacles,
        offerBuildingTunnel
    });

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            corridorTunnelEdgeKey,
            findBuildingTunnelIntersections,
            corridorFeatureFromLatLngRing,
            makeBuildingTunnelRecord,
            addBuildingTunnelRecord,
            removeBuildingTunnelEdge,
            corridorSurfaceRuns
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
