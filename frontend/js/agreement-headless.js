// Isolated formation host over the app's own handlers. Effects write only a private fabric;
// the caller supplies a loaded runtime, source parcels and designs, with no DOM or persistence.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgreementHeadless = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    async function derive({ designs, parcels, ownerOf = () => [] }) {
        const turf = root.turf;
        const fabric = root.createLiveParcelFabric({ geometry: turf });
        const mutation = fabric.beginMutation({ kind: 'mcp-ground' });
        const source = parcels.map(p => ({ ...structuredClone(p), properties: { ...p.properties, parcelId: String(p.id ?? p.properties.parcelId) } }));
        mutation.seedCadastre(source);
        const originals = new Map(source.map(f => [f.properties.parcelId, f]));
        const rows = designs.map(d => ({ ...structuredClone(d.content), proposalId: d.cid, cadastreParcelIds: d.parcelIds,
            createdAt: d.content.authoredAt, applied: true, lifecycleStatus: 'active' }));
        const store = { peekAllProposals: () => rows, getAllProposals: () => rows, getProposal: id => rows.find(r => r.proposalId === id), _indexProposal() {}, save() {} };
        const options = { deferPresentation: true, _parcelMutation: { fabric: mutation, proposals: store, storage: { getItem: () => null }, agents: { getAgent: () => null } } };
        const manager = Object.create(root.ProposalManager);
        let lastFailure;
        // This host has no Leaflet or persistence: effect ports write only the private fabric draft.
        manager._setLastApplyFailure = (_id, failure) => { lastFailure = failure; };
        manager._addFeaturesToMap = async features => mutation.upsertFeatures(features);
        manager._consumeFeaturesFromLiveFabric = features => mutation.removeIds(features.map(f => f.properties.parcelId));
        manager._markParcelProducedByProposal = () => {};
        const roads = rows.filter(r => r.roadProposal).map(r => ({ id: r.proposalId, geometry: r.roadProposal.definition.polygon }));
        const roadPieces = source.flatMap(parcel => root.__parcelArrangement.arrangementOf(parcel, parcel.properties.parcelId, roads).pieces
            .map(piece => root.__parcelArrangement.featureForPiece(piece, parcel)));
        mutation.replaceCadastreScope([...originals.keys()], roadPieces);
        for (const row of root.__planOrder.orderFormations(rows)) {
            if (row.parcelLayout) {
                if (!await manager._applyParcelLayoutProposal(row.proposalId, row, options)) throw Object.assign(new Error(lastFailure?.message || 'Layout could not form'), lastFailure);
            } else if (row.structureProposal) {
                const kind = row.structureProposal.kind;
                if (kind === 'station') throw new Error('Station ground requires a corridor attachment in the app');
                const carved = manager._groundAfterLaterCorridors(row, [row.structureProposal.geometry], options);
                if (!carved.geometries[0]) throw new Error('A later corridor takes the entire structure');
                const record = { ...row, structureProposal: { ...row.structureProposal, geometry: carved.geometries[0] } };
                const parents = manager._resolveLiveFormationParents(record, row.proposalId, kind, options);
                if (!parents.ok) throw Object.assign(new Error(parents.message), lastFailure);
                const formed = await manager._formStructureParcel(row.proposalId, record, record.structureProposal, carved.geometries[0], parents.ids, row.proposalId, parents.features, options);
                if (!formed.ok) throw Object.assign(new Error(lastFailure?.message || 'Structure could not form'), lastFailure);
            } else if (row.buildingProposal && !['buildings', 'urban-rule', 'row', 'parcelBased'].includes(row.goal)) {
                throw new Error('Freeform building ground must be reviewed in the app');
            }
        }
        // Validate the whole partition against immutable source facts, then derive with AgreementGround.
        mutation.replaceCadastreScope([...originals.keys()], mutation.list());
        await mutation.prepare(); mutation.publish();
        return root.AgreementGround.derive({ designs: rows, fabric, originals, ownerOf, area: turf.area });
    }
    return { derive };
});
