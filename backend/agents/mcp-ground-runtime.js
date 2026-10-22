// An isolated node host for the browser's formation handlers. Only presentation/storage effects
// are ports; parcel identity, clipping, precedence, provenance and ground derivation stay in the app.
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const root = new URL('../../frontend/js/', import.meta.url);
const scripts = [
    'cid.js', 'agreement-record.js', 'agreement-ground.js', 'work-slicer.js', 'proposals/parcel-contiguity.js',
    'proposals/footprint-parts.js', 'proposals/parcel-arrangement.js', 'proposals/plan-order.js', 'proposals/formation-edit.js',
    'parcel-layout-validation.js', 'parcel-layout-record.js', 'parcel-layout-ownership.js',
    'parcels/live-fabric.js', 'proposals/apply/road.js', 'proposals/apply/buildings.js', 'proposals/apply/structures.js', 'proposals/apply/parcels.js'
].map(path => ({ path, source: readFileSync(new URL(path, root), 'utf8'), require: createRequire(new URL(path, root)) }));
const classic = ['proposal-parcel-identity.js', 'proposal-road-geometry.js', 'proposals/apply/finalize.js', 'proposal-manager.js']
    .map(path => ({ path, source: readFileSync(new URL(path, root), 'utf8') }));

export async function deriveWithApp({ designs, parcels, ownerOf = () => [] }) {
    const ctx = createContext({ turf, console, structuredClone, performance, URL, TextEncoder, Uint8Array, Buffer });
    ctx.window = ctx;
    ctx.require = createRequire(new URL('proposal-manager.js', root));
    for (const script of scripts) {
        ctx.__moduleRequire = script.require;
        runInContext(`(function(require) {\n${script.source}\n})(__moduleRequire);`, ctx, { filename: script.path, timeout: 10_000 });
    }
    for (const script of classic) {
        ctx.require = createRequire(new URL(script.path, root));
        runInContext(script.source, ctx, { filename: script.path, timeout: 10_000 });
    }
    const fabric = ctx.createLiveParcelFabric({ geometry: turf });
    const mutation = fabric.beginMutation({ kind: 'mcp-ground' });
    const source = parcels.map(p => ({ ...structuredClone(p), properties: { ...p.properties, parcelId: String(p.id ?? p.properties.parcelId) } }));
    mutation.seedCadastre(source);
    const originals = new Map(source.map(f => [f.properties.parcelId, f]));
    const rows = designs.map(d => ({ ...structuredClone(d.content), proposalId: d.cid, cadastreParcelIds: d.parcelIds,
        createdAt: d.content.authoredAt, applied: true, lifecycleStatus: 'active' }));
    const store = { peekAllProposals: () => rows, getAllProposals: () => rows, getProposal: id => rows.find(r => r.proposalId === id), _indexProposal() {}, save() {} };
    const options = { deferPresentation: true, _parcelMutation: { fabric: mutation, proposals: store, storage: { getItem: () => null }, agents: { getAgent: () => null } } };
    const manager = ctx.ProposalManager;
    let lastFailure;
    // This host has no Leaflet or persistence: effect ports write only the private fabric draft.
    manager._setLastApplyFailure = (_id, failure) => { lastFailure = failure; };
    manager._addFeaturesToMap = async features => mutation.upsertFeatures(features);
    manager._consumeFeaturesFromLiveFabric = features => mutation.removeIds(features.map(f => f.properties.parcelId));
    manager._markParcelProducedByProposal = () => {};
    ctx.isProposalCurrentlyApplied = () => true;
    const roads = rows.filter(r => r.roadProposal).map(r => ({ id: r.proposalId, geometry: r.roadProposal.definition.polygon }));
    const roadPieces = source.flatMap(parcel => ctx.__parcelArrangement.arrangementOf(parcel, parcel.properties.parcelId, roads).pieces
        .map(piece => ctx.__parcelArrangement.featureForPiece(piece, parcel)));
    mutation.replaceCadastreScope([...originals.keys()], roadPieces);
    for (const row of ctx.__planOrder.orderFormations(rows)) {
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
    return ctx.AgreementGround.derive({ designs: rows, fabric, originals, ownerOf, area: turf.area });
}
