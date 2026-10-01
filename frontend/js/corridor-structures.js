// Detects when a corridor being drawn crosses an applied park/square/lake, or applied
// subdivision/readjustment plots (proposals/plot-crossings.js). The drawing may continue or reroute;
// it never changes proposal state. The eventual road snapshot wins through replay.
(function attachCorridorStructures(global) {
    let promptActive = false;

    // Structures the user already agreed to build through in the current drawing session.
    const approvedStructureIds = new Set();
    // Plot proposals (subdivisions/readjustments) agreed to build through, same lifetime.
    const approvedPlotProposalIds = new Set();

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

    function appliedPlotRecords(plots) {
        const all = global.proposalStorage?.getAllProposals?.() || [];
        const applied = typeof global.isProposalApplied === 'function'
            ? record => global.isProposalApplied(record)
            : record => record.applied === true;
        return all.filter(record => plots.isPlotRecord(record) && applied(record));
    }

    // Plots of applied subdivisions/readjustments the edge would cut (not yet agreed to), and
    // houses on such plots it would run through. `buildingHits` are the edge's building hits
    // (corridor-tunnel.js detectLoadedBuildingTunnelIntersections); only proposal buildings count.
    function detectPlotCrossings(corridorRing, buildingHits) {
        const plots = global.__plotCrossings;
        const api = global.turf;
        const empty = { plots: [], blocked: [] };
        if (!plots || !api || typeof global.corridorFeatureFromLatLngRing !== 'function') return empty;
        const corridorFeature = global.corridorFeatureFromLatLngRing(corridorRing);
        const fabric = global.LiveParcelFabric;
        if (!corridorFeature || !fabric || typeof fabric.queryBounds !== 'function') return empty;
        let pieces = [];
        try {
            pieces = fabric.queryBounds(api.bbox(corridorFeature), { includeCorridors: false });
        } catch (error) {
            console.warn('[corridor-structures] plot query failed', error);
            return empty;
        }
        const buildings = (Array.isArray(buildingHits) ? buildingHits : [])
            .map(hit => hit && (hit.feature || hit))
            .filter(feature => feature && feature.geometry && feature.properties && feature.properties.proposalId);
        return plots.detectPlotCrossings(corridorFeature, {
            pieces,
            buildings,
            lookupProposal: id => (typeof global.getProposalByIdOrHash === 'function' ? global.getProposalByIdOrHash(id) : null),
            plotRecords: appliedPlotRecords(plots),
            approvedIds: approvedPlotProposalIds
        });
    }

    // Returns true when drawing may continue (nothing to ask, or Build through), false to reroute.
    // With a house in the way only "Choose another route" is offered: the apply would refuse it.
    async function resolvePlotCrossings(result, corridorKind = 'road') {
        const plots = global.__plotCrossings;
        const prompt = plots ? plots.plotCrossingPrompt(result, {
            t: structureText,
            corridorKind,
            formatArea: m2 => `${Math.round(m2).toLocaleString()} m²`
        }) : null;
        if (!prompt) return true;
        if (promptActive) return false;
        promptActive = true;
        try {
            let answer = 'cancel';
            if (typeof global.showStyledChoice === 'function') {
                answer = await global.showStyledChoice(prompt.message, prompt.choices);
            } else if (typeof global.showStyledConfirm === 'function' && !prompt.blocked) {
                answer = (await global.showStyledConfirm(prompt.message, {
                    okText: prompt.choices[0].label,
                    cancelText: prompt.choices[1].label
                })) ? 'build' : 'cancel';
            } else if (typeof global.showStyledAlert === 'function') {
                await global.showStyledAlert(prompt.message);
            }
            const accepted = answer === 'build' && !prompt.blocked;
            if (accepted) result.plots.forEach(entry => approvedPlotProposalIds.add(entry.proposalId));
            return accepted;
        } finally {
            promptActive = false;
        }
    }

    function resetApprovedStructureCrossings() {
        approvedStructureIds.clear();
        approvedPlotProposalIds.clear();
    }

    Object.assign(global, {
        detectStructureCrossings,
        resolveStructureCrossings,
        detectPlotCrossings,
        resolvePlotCrossings,
        resetApprovedStructureCrossings
    });
})(typeof window !== 'undefined' ? window : globalThis);
