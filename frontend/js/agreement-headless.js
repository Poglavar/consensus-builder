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
                // Stations are content on their corridor; the app does not form new ground.
                if (!root.ProposalApplyStructures.structureNeedsGroundFormation(kind)) continue;
                const carved = manager._groundAfterLaterCorridors(row, [row.structureProposal.geometry], options);
                if (!carved.geometries[0]) throw new Error('A later corridor takes the entire structure');
                const record = { ...row, structureProposal: { ...row.structureProposal, geometry: carved.geometries[0] } };
                const parents = manager._resolveLiveFormationParents(record, row.proposalId, kind, options);
                if (!parents.ok) throw Object.assign(new Error(parents.message), lastFailure);
                const formed = await manager._formStructureParcel(row.proposalId, record, record.structureProposal, carved.geometries[0], parents.ids, row.proposalId, parents.features, options);
                if (!formed.ok) throw Object.assign(new Error(lastFailure?.message || 'Structure could not form'), lastFailure);
            } else if (row.buildingProposal) {
                const buildings = row.geometry?.buildings || [];
                const goal = root.__applyRoute.normalizeGoalKey(row.goal);
                if (root.ProposalApplyBuildings.shouldFormOwnBuildingParcel(row, goal, buildings.length)) {
                    // Roads already partition the private live fabric. Resolve the surviving
                    // material and reviewed take against those pieces, just as structure replay
                    // does, while keeping the immutable authored row in the agreement unchanged.
                    const landTake = row.geometry?.landTake;
                    const takeGeometry = landTake?.geometry || landTake;
                    const carved = manager._groundAfterLaterCorridors(row,
                        [buildings[0].geometry, ...(takeGeometry ? [takeGeometry] : [])], options);
                    if (!carved.geometries[0]) throw new Error('A later corridor takes the entire building');
                    const record = { ...row, geometry: { ...row.geometry,
                        buildings: [{ ...buildings[0], geometry: carved.geometries[0] }],
                        ...(takeGeometry ? { landTake: landTake.geometry ? { ...landTake, geometry: carved.geometries[1] } : carved.geometries[1] } : {}) } };
                    const parents = manager._resolveLiveFormationParents(record, row.proposalId, 'building', options);
                    if (!parents.ok) throw new Error(parents.message);
                    const formed = await manager._formBuildingParcel(row.proposalId, record, row.buildingProposal, carved.geometries[0], parents.ids, row.proposalId, parents.features, options);
                    if (!formed.ok) throw Object.assign(new Error(lastFailure?.message || 'Building could not form'), lastFailure);
                }
            }
        }
        // Validate the whole partition against immutable source facts, then derive with AgreementGround.
        mutation.replaceCadastreScope([...originals.keys()], mutation.list());
        await mutation.prepare(); mutation.publish();
        return root.AgreementGround.derive({ designs: rows, fabric, originals, ownerOf });
    }
    return { derive };
});
