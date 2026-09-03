// Detects when a corridor being drawn crosses an applied park/square/lake. The drawing may continue
// or reroute; it never changes proposal state. The eventual road snapshot wins through replay.
(function attachCorridorStructures(global) {
    let promptActive = false;

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

    // Returns true when drawing may continue, false to reroute.
    async function resolveStructureCrossings(hits, corridorKind = 'road') {
        if (!Array.isArray(hits) || !hits.length) return true;
        if (promptActive) return false;
        promptActive = true;
        try {
            const names = hits.map(structureDisplayName).map(name => `“${name}”`).join(', ');
            const kind = corridorKind === 'track'
                ? structureText('modal.corridorTunnel.track', 'track')
                : structureText('modal.corridorTunnel.road', 'road');
            const message = structureText(
                'modal.corridorStructure.offer',
                'This {{kind}} would cross {{names}}. Build through it? The later {{kind}} takes the crossing ground during replay.',
                { kind, names }
            );
            let accepted = false;
            if (typeof global.showStyledChoice === 'function') {
                accepted = (await global.showStyledChoice(message, [
                    { value: 'build', label: structureText('modal.corridorStructure.buildThrough', 'Build through'), primary: true },
                    { value: 'cancel', label: structureText('modal.corridorTunnel.cancel', 'Choose another route') }
                ])) === 'build';
            } else if (typeof global.showStyledConfirm === 'function') {
                accepted = await global.showStyledConfirm(message, {
                    okText: structureText('modal.corridorStructure.buildThrough', 'Build through'),
                    cancelText: structureText('modal.corridorTunnel.cancel', 'Choose another route')
                });
            }
            if (accepted) hits.forEach(entry => approvedStructureIds.add(entry.id));
            return accepted;
        } finally {
            promptActive = false;
        }
    }

    function resetApprovedStructureCrossings() {
        approvedStructureIds.clear();
    }

    Object.assign(global, {
        detectStructureCrossings,
        resolveStructureCrossings,
        resetApprovedStructureCrossings
    });
})(typeof window !== 'undefined' ? window : globalThis);
