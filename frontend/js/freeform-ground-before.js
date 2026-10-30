// The ground under an applied design as it stood before that design, for the Freeform land review:
// the other applied designs replayed on a private copy of their cadastral parcels (the replay Plan
// stats uses, AgreementHeadless.materialize), so every plot keeps its own outline even where this
// design's building now covers the line between two plots.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.FreeformGroundBefore = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';
    const idsOf = record => (Array.isArray(record?.cadastreParcelIds) ? record.cadastreParcelIds : []).map(String);

    // What the replay needs: every applied design except `ownId` that declares one of the parcels,
    // and every parcel those designs declare, until nothing new is reached (a design's pieces are
    // formed from all the parcels it declares).
    function replayScope(records, startIds, ownId) {
        const ids = new Set((startIds || []).map(String));
        const others = (records || []).filter(record => String(record.proposalId) !== String(ownId) && idsOf(record).length);
        const designs = new Set();
        for (let grew = true; grew;) {
            grew = false;
            for (const record of others) {
                if (designs.has(record) || !idsOf(record).some(id => ids.has(id))) continue;
                designs.add(record);
                idsOf(record).forEach(id => { if (!ids.has(id)) { ids.add(id); grew = true; } });
                grew = true;
            }
        }
        return { ids: [...ids].sort(), designs: others.filter(record => designs.has(record)) };
    }

    // { ids, pieces }: the non-corridor pieces of those parcels with every applied design but
    // `ownId` formed on them. The parcels must be loadable; a replay that refuses throws.
    async function read({ ownId, cadastreIds }) {
        const win = root;
        const applied = win.proposalStorage.getAllProposals().filter(record => win.isApplied(record));
        const scope = replayScope(applied, cadastreIds, ownId);
        // A design moved off every parcel stands on no ground: nothing to replay.
        if (!scope.ids.length) return { ids: [], pieces: [] };
        await win.CadastralParcelRepository.ensureIds(scope.ids);
        const parcels = win.CadastralParcelRepository.getMany(scope.ids);
        const missing = scope.ids.filter(id => !parcels.some(parcel => String(parcel.properties?.parcelId ?? parcel.id) === id));
        if (missing.length) throw new Error(`Cadastral parcels could not be loaded for the land review: ${missing.join(', ')}`);
        const started = Date.now();
        const result = await win.AgreementHeadless.materialize({
            designs: scope.designs.map(record => ({ cid: record.proposalId, content: win.DesignRecord.published(record),
                parcelIds: idsOf(record), binding: record.binding || null })),
            parcels
        });
        console.log(`[${new Date().toISOString()}] [land-take] ground before ${ownId}: ${scope.designs.length} designs on ${scope.ids.length} parcels replayed in ${Date.now() - started} ms`);
        return { ids: scope.ids, pieces: result.fabric.entriesForCadastre(scope.ids, { includeCorridors: false }) };
    }
    return { replayScope, read };
});
