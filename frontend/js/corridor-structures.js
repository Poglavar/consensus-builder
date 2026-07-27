// Detects when a corridor being drawn crosses an applied park/square/lake and walks the user
// through it: unapply the structure, build through it (the road visually cuts the structure,
// which stays ONE proposal), or reroute. Approvals are remembered per drawing session.
(function attachCorridorStructures(global) {
    let promptActive = false;

    // Resolver alias for the canonical applied accessor: the browser global wins; node tests require it.
    const appliedOf = (typeof isApplied === 'function') ? isApplied : require('./proposals/status.js').isApplied;
    // Structures the user already agreed to build through in the current drawing session.
    const approvedStructureIds = new Set();

    function structureText(key, fallback, params = {}) {
        try {
            if (global.i18n && typeof global.i18n.t === 'function') {
                const value = global.i18n.t(key, params);
                if (value && value !== key) return value;
            }
        } catch (_) { }
        return fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => params[name] ?? '');
    }

    function collectAppliedStructureFeatures() {
        const out = [];
        const push = (list, kind) => {
            (Array.isArray(list) ? list : []).forEach((feature, index) => {
                if (!feature || !feature.geometry) return;
                const proposalId = feature.properties?.proposalId ? String(feature.properties.proposalId) : null;
                out.push({ id: proposalId || `${kind}:${index}`, proposalId, kind, feature });
            });
        };
        push(global.parks, 'park');
        push(global.squares, 'square');
        push(global.lakes, 'lake');
        return out;
    }

    function structureDisplayName(entry) {
        if (entry.proposalId && typeof global.getProposalByIdOrHash === 'function') {
            const proposal = global.getProposalByIdOrHash(entry.proposalId);
            const name = proposal && (proposal.title || proposal.name || proposal.proposalName);
            if (name) return String(name);
        }
        return structureText(`modal.corridorStructure.kinds.${entry.kind}`, entry.kind);
    }

    // Structures the given corridor ring meaningfully overlaps (ignoring already-approved ones).
    function detectStructureCrossings(corridorRing, minimumArea = 1) {
        if (typeof global.corridorFeatureFromLatLngRing !== 'function') return [];
        const corridorFeature = global.corridorFeatureFromLatLngRing(corridorRing);
        const api = global.turf;
        if (!corridorFeature || !api || typeof api.intersect !== 'function') return [];
        return collectAppliedStructureFeatures().filter(entry => {
            if (approvedStructureIds.has(entry.id)) return false;
            try {
                const intersection = api.intersect(corridorFeature, entry.feature);
                if (!intersection) return false;
                const area = typeof api.area === 'function' ? Number(api.area(intersection)) : minimumArea;
                return Number.isFinite(area) && area >= minimumArea;
            } catch (_) {
                return false;
            }
        });
    }

    // Three-way decision for the detected crossings. Returns true when drawing may continue
    // (structures unapplied or approved for build-through), false to reroute.
    async function resolveStructureCrossings(hits, corridorKind = 'road') {
        if (!Array.isArray(hits) || !hits.length) return true;
        if (promptActive) return false;
        promptActive = true;
        try {
            let remaining = hits.slice();
            while (remaining.length) {
                const unappliable = remaining.filter(entry => entry.proposalId);
                const names = remaining.map(structureDisplayName).map(name => `“${name}”`).join(', ');
                const kind = corridorKind === 'track'
                    ? structureText('modal.corridorTunnel.track', 'track')
                    : structureText('modal.corridorTunnel.road', 'road');
                const message = structureText(
                    'modal.corridorStructure.offer',
                    'This {{kind}} would cross {{names}}. Build through it? The {{kind}} cuts through; the rest stays as it is.',
                    { kind, names }
                );
                const choices = [];
                if (unappliable.length) {
                    choices.push({ value: 'unapply', label: structureText('modal.corridorTunnel.unapply', 'Unapply existing proposal') });
                }
                choices.push({ value: 'build', label: structureText('modal.corridorStructure.buildThrough', 'Build through'), primary: true });
                choices.push({ value: 'cancel', label: structureText('modal.corridorTunnel.cancel', 'Choose another route') });

                let answer = 'cancel';
                if (typeof global.showStyledChoice === 'function') {
                    answer = (await global.showStyledChoice(message, choices)) || 'cancel';
                } else if (typeof global.showStyledConfirm === 'function') {
                    answer = (await global.showStyledConfirm(message, {
                        okText: structureText('modal.corridorStructure.buildThrough', 'Build through'),
                        cancelText: structureText('modal.corridorTunnel.cancel', 'Choose another route')
                    })) ? 'build' : 'cancel';
                }

                if (answer === 'build') {
                    remaining.forEach(entry => approvedStructureIds.add(entry.id));
                    return true;
                }
                if (answer !== 'unapply') return false;
                for (const entry of unappliable) {
                    try {
                        await global.ProposalManager?.unapplyProposal?.(entry.proposalId, { skipConfirm: true });
                    } catch (error) {
                        console.warn('[corridor-structures] could not unapply structure proposal', entry.proposalId, error);
                    }
                }
                remaining = remaining.filter(entry => !entry.proposalId);
            }
            return true;
        } finally {
            promptActive = false;
        }
    }

    function resetApprovedStructureCrossings() {
        approvedStructureIds.clear();
    }

    // Persist/seed the build-through approvals so continuing an applied road does not re-ask about a
    // structure it already runs through. The approval was session-only; the road definition now carries
    // the approved structure ids (serialiseRoadDefinition) and seedRoadDrawing feeds them back here —
    // the same reuse buildings/tunnels get. Only proposalId-based ids survive a reload meaningfully.
    function getApprovedStructureIds() {
        return [...approvedStructureIds];
    }
    function seedApprovedStructureCrossings(ids) {
        (Array.isArray(ids) ? ids : []).forEach(id => { if (id) approvedStructureIds.add(String(id)); });
    }

    // Applied structure proposals whose geometry covers the given parcel (centroid test).
    // Id-based matching fails when a structure's declared parcel ids drifted (old imports);
    // geometry doesn't drift, so clicking inside a lake finds the lake regardless.
    function structureProposalsCoveringFeature(parcelFeature) {
        const out = [];
        if (!parcelFeature || !parcelFeature.geometry || typeof global.turf === 'undefined') return out;
        let centroid = null;
        try { centroid = global.turf.centroid(parcelFeature); } catch (_) { return out; }
        collectAppliedStructureFeatures().forEach(entry => {
            if (!entry.proposalId) return;
            try {
                if (global.turf.booleanPointInPolygon(centroid, entry.feature)) out.push(entry.proposalId);
            } catch (_) { }
        });
        return [...new Set(out)];
    }

    // Same rescue for roads: an applied corridor whose declared parent/child ids drifted
    // (old imports, cross-device slice drift) still lists on the parcels its footprint
    // actually covers. Intersection AREA is required — merely touching a shared boundary
    // must not put the road on every neighbouring parcel.
    function roadProposalsCoveringFeature(parcelFeature) {
        const out = [];
        if (!parcelFeature || !parcelFeature.geometry || typeof global.turf === 'undefined') return out;
        const proposals = global.proposalStorage?.getAllProposals?.() || [];
        proposals.forEach(proposal => {
            const road = proposal?.roadProposal;
            const definition = road?.definition;
            const polygon = definition?.polygon;
            if (!polygon || !polygon.type) return;
            if (!appliedOf(proposal, road)) return;
            const proposalId = proposal.proposalId || proposal.id;
            if (!proposalId) return;
            try {
                const intersection = global.turf.intersect(parcelFeature, { type: 'Feature', properties: {}, geometry: polygon });
                if (intersection && (Number(global.turf.area(intersection)) || 0) > 2) out.push(proposalId);
            } catch (_) { }
        });
        return [...new Set(out)];
    }

    Object.assign(global, {
        detectStructureCrossings,
        resolveStructureCrossings,
        resetApprovedStructureCrossings,
        getApprovedStructureIds,
        seedApprovedStructureCrossings,
        structureProposalsCoveringFeature,
        roadProposalsCoveringFeature
    });
})(typeof window !== 'undefined' ? window : globalThis);
