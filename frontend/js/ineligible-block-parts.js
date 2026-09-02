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

    function featureParcelId(feature, fallback) {
        const props = feature && feature.properties ? feature.properties : {};
        const value = props.parcelId ?? props.parcel_id ?? props.id ?? fallback;
        return value === undefined || value === null ? '' : String(value);
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
        const resolveParcelFeatures = typeof options.resolveParcelFeatures === 'function'
            ? options.resolveParcelFeatures
            : () => [];
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

            const entriesByParcel = new Map();
            buildingProposal.ineligibleParcels.forEach(entry => {
                if (!entry || entry.parcelId === undefined || entry.parcelId === null) return;
                const parcelId = String(entry.parcelId);
                if (!parcelId || entriesByParcel.has(parcelId)) return;
                entriesByParcel.set(parcelId, entry);
            });

            entriesByParcel.forEach((entry, sourceParcelId) => {
                const seenPlots = new Set();
                let resolved = [];
                try {
                    const value = resolveParcelFeatures(sourceParcelId, record);
                    resolved = Array.isArray(value) ? value : [];
                } catch (_) { resolved = []; }

                resolved.forEach(rawFeature => {
                    const feature = normalizeFeature(rawFeature);
                    if (!feature || !feature.geometry) return;
                    const parcelId = featureParcelId(feature, sourceParcelId);
                    const key = `${parcelId}\u0000${geometryKey(feature.geometry)}`;
                    if (seenPlots.has(key)) return;
                    seenPlots.add(key);
                    parts.push({
                        type: 'Feature',
                        properties: {
                            ineligible: true,
                            kind: 'plot',
                            parcelId,
                            sourceParcelId,
                            exclusionStatus: entry.status || null,
                            proposalId: proposalKey
                        },
                        geometry: feature.geometry
                    });
                });

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
                        parcelId: sourceParcelId,
                        sourceParcelId,
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
