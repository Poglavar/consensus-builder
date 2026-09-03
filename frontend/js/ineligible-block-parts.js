(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.IneligibleBlockParts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function normalizeFeature(value) {
        if (!value || typeof value !== 'object') return null;
        if (value.type === 'Feature') return value.geometry ? value : null;
        if (value.geometry && value.geometry.type) {
            return {
                type: 'Feature',
                properties: value.properties || {},
                geometry: value.geometry
            };
        }
        return null;
    }

    function geometryKey(geometry) {
        try { return JSON.stringify(geometry || null); } catch (_) { return ''; }
    }

    // Exclusions are authored facts, not something to reverse-engineer from the current map.
    // The renderer receives current live features from its adapter and only turns the explicit
    // records into display features. An empty ineligibleParcels array therefore means exactly
    // what it says: this proposal has no excluded plots.
    function collectAppliedIneligibleBlockParts(options = {}) {
        const records = Array.isArray(options.records) ? options.records : [];
        const isApplied = typeof options.isApplied === 'function'
            ? options.isApplied
            : record => !!(record && record.applied === true);
        const wanted = options.onlyProposalId === undefined || options.onlyProposalId === null
            ? null
            : String(options.onlyProposalId);
        const parts = [];

        records.forEach(record => {
            if (!record || !isApplied(record)) return;
            const proposalId = record.proposalId ?? record.id ?? null;
            if (proposalId === null || proposalId === undefined) return;
            const proposalKey = String(proposalId);
            if (wanted !== null && proposalKey !== wanted) return;

            const buildingProposal = record.buildingProposal;
            if (!buildingProposal || !Array.isArray(buildingProposal.ineligibleParcels)) return;

            const seenPlots = new Set();
            buildingProposal.ineligibleParcels.forEach((entry, index) => {
                if (!entry || typeof entry !== 'object') return;
                const entryId = `${proposalKey}:ineligible:${index}`;
                const plot = normalizeFeature(entry.geometry)
                    || (entry.geometry?.type && entry.geometry?.coordinates
                        ? { type: 'Feature', properties: {}, geometry: entry.geometry }
                        : null);
                if (plot?.geometry) {
                    const key = geometryKey(plot.geometry);
                    if (!seenPlots.has(key)) {
                        seenPlots.add(key);
                        parts.push({
                            type: 'Feature',
                            properties: {
                                ineligible: true,
                                kind: 'plot',
                                parcelId: entryId,
                                exclusionStatus: entry.status || null,
                                proposalId: proposalKey
                            },
                            geometry: plot.geometry
                        });
                    }
                }

                const wouldBe = normalizeFeature(entry.wouldBe)
                    || (entry.wouldBe && entry.wouldBe.type && entry.wouldBe.coordinates
                        ? { type: 'Feature', properties: {}, geometry: entry.wouldBe }
                        : null);
                if (!wouldBe || !wouldBe.geometry) return;
                parts.push({
                    type: 'Feature',
                    properties: {
                        ineligible: true,
                        kind: 'massing',
                        parcelId: entryId,
                        exclusionStatus: entry.status || null,
                        height: entry.height || null,
                        proposalId: proposalKey
                    },
                    geometry: wouldBe.geometry
                });
            });
        });

        return parts;
    }

    return Object.freeze({ collectAppliedIneligibleBlockParts });
});
