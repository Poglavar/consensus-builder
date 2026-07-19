// Detects building collisions for newly drawn corridor edges and stores stable, endpoint-based
// building-tunnel records that survive direction changes, copying and proposal serialization.
(function attachCorridorTunnel(global) {
    let promptActive = false;

    // Resolver alias for the canonical applied accessor: the browser global wins; node tests require it.
    const appliedOf = (typeof isApplied === 'function') ? isApplied : require('./proposals/status.js').isApplied;

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

    // A long diagonal's bounding box contains an enormous square of unrelated city. Fetching that
    // square can hit the API's row cap, leaving arbitrary buildings along the actual road unloaded.
    // Split the edge into short pieces first; each request then hugs the corridor it is meant to scan.
    function corridorEdgeFetchSegments(from, to, maxLengthMeters = 150) {
        const start = pointOf(from);
        const end = pointOf(to);
        if (!start || !end) return [];
        const radians = degrees => degrees * Math.PI / 180;
        const dLat = radians(end.lat - start.lat);
        const dLng = radians(end.lng - start.lng);
        const lat1 = radians(start.lat);
        const lat2 = radians(end.lat);
        const h = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        const distance = 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
        const limit = Number(maxLengthMeters);
        const count = Math.max(1, Math.ceil(distance / (Number.isFinite(limit) && limit > 0 ? limit : 150)));
        return Array.from({ length: count }, (_, index) => {
            const a = index / count;
            const b = (index + 1) / count;
            const interpolate = ratio => ({
                lat: start.lat + (end.lat - start.lat) * ratio,
                lng: start.lng + (end.lng - start.lng) * ratio
            });
            return [interpolate(a), interpolate(b)];
        });
    }

    function buildingIdentifier(feature, fallback) {
        const props = feature && feature.properties ? feature.properties : {};
        if (props.proposalId !== undefined && props.proposalId !== null) {
            return `proposal:${props.proposalId}:${props.buildingIndex ?? 0}`;
        }
        // object_id FIRST, and it is not a preference — it is the whole design. The buildings we
        // work with ARE the GDI objects: `gdi_building_footprint` (what detection scans, and what
        // GET /buildings?bbox= serves) and `gdi_building_3d` (what the 3D view and the walk sim
        // render) are the same 357,683 features under the same object_id. Keying records on it is
        // what lets every downstream consumer match a record to a mesh EXACTLY, by id.
        //
        // ZGRADA_ID is the DGU CADASTRE id — a different survey in a different key space. It is a
        // reference layer only and must never be cut, tunnelled or demolished against, so it is
        // NOT accepted here. The remaining keys cover the other city sources (NYC, Overture).
        const direct = props.object_id ?? props.objectId ?? props.OBJECT_ID
            ?? props.building_id ?? props.buildingId ?? props.id ?? feature?.id;
        if (direct !== undefined && direct !== null && String(direct)) return String(direct);
        // No id property at all: derive a stable key from the geometry. Never key by pool index —
        // the pool is rebuilt between calls (fetch merges, demolition filtering), so index-based
        // ids left click-time demolish records unmatchable at finish time (the F re-prompt bug).
        try {
            const first = feature?.geometry?.coordinates?.[0]?.[0];
            if (first) return `geom:${JSON.stringify(first)}`;
        } catch (_) { }
        return String(fallback);
    }

    // The one canonical building identity — every consumer (detection, demolition records,
    // 2D layer filtering, fetch dedupe) must use THIS so records match across modules.
    function corridorBuildingKey(feature) {
        return buildingIdentifier(feature, 'building:unidentified');
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

    // Collision detection runs against the building's CURRENT surviving footprint, but every
    // demolition record must remain anchored to the provider's ORIGINAL footprint. Otherwise a
    // second road cutting an already-cut building would treat the first remainder as a new whole
    // building and independent proposal records could never be combined correctly.
    function originalBuildingFeature(hitOrFeature) {
        const candidate = hitOrFeature?.feature || hitOrFeature;
        const current = normalizeBuildingFeature(candidate);
        const originalGeometry = hitOrFeature?.originalGeometry
            || candidate?.__corridorOriginalGeometry
            || current?.geometry;
        if (!originalGeometry) return current;
        return {
            type: 'Feature',
            properties: { ...(current?.properties || {}) },
            geometry: originalGeometry
        };
    }

    // Applies already-recorded demolitions to the footprint pool without destroying the source
    // data. Full demolitions disappear; partial demolitions remain collision targets using their
    // surviving remainder, with the original geometry carried beside them for future cuts.
    function applyDemolitionRecordsToBuildingFeatures(buildings, records) {
        const byId = new Map();
        (records || []).forEach(record => {
            if (record?.id !== undefined && record?.id !== null) byId.set(String(record.id), record);
        });
        if (!byId.size) return (buildings || []).slice();
        return (buildings || []).map((candidate, index) => {
            const feature = normalizeBuildingFeature(candidate);
            if (!feature?.geometry) return null;
            const id = String(buildingIdentifier(feature, `building:${index}`));
            const record = byId.get(id);
            if (!record) return candidate;
            if (!record.remainder) return null;
            return {
                ...feature,
                properties: { ...(feature.properties || {}) },
                geometry: JSON.parse(JSON.stringify(record.remainder)),
                __corridorOriginalGeometry: JSON.parse(JSON.stringify(record.geometry || feature.geometry))
            };
        }).filter(Boolean);
    }

    // minimumArea must match the record-writing thresholds (upsertCutRecord /
    // splitDemolitionFootprint ignore clips under 2 m²): a lower detection floor made buildings
    // grazed by 0.25–2 m² PROMPT but produce no record, so the finish check re-prompted for them.
    function findBuildingTunnelIntersections(corridorFeature, buildings, turfApi, minimumArea = 2) {
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
            hits.push({
                id,
                feature,
                area,
                originalGeometry: feature.__corridorOriginalGeometry || feature.geometry
            });
        });
        return hits;
    }

    // The GDI buildings detection works with. This reads the POOL (`buildingFeaturePool`) — the
    // data — and NEVER `buildingLayer` — the Leaflet DISPLAY layer.
    //
    // That distinction is the whole point. The reference layers (GDI footprints, DGU footprints)
    // are cosmetic checkboxes the user flips constantly, and B is hammered mid-draw. Reading the
    // display layer meant an unticked box literally removed buildings from the set that could be
    // cut, so what a corridor demolished depended on what was switched on when it was drawn.
    // The pool is filled by fetchBuildings() regardless of any checkbox (rebuildBuildingLayerFromPool
    // is the only thing that consults visibility), so cutting is now independent of display.
    function collectLoadedCorridorBuildings() {
        const buildings = [];
        const seenProposalBuildings = new Set();
        const pool = Array.isArray(global.buildingFeaturePool) ? global.buildingFeaturePool : [];
        pool.forEach(feature => {
            if (feature && feature.geometry) buildings.push(feature);
        });
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
                if (!appliedOf(proposal, bp)) return;
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
        return applyDemolitionRecordsToBuildingFeatures(buildings, collectDemolishedBuildingRecords());
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

    // A tunnel record belongs to one exact centerline edge. Moving or deleting either endpoint
    // invalidates that record; retaining it would keep the old purple span visible and, worse,
    // globally suppress the building from collision detection on the road's new alignment.
    function retainLiveCorridorTunnelRecords(segments, tunnelRecords) {
        const isPoint = value => !!value && (value.lat !== undefined || (Array.isArray(value) && typeof value[0] === 'number'));
        const list = Array.isArray(segments)
            ? (segments.length && isPoint(segments[0]) ? [segments] : segments)
            : [];
        const liveEdgeKeys = new Set();
        list.forEach(segment => {
            if (!Array.isArray(segment)) return;
            for (let index = 0; index < segment.length - 1; index += 1) {
                const edgeKey = corridorTunnelEdgeKey(segment[index], segment[index + 1]);
                if (edgeKey) liveEdgeKeys.add(edgeKey);
            }
        });
        return (Array.isArray(tunnelRecords) ? tunnelRecords : [])
            .filter(record => record?.edgeKey && liveEdgeKeys.has(record.edgeKey));
    }

    async function ensureCorridorBuildingFootprintsLoaded() {
        // Gate on the BASE-MAP footprints specifically: collectLoadedCorridorBuildings() also
        // returns applied building proposals, and any proposal nearby used to convince this
        // preload that footprints were loaded — obstacle prompts then only worked once the
        // user manually ticked "show existing buildings" (which fetched the real ones).
        if (Array.isArray(global.buildingFeaturePool) && global.buildingFeaturePool.length) return true;
        try {
            const config = global.CityConfigManager?.getCurrentCityConfig?.();
            if (config?.buildings?.source === 'none') return false;
            const zoom = global.map?.getZoom?.();
            if (!Number.isFinite(zoom) || zoom < 17 || zoom > 19) return false;
            if (typeof global.fetchBuildings !== 'function') return false;
            await global.fetchBuildings();
            // Footprint DATA is what detection needs, and fetchBuildings always fills the pool.
            // Reference-layer VISIBILITY is decided separately (rebuildBuildingLayerFromPool reads
            // the sidebar checkboxes), so there is nothing to undo here and nothing a toggle can
            // take away from the corridor.
            return collectLoadedCorridorBuildings().length > 0;
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

    // Tunnels exist only while INSIDE buildings. Split one corridor edge at the points where
    // its centerline enters/leaves the hit footprints — each footprint buffered by half the
    // corridor width, so the portal sits where the road SURFACE meets the facade, and so the
    // centerline test agrees with the width-aware polygon detection that produced the hits.
    // Returns ordered sub-edges [{from, to, inside, hits}] covering the whole edge (endpoints
    // preserved exactly), or null when no part of the centerline is inside any footprint.
    function clipCorridorEdgeThroughBuildings(from, to, hits, widthMeters, turfApi) {
        const api = turfApi || global.turf;
        const start = pointOf(from);
        const end = pointOf(to);
        if (!api || !start || !end || !Array.isArray(hits) || !hits.length) return null;
        let line = null;
        let edgeLength = 0;
        try {
            line = api.lineString([[start.lng, start.lat], [end.lng, end.lat]]);
            edgeLength = api.length(line, { units: 'meters' });
        } catch (error) {
            console.error('[corridor-tunnel] edge could not be measured for tunnel clipping', error);
            return null;
        }
        if (!(edgeLength > 0.1)) return null;

        const halfWidth = Math.max(Number(widthMeters) || 0, 0) / 2;
        const zones = [];
        hits.forEach(hit => {
            const feature = normalizeBuildingFeature(hit.feature || hit);
            if (!feature || !feature.geometry) return;
            let zone = feature;
            if (halfWidth > 0) {
                try { zone = api.buffer(feature, halfWidth, { units: 'meters', steps: 8 }) || feature; } catch (_) { zone = feature; }
            }
            zones.push({ hit, zone });
        });
        if (!zones.length) return null;

        // Split parameters along the edge: 0, 1 and every centerline/zone-boundary crossing.
        const EPS = 0.25 / Math.max(edgeLength, 0.25); // ignore crossings within ~25 cm of a vertex
        const ts = [0, 1];
        zones.forEach(({ zone }) => {
            let crossings = null;
            try { crossings = api.lineIntersect(line, zone); } catch (_) { crossings = null; }
            (crossings?.features || []).forEach(point => {
                try {
                    const snapped = api.nearestPointOnLine(line, point, { units: 'meters' });
                    const t = snapped.properties.location / edgeLength;
                    if (Number.isFinite(t) && t > EPS && t < 1 - EPS) ts.push(t);
                } catch (_) { }
            });
        });
        ts.sort((a, b) => a - b);
        const cuts = ts.filter((t, index) => index === 0 || t - ts[index - 1] > EPS);
        if (cuts[cuts.length - 1] !== 1) cuts.push(1);
        if (cuts.length < 3) return null; // no interior crossing: the edge is wholly in or out

        const pointAt = t => {
            if (t <= 0) return { lat: start.lat, lng: start.lng };
            if (t >= 1) return { lat: end.lat, lng: end.lng };
            const coords = api.along(line, edgeLength * t, { units: 'meters' }).geometry.coordinates;
            return { lat: coords[1], lng: coords[0] };
        };
        const insideHitsAt = t => {
            const probe = api.point([start.lng + (end.lng - start.lng) * t, start.lat + (end.lat - start.lat) * t]);
            return zones
                .filter(({ zone }) => {
                    try { return api.booleanPointInPolygon(probe, zone); } catch (_) { return false; }
                })
                .map(({ hit }) => hit);
        };

        // Build sub-edges, merging neighbours that agree on inside/outside.
        const subEdges = [];
        for (let i = 0; i < cuts.length - 1; i++) {
            const mid = (cuts[i] + cuts[i + 1]) / 2;
            const insideHits = insideHitsAt(mid);
            const previous = subEdges[subEdges.length - 1];
            if (previous && previous.inside === (insideHits.length > 0)) {
                previous.t1 = cuts[i + 1];
                insideHits.forEach(hit => { if (!previous.hits.includes(hit)) previous.hits.push(hit); });
            } else {
                subEdges.push({ t0: cuts[i], t1: cuts[i + 1], inside: insideHits.length > 0, hits: insideHits });
            }
        }
        if (subEdges.length < 2 || !subEdges.some(edge => edge.inside)) return null;
        return subEdges.map((edge, index) => ({
            from: index === 0 ? { lat: start.lat, lng: start.lng } : pointAt(edge.t0),
            to: index === subEdges.length - 1 ? { lat: end.lat, lng: end.lng } : pointAt(edge.t1),
            inside: edge.inside,
            hits: edge.hits
        }));
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

    function lookupObstacleProposal(proposalId) {
        if (!proposalId) return null;
        try {
            if (typeof global.getProposalByIdOrHash === 'function') {
                const found = global.getProposalByIdOrHash(proposalId);
                if (found) return found;
            }
        } catch (_) { }
        try {
            const found = global.proposalStorage?.getProposal?.(proposalId);
            if (found) return found;
        } catch (_) { }
        try {
            return (global.proposalStorage?.getAllProposals?.() || []).find(proposal => {
                const candidates = [proposal?.proposalId, proposal?.id, proposal?.serverProposalId];
                if (typeof global.getProposalKey === 'function') candidates.push(global.getProposalKey(proposal));
                return candidates.some(candidate => candidate !== undefined
                    && candidate !== null
                    && String(candidate) === String(proposalId));
            }) || null;
        } catch (_) {
            return null;
        }
    }

    function obstacleProposalTitle(proposal, proposalId) {
        try {
            if (proposal && typeof global.getProposalDisplayTitle === 'function') {
                const title = global.getProposalDisplayTitle(proposal);
                if (title && String(title).trim()) return String(title).replace(/\s+/g, ' ').trim();
            }
        } catch (_) { }
        const candidates = [
            proposal?.title,
            proposal?.name,
            proposal?.proposalName,
            proposal?.blockName,
            proposal?.roadProposal?.name,
            proposal?.buildingProposal?.name,
            proposal?.structureProposal?.blockName
        ];
        const title = candidates.find(candidate => typeof candidate === 'string' && candidate.trim());
        return title ? title.replace(/\s+/g, ' ').trim() : `Proposal ${proposalId}`;
    }

    // Preflight the proposal side-effects BEFORE the user chooses. Several building features may
    // belong to one proposal, so dedupe by owner id and keep unknown ids visible instead of silently
    // dropping them from the warning. `lookupProposal` is injectable for the node regression test.
    function collectObstacleProposalImpacts(hits, lookupProposal = lookupObstacleProposal) {
        const impacts = [];
        const seen = new Set();
        (Array.isArray(hits) ? hits : []).forEach(hit => {
            const proposalId = tunnelHitProposalId(hit);
            if (!proposalId || seen.has(proposalId)) return;
            seen.add(proposalId);
            const proposal = typeof lookupProposal === 'function' ? lookupProposal(proposalId) : null;
            impacts.push({
                proposalId,
                title: obstacleProposalTitle(proposal, proposalId)
            });
        });
        return impacts;
    }

    function buildBuildingObstaclePrompt(
        hits,
        corridorKind,
        proposalImpacts = collectObstacleProposalImpacts(hits),
        options = {}
    ) {
        const count = Array.isArray(hits) ? hits.length : 0;
        const mergeProposalImpacts = Array.isArray(options.mergeProposalImpacts)
            ? options.mergeProposalImpacts.filter(Boolean)
            : [];
        const kind = corridorKind === 'track'
            ? tunnelText('modal.corridorTunnel.track', 'track')
            : tunnelText('modal.corridorTunnel.road', 'road');
        let message = count
            ? tunnelText(
                'modal.corridorTunnel.offer',
                'This {{kind}} would pass through {{count}} new building(s). Cut through them, demolish, or tunnel?',
                { kind, count }
            )
            : '';
        const proposalCount = proposalImpacts.length;
        if (proposalCount) {
            const heading = tunnelText(
                'modal.corridorTunnel.proposalImpact',
                'Cutting or demolishing will unapply these proposals (they remain in the proposal list and can be applied again):',
                { count: proposalCount }
            );
            const tunnelNote = tunnelText(
                'modal.corridorTunnel.proposalImpactTunnel',
                'Tunnelling keeps these proposals applied.',
                { count: proposalCount }
            );
            const list = proposalImpacts.map(impact => `• ${impact.title}`).join('\n');
            message = `${message}\n\n${heading}\n${list}\n\n${tunnelNote}`;
        }
        if (mergeProposalImpacts.length) {
            const mergeHeading = tunnelText(
                'modal.corridorTunnel.mergeImpact',
                'Continuing will merge these road proposals into this road and remove their separate proposal entries:',
                { count: mergeProposalImpacts.length }
            );
            const mergeList = mergeProposalImpacts.map(impact => `• ${impact.title}`).join('\n');
            message = `${message}${message ? '\n\n' : ''}${mergeHeading}\n${mergeList}`;
        }
        // Demolition is the common outcome for a road pushed through a parcel; tunnels are the
        // exception. Destroy leads and is preselected (Enter accepts it).
        // Cutting is the DEFAULT: the corridor takes exactly its own footprint out of the
        // buildings; full demolition and tunnelling are the deliberate alternatives.
        const choices = count ? [
            {
                value: 'cut',
                label: proposalCount
                    ? tunnelText('modal.corridorTunnel.cutWithProposals', 'Cut through — unapply {{count}} proposal(s)', { count: proposalCount })
                    : tunnelText('modal.corridorTunnel.cut', 'Cut through the buildings'),
                primary: true
            },
            {
                value: 'destroy',
                label: proposalCount
                    ? tunnelText('modal.corridorTunnel.destroyWithProposals', 'Demolish — unapply {{count}} proposal(s)', { count: proposalCount })
                    : tunnelText('modal.corridorTunnel.destroy', 'Demolish the buildings')
            },
            { value: 'tunnel', label: tunnelText('modal.corridorTunnel.confirm', 'Tunnel through') },
            { value: 'cancel', label: tunnelText('modal.corridorTunnel.cancel', 'Choose another route') }
        ] : [
            { value: 'merge', label: tunnelText('modal.corridorTunnel.merge', 'Merge roads'), primary: true },
            { value: 'cancel', label: tunnelText('modal.corridorTunnel.cancel', 'Choose another route') }
        ];
        return { message, choices, proposalImpacts, mergeProposalImpacts };
    }

    async function promptBuildingObstacle(hits, corridorKind, options = {}) {
        const proposalImpacts = collectObstacleProposalImpacts(hits);
        const built = buildBuildingObstaclePrompt(hits, corridorKind, proposalImpacts, options);
        const count = Array.isArray(hits) ? hits.length : 0;
        // Buildings in the way → the guided per-building tour (global default + per-building override).
        // It resolves to { action, perBuilding } | 'cancel', or a flat action string when it can't
        // render a map. Zero buildings (a road merge only) keeps the flat choice dialog below.
        if (count && typeof global.showBuildingImpactTour === 'function') {
            return global.showBuildingImpactTour(hits, corridorKind, {
                message: built.message,
                proposalImpacts,
                mergeProposalImpacts: built.mergeProposalImpacts,
                defaultAction: 'cut'
            });
        }
        if (typeof global.showStyledChoice === 'function') {
            const answer = await global.showStyledChoice(built.message, built.choices);
            return answer || 'cancel';
        }
        if (typeof global.showStyledConfirm === 'function') {
            const ok = await global.showStyledConfirm(built.message, {
                okText: tunnelText('modal.corridorTunnel.destroy', 'Demolish the buildings'),
                cancelText: tunnelText('modal.corridorTunnel.cancel', 'Choose another route')
            });
            return ok ? 'destroy' : 'cancel';
        }
        return global.confirm?.(built.message) ? 'destroy' : 'cancel';
    }

    // Walks the user through the buildings a new corridor edge collides with.
    // Returns { action: 'cut' | 'destroy' | 'tunnel' | 'cancel', removedProposalIds,
    // demolishedBuildings, cutHits }. Proposal impacts are disclosed in the choice dialog before
    // this function mutates anything; `removedProposalIds` records the proposals actually unapplied.
    // Destroy: proposal-owned buildings are unapplied (the proposal survives in the list);
    // real buildings are recorded as demolished — the object_id AND the footprint. The id is what
    // the 3D view and the walk sim match on (same GDI object_id, exactly); the footprint is what
    // the cut geometry is subtracted from, and what the 2D layer redraws a partial demolition with.
    // Unapply a proposal whose building sits under the corridor (it stays in its parcels'
    // list, recoverable), recording its id in `removedProposalIds`.
    //
    // DECISION (2026-07-15, see impact-resolver.md): a proposal a road runs into is only ever unapplied
    // (unapply), tunnelled under, or destroyed — NEVER cut in place or split into two. This holds for
    // every kind and both mutability classes. Splitting a bisected proposal is the only contiguity-
    // preserving alternative to unapply (non-contiguous proposals are a firm no-go), but a bisected
    // BUILDING has no natural two-piece meaning, so splitting is deferred and cut-in-place with it. An
    // IMMUTABLE proposal (minted OR server-uploaded — see isProposalImmutable) could never be rewritten
    // anyway. If a local cut/split is ever built, its branch goes RIGHT HERE gated on !isProposalImmutable.
    async function setAsideObstacleProposal(owner, removedProposalIds) {
        if (removedProposalIds.includes(owner)) return;
        try {
            const done = await global.ProposalManager?.unapplyProposal?.(owner, { skipConfirm: true, skipRestoreSource: true });
            if (done !== false) removedProposalIds.push(owner);
            else console.error('[corridor-tunnel] unapply refused for obstacle proposal', owner);
        } catch (error) {
            console.error('[corridor-tunnel] could not unapply obstacle proposal', owner, error);
        }
    }

    // Split obstacle hits into their per-building outcomes, given the global default action and an
    // optional per-building override map (id -> 'cut' | 'destroy' | 'tunnel'). A proposal-owned
    // building can't be sliced (see impact-resolver.md), so any cut/destroy on it becomes an unapply
    // of the owning proposal. Pure and unit-tested: no DOM, no proposal mutation, no geometry
    // capture — the resolver does those side effects from the lists this returns.
    function partitionObstacleHits(hits, globalAction, perBuilding, ownerOf = tunnelHitProposalId) {
        const list = Array.isArray(hits) ? hits : [];
        const overrides = perBuilding instanceof Map
            ? perBuilding
            : new Map(Object.entries(perBuilding || {}));
        const effectiveActionById = new Map();
        const realCut = [];
        const realDestroy = [];
        const tunnelHits = [];
        const proposalUnapply = new Set();
        list.forEach(hit => {
            const id = String(hit && hit.id != null ? hit.id : '');
            const action = overrides.get(id) || globalAction || 'cut';
            effectiveActionById.set(id, action);
            if (action === 'tunnel') { tunnelHits.push(hit); return; }
            const owner = typeof ownerOf === 'function' ? ownerOf(hit) : null;
            if (owner) { proposalUnapply.add(owner); return; } // proposal-owned cut/destroy → unapply
            if (action === 'cut') realCut.push(hit);
            else realDestroy.push(hit);
        });
        return { effectiveActionById, realCut, realDestroy, tunnelHits, proposalUnapply };
    }

    async function resolveBuildingObstacles(hits, corridorKind = 'road', options = {}) {
        const removedProposalIds = [];
        const demolishedBuildings = [];
        const obstacleHits = Array.isArray(hits) ? hits : [];
        const mergeImpacts = Array.isArray(options.mergeProposalImpacts) ? options.mergeProposalImpacts.filter(Boolean) : [];
        const outcome = action => ({ action, removedProposalIds, demolishedBuildings, cutHits: [], effectiveActionById: new Map() });
        if (!obstacleHits.length && !mergeImpacts.length) return outcome('destroy');
        if (promptActive) return outcome('cancel');
        promptActive = true;
        try {
            const answer = await promptBuildingObstacle(obstacleHits, corridorKind, { ...options, mergeProposalImpacts: mergeImpacts });
            // Normalize both prompt shapes: the tour returns { action, perBuilding }; the flat dialog a string.
            let globalAction = null;
            let perBuilding = new Map();
            if (answer === 'cancel' || answer == null) return outcome('cancel');
            if (answer === 'merge') return outcome('merge');
            if (typeof answer === 'string') {
                globalAction = answer;
            } else {
                if (answer.action === 'cancel') return outcome('cancel');
                if (answer.action === 'merge') return outcome('merge');
                globalAction = answer.action;
                perBuilding = answer.perBuilding instanceof Map
                    ? answer.perBuilding
                    : new Map(Object.entries(answer.perBuilding || {}));
            }
            if (!['cut', 'destroy', 'tunnel'].includes(globalAction)) return outcome('cancel');

            const part = partitionObstacleHits(obstacleHits, globalAction, perBuilding, tunnelHitProposalId);
            // Proposal-owned buildings set to cut/destroy: unapply the owning proposal (kept in the list).
            for (const owner of part.proposalUnapply) {
                await setAsideObstacleProposal(owner, removedProposalIds);
            }
            // Real buildings set to destroy: capture the footprint so the 3D view and cut geometry match.
            part.realDestroy.forEach(hit => {
                let geometry = null;
                try { geometry = JSON.parse(JSON.stringify(originalBuildingFeature(hit)?.geometry || null)); } catch (error) {
                    console.error('[corridor-tunnel] could not capture footprint of demolished building — it will still render in 3D', hit.id, error);
                }
                demolishedBuildings.push({ id: String(hit.id), geometry });
            });
            return {
                action: globalAction,
                perBuilding,
                effectiveActionById: part.effectiveActionById,
                removedProposalIds,
                demolishedBuildings,
                cutHits: part.realCut
            };
        } finally {
            promptActive = false;
        }
    }

    // Demolition records of every currently APPLIED corridor. Unapplying or deleting the
    // corridor takes its demolitions with it — the buildings come back.
    //
    // The walk of the proposals lives in corridor-carve.js (demolishedBuildingRecordsFrom) because
    // the server needs the same list without a proposalStorage; this stays as the browser's
    // storage-bound entry point. Roads, parks/squares/lakes and building typologies all clear
    // their ground the same way and all park their records on `<kind>Proposal.demolishedBuildings`.
    function collectDemolishedBuildingRecords() {
        try {
            const from = global.demolishedBuildingRecordsFrom;
            if (typeof from !== 'function') {
                console.error('[corridor-tunnel] corridor-carve.js not loaded — no demolition records');
                return [];
            }
            const records = from(global.proposalStorage?.getAllProposals?.() || [], {
                consolidateCorridorRecords: (records, region) =>
                    consolidateCorridorDemolitionRecords(records, region, global.turf)
            });
            return consolidateBuildingDemolitionRecords(records, global.turf);
        } catch (error) {
            console.error('[corridor-tunnel] demolished-building scan failed', error);
            return [];
        }
    }

    // PARTIAL demolition split: a building straddling the demolition region loses only the
    // part inside it — the record then carries `demolishedPart` and `remainder` alongside the
    // full footprint (records WITHOUT `remainder` mean full demolition, as roads produce).
    // Thresholds: a clip under 2 m² demolishes nothing; a remainder under max(10 m², 15% of
    // the footprint) is not worth keeping — the whole building goes.
    function splitDemolitionFootprint(footprintFeature, regionFeature, turfApi) {
        const api = turfApi || global.turf;
        if (!api || !footprintFeature?.geometry || !regionFeature?.geometry) return null;
        let clip = null;
        try { clip = api.intersect(footprintFeature, regionFeature); } catch (error) {
            console.error('[corridor-tunnel] demolition clip failed', error);
            return null;
        }
        if (!clip) return null;
        const clipArea = Number(api.area(clip)) || 0;
        if (clipArea < 2) return null; // barely touched: nothing to demolish
        let remainder = null;
        try { remainder = api.difference(footprintFeature, regionFeature); } catch (error) {
            console.error('[corridor-tunnel] demolition remainder failed — demolishing whole', error);
        }
        const footprintArea = Number(api.area(footprintFeature)) || 0;
        const remainderArea = remainder ? (Number(api.area(remainder)) || 0) : 0;
        if (!remainder || remainderArea < Math.max(10, footprintArea * 0.15)) {
            return { full: true };
        }
        return { full: false, demolishedPart: clip.geometry, remainder: remainder.geometry };
    }

    // "Cut through": the corridor slices the building — the corridor region is carved out of
    // the footprint, leaving the rest standing (possibly in two pieces). Upserts by building:
    // a later segment crossing the same building EXTENDS the accumulated cut; a cut that eats
    // nearly everything converts to a full demolition. Mutates `records` in place.
    function upsertCutRecord(records, hit, regionFeature, turfApi) {
        const api = turfApi || global.turf;
        const footprintFeature = originalBuildingFeature(hit);
        if (!api || !footprintFeature?.geometry || !regionFeature?.geometry) return records;
        const id = String(hit.id);
        const existingIndex = records.findIndex(record => String(record?.id) === id);
        const existing = existingIndex >= 0 ? records[existingIndex] : null;
        if (existing && !existing.remainder) return records; // already fully demolished

        const footprint = existing
            ? { type: 'Feature', properties: {}, geometry: existing.geometry }
            : footprintFeature;
        let part = null;
        try { part = api.intersect(footprint, regionFeature); } catch (error) {
            console.error('[corridor-tunnel] cut intersection failed', id, error);
            return records;
        }
        if (!part || (Number(api.area(part)) || 0) < 2) return records;

        let accumulated = part;
        if (existing && existing.demolishedPart) {
            try {
                accumulated = api.union(part, { type: 'Feature', properties: {}, geometry: existing.demolishedPart }) || part;
            } catch (error) {
                console.error('[corridor-tunnel] cut accumulation failed — using the new part only', id, error);
            }
        }
        let remainder = null;
        try { remainder = api.difference(footprint, accumulated); } catch (error) {
            console.error('[corridor-tunnel] cut remainder failed — demolishing whole', id, error);
        }
        const footprintArea = Number(api.area(footprint)) || 0;
        const remainderArea = remainder ? (Number(api.area(remainder)) || 0) : 0;
        const record = (!remainder || remainderArea < Math.max(10, footprintArea * 0.15))
            ? { id, geometry: footprint.geometry }
            : { id, geometry: footprint.geometry, demolishedPart: accumulated.geometry, remainder: remainder.geometry };
        if (existingIndex >= 0) records[existingIndex] = record;
        else records.push(record);
        return records;
    }

    // Connected local roads become one proposal. If both pieces cut the same large building they
    // arrive here as two records with the same object_id; a Map lookup can retain only one and used
    // to make the other road appear to pass underneath an uncut part of the building. Recompute one
    // authoritative record per building against the whole merged SURFACE footprint (tunnels omitted).
    function consolidateCorridorDemolitionRecords(records, region, turfApi) {
        const api = turfApi || global.turf;
        const regionFeature = normalizeBuildingFeature(region);
        if (!api || !regionFeature?.geometry) return (records || []).map(record => JSON.parse(JSON.stringify(record)));

        const grouped = new Map();
        (records || []).forEach(record => {
            if (!record?.id || !record.geometry) return;
            const id = String(record.id);
            if (!grouped.has(id)) grouped.set(id, []);
            grouped.get(id).push(record);
        });

        const consolidated = [];
        grouped.forEach((buildingRecords, id) => {
            // One record already contains the exact draw-time decision and subtraction. Recompute
            // only the ambiguous duplicate case introduced by merging two independently cut roads.
            if (buildingRecords.length === 1) {
                consolidated.push(JSON.parse(JSON.stringify(buildingRecords[0])));
                return;
            }
            const full = buildingRecords.find(record => !record.remainder);
            if (full) {
                consolidated.push(JSON.parse(JSON.stringify(full)));
                return;
            }
            const geometry = buildingRecords[0]?.geometry;
            if (!geometry) return;
            upsertCutRecord(consolidated, {
                id,
                feature: { type: 'Feature', properties: {}, geometry }
            }, regionFeature, api);
        });
        return consolidated;
    }

    // One building may be cut by several INDEPENDENT applied proposals. Collapse those records into
    // one authoritative carve against the largest stored original footprint. The removed parts are
    // unioned, then the remainder threshold is applied to the combined result—not separately per
    // road—so crossing a previously cut building cannot resurrect either cut or leave a sliver.
    function consolidateBuildingDemolitionRecords(records, turfApi) {
        const api = turfApi || global.turf;
        const source = Array.isArray(records) ? records.filter(record => record?.id && record.geometry) : [];
        if (!api || typeof api.area !== 'function' || typeof api.union !== 'function'
            || typeof api.difference !== 'function') {
            return source.map(record => JSON.parse(JSON.stringify(record)));
        }

        const grouped = new Map();
        source.forEach(record => {
            const id = String(record.id);
            if (!grouped.has(id)) grouped.set(id, []);
            grouped.get(id).push(record);
        });

        const consolidated = [];
        grouped.forEach((buildingRecords, id) => {
            const full = buildingRecords.find(record => !record.remainder);
            if (full) {
                consolidated.push(JSON.parse(JSON.stringify(full)));
                return;
            }
            if (buildingRecords.length === 1) {
                consolidated.push(JSON.parse(JSON.stringify(buildingRecords[0])));
                return;
            }

            let footprintGeometry = null;
            let footprintArea = -1;
            buildingRecords.forEach(record => {
                try {
                    const feature = { type: 'Feature', properties: {}, geometry: record.geometry };
                    const area = Number(api.area(feature)) || 0;
                    if (area > footprintArea) {
                        footprintArea = area;
                        footprintGeometry = record.geometry;
                    }
                } catch (_) { }
            });
            if (!footprintGeometry) return;

            let removed = null;
            buildingRecords.forEach(record => {
                let partGeometry = record.demolishedPart || null;
                if (!partGeometry && record.remainder) {
                    try {
                        const derived = api.difference(
                            { type: 'Feature', properties: {}, geometry: footprintGeometry },
                            { type: 'Feature', properties: {}, geometry: record.remainder }
                        );
                        partGeometry = derived?.geometry || null;
                    } catch (_) { }
                }
                if (!partGeometry) return;
                const part = { type: 'Feature', properties: {}, geometry: partGeometry };
                if (!removed) {
                    removed = part;
                    return;
                }
                try { removed = api.union(removed, part) || removed; } catch (error) {
                    console.error('[corridor-tunnel] cross-proposal cut accumulation failed', id, error);
                }
            });
            if (!removed) {
                consolidated.push(JSON.parse(JSON.stringify(buildingRecords[buildingRecords.length - 1])));
                return;
            }

            let remainder = null;
            const footprint = { type: 'Feature', properties: {}, geometry: footprintGeometry };
            try { remainder = api.difference(footprint, removed); } catch (error) {
                console.error('[corridor-tunnel] cross-proposal cut remainder failed — demolishing whole', id, error);
            }
            const remainderArea = remainder ? (Number(api.area(remainder)) || 0) : 0;
            if (!remainder || remainderArea < Math.max(10, Math.max(0, footprintArea) * 0.15)) {
                consolidated.push({ id, geometry: JSON.parse(JSON.stringify(footprintGeometry)) });
                return;
            }
            consolidated.push({
                id,
                geometry: JSON.parse(JSON.stringify(footprintGeometry)),
                demolishedPart: JSON.parse(JSON.stringify(removed.geometry)),
                remainder: JSON.parse(JSON.stringify(remainder.geometry))
            });
        });
        return consolidated;
    }

    // Buildings under a demolition region (park/square/lake footprint, or a building
    // proposal's parcels): the region clears its ground by DEFAULT, no prompt —
    // proposal-owned buildings are unapplied silently (kept in the list), real ones are
    // returned as demolition records. Buildings straddling the region boundary are
    // demolished PARTIALLY (see splitDemolitionFootprint).
    async function demolishBuildingsUnderFootprint(geometry) {
        const records = [];
        if (!geometry || !geometry.type) return records;
        const regionFeature = { type: 'Feature', properties: {}, geometry };
        // Load footprints for the REGION itself — the pool only covers viewports the user
        // fetched, and a building never loaded can never be detected or demolished.
        if (typeof global.ensureBuildingFootprintsForBounds === 'function' && global.turf?.bbox) {
            try {
                const [west, south, east, north] = global.turf.bbox(regionFeature);
                await global.ensureBuildingFootprintsForBounds([[south, west], [north, east]]);
            } catch (error) {
                console.error('[corridor-tunnel] footprint preload for demolition region failed', error);
            }
        }
        const hits = findBuildingTunnelIntersections(regionFeature, collectLoadedCorridorBuildings(), global.turf);
        for (const hit of hits) {
            const owner = tunnelHitProposalId(hit);
            if (owner) {
                try {
                    await global.ProposalManager?.unapplyProposal?.(owner, { skipConfirm: true, skipRestoreSource: true });
                } catch (error) {
                    console.error('[corridor-tunnel] could not unapply building proposal under structure', owner, error);
                }
                continue;
            }
            const footprintFeature = originalBuildingFeature(hit);
            let footprint = null;
            try {
                footprint = JSON.parse(JSON.stringify(footprintFeature?.geometry || null));
            } catch (error) {
                console.error('[corridor-tunnel] could not capture demolished footprint — it will still render in 3D', hit.id, error);
            }
            const split = footprintFeature ? splitDemolitionFootprint(footprintFeature, regionFeature, global.turf) : { full: true };
            if (!split) continue; // clip below threshold: building untouched
            if (split.full) {
                records.push({ id: String(hit.id), geometry: footprint });
            } else {
                records.push({
                    id: String(hit.id),
                    geometry: footprint,
                    demolishedPart: JSON.parse(JSON.stringify(split.demolishedPart)),
                    remainder: JSON.parse(JSON.stringify(split.remainder))
                });
            }
        }
        return records;
    }

    function collectDemolishedBuildingIds() {
        return new Set(collectDemolishedBuildingRecords().map(record => String(record.id)));
    }

    // Building ids TUNNELLED under any applied corridor — mirrors collectDemolishedBuildingIds, but
    // for tunnel records (a tunnel writes no demolition record, so those buildings are otherwise
    // invisible to the carve). Feeds the persistent 2D "tunnelled = yellow" footprint colour.
    function collectTunnelledBuildingIds() {
        const ids = new Set();
        try {
            (global.proposalStorage?.getAllProposals?.() || []).forEach(proposal => {
                const rp = proposal && proposal.roadProposal;
                if (!rp || !rp.definition || !appliedOf(proposal, rp)) return;
                (rp.definition.tunnels || []).forEach(record => {
                    (record?.buildingIds || []).forEach(id => { if (id != null) ids.add(String(id)); });
                });
            });
        } catch (error) {
            console.error('[corridor-tunnel] tunnelled-building scan failed', error);
        }
        return ids;
    }

    // The persistent 2D outcome of a building given the applied carve + tunnel state. A demolition
    // record without a remainder is a full raze; with a remainder it's a cut; a tunnelled id is a
    // tunnel; anything else is untouched. Priority raze > cut > tunnel (a razed building stays razed).
    function classifyBuildingOutcome(id, { demolishedById, tunnelledIds } = {}) {
        const key = String(id);
        const record = (demolishedById && typeof demolishedById.get === 'function') ? demolishedById.get(key) : null;
        if (record) return record.remainder ? 'cut' : 'destroyed';
        if (tunnelledIds && typeof tunnelledIds.has === 'function' && tunnelledIds.has(key)) return 'tunnelled';
        return null;
    }

    // Leaflet path style for a building footprint by outcome. Destroyed reads as a dashed red outline
    // with NO fill so the road shows through; cut is solid orange; tunnelled is dashed yellow; an
    // untouched building keeps the default blue.
    function buildingOutcomeStyle(outcome) {
        switch (outcome) {
            case 'destroyed':
                return { color: '#dc2626', weight: 1.5, opacity: 0.95, fill: false, dashArray: '5 4' };
            case 'cut':
                return { color: '#ea580c', weight: 1, opacity: 1, fillColor: '#f97316', fillOpacity: 0.35 };
            case 'tunnelled':
                return { color: '#ca8a04', weight: 1, opacity: 1, fillColor: '#eab308', fillOpacity: 0.3, dashArray: '2 3' };
            default:
                return { color: 'blue', weight: 1, fillColor: 'blue', fillOpacity: 0.2 };
        }
    }

    Object.assign(global, {
        corridorTunnelEdgeKey,
        corridorEdgeFetchSegments,
        corridorBuildingKey,
        applyDemolitionRecordsToBuildingFeatures,
        findBuildingTunnelIntersections,
        collectLoadedCorridorBuildings,
        ensureCorridorBuildingFootprintsLoaded,
        corridorFeatureFromLatLngRing,
        detectLoadedBuildingTunnelIntersections,
        makeBuildingTunnelRecord,
        addBuildingTunnelRecord,
        removeBuildingTunnelEdge,
        corridorSurfaceRuns,
        retainLiveCorridorTunnelRecords,
        collectDemolishedBuildingIds,
        collectDemolishedBuildingRecords,
        clipCorridorEdgeThroughBuildings,
        demolishBuildingsUnderFootprint,
        splitDemolitionFootprint,
        upsertCutRecord,
        consolidateCorridorDemolitionRecords,
        consolidateBuildingDemolitionRecords,
        corridorTunnelHitProposalId: tunnelHitProposalId,
        collectObstacleProposalImpacts,
        buildBuildingObstaclePrompt,
        partitionObstacleHits,
        resolveBuildingObstacles,
        collectTunnelledBuildingIds,
        classifyBuildingOutcome,
        buildingOutcomeStyle
    });

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            corridorTunnelEdgeKey,
            corridorEdgeFetchSegments,
            corridorBuildingKey,
            applyDemolitionRecordsToBuildingFeatures,
            findBuildingTunnelIntersections,
            corridorFeatureFromLatLngRing,
            makeBuildingTunnelRecord,
            addBuildingTunnelRecord,
            removeBuildingTunnelEdge,
            corridorSurfaceRuns,
            retainLiveCorridorTunnelRecords,
            clipCorridorEdgeThroughBuildings,
            demolishBuildingsUnderFootprint,
            splitDemolitionFootprint,
            upsertCutRecord,
            consolidateCorridorDemolitionRecords,
            consolidateBuildingDemolitionRecords,
            collectObstacleProposalImpacts,
            buildBuildingObstaclePrompt,
            partitionObstacleHits,
            resolveBuildingObstacles,
            collectTunnelledBuildingIds,
            classifyBuildingOutcome,
            buildingOutcomeStyle
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
