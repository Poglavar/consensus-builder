// What stands above and below one object in the click stack (click-stack.md "Neighbours"): read
// from the selected object's own references through lookups the caller passes, so the stack
// reaches the same sections whether it was opened by a map click, a list, a link or a plan. The
// arrival path only chooses what is selected and expanded. Pure: no DOM, no globals.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ClickStackNeighbours = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const idsOf = list => Array.from(new Set((Array.isArray(list) ? list : []).map(value => (value == null ? '' : String(value))).filter(Boolean)));

    // lookups (each optional; a missing or failing lookup contributes nothing):
    //   proposalOf(id)            the stored proposal, or null
    //   parcelFeature(id)         the parcel's feature: live ground first, else the cadastral registry
    //   isLive(id)                whether the id is live ground now
    //   formedByDesign(proposal)  [{ id, feature }] the live body pieces the design produced
    //   piecesOfParcel(id)        [{ id, feature, producerId }] live pieces cut from the cadastral parcel
    //   designsOnParcel(id)       [{ id, proposal, serverId }] proposals using the parcel
    //   builtOnParcel(feature)    [{ id, feature, demolition, tunnelled }] existing buildings on it
    //   permittedOnParcel(id)     [{ id, label, item }] permitted massing records for the parcel
    //   permittedParcel(instance) the parcel id a permitted record is for, or null
    //   parcelLabel(id, feature), designLabel(proposal, id), buildingLabel(feature)
    function neighboursOf(kind, instance, lookups = {}) {
        if (!instance) return {};
        const call = (name, ...args) => {
            const fn = lookups[name];
            if (typeof fn !== 'function') return null;
            try { return fn(...args); } catch (error) {
                console.error(`[${new Date().toISOString()}] [ClickStackNeighbours] ${name} failed`, error);
                return null;
            }
        };
        const list = value => (Array.isArray(value) ? value : []);
        const id = String(instance.id);
        const parcelInstance = parcelId => {
            const feature = call('parcelFeature', parcelId);
            return { id: parcelId, label: call('parcelLabel', parcelId, feature) || parcelId, feature: feature || null, live: call('isLive', parcelId) === true };
        };
        const designInstance = (proposal, designId, extra = {}) => ({
            id: String(designId), label: call('designLabel', proposal, designId) || String(designId),
            createdAt: proposal?.createdAt, proposal, goal: proposal?.goal || '', ...extra
        });
        const formedInstance = (piece, producerId) => {
            const producer = producerId ? call('proposalOf', producerId) : null;
            return { id: String(piece.id), label: call('parcelLabel', String(piece.id), piece.feature) || String(piece.id), feature: piece.feature || null,
                designId: producerId || null, designLabel: producer ? (call('designLabel', producer, producerId) || producerId) : producerId || null };
        };
        const producerOf = piece => {
            const value = piece?.producerId ?? piece?.designId ?? piece?.feature?.properties?.producedByProposalId;
            return value == null || String(value) === '' ? null : String(value);
        };

        if (kind === 'designs') {
            const proposal = instance.proposal || call('proposalOf', id);
            if (!proposal) return {};
            const designId = String(proposal.proposalId || id);
            return {
                formed: list(call('formedByDesign', proposal)).map(piece => formedInstance(piece, designId)),
                parcels: idsOf(proposal.cadastreParcelIds).map(parcelInstance)
            };
        }
        if (kind === 'formed') {
            const producerId = producerOf(instance);
            const producer = producerId ? call('proposalOf', producerId) : null;
            return {
                designs: producer ? [designInstance(producer, producerId)] : [],
                parcels: idsOf(instance.feature?.properties?.cadastreParcelIds).map(parcelInstance)
            };
        }
        if (kind === 'parcels') {
            const feature = instance.feature || call('parcelFeature', id);
            return {
                formed: list(call('piecesOfParcel', id)).filter(piece => piece && piece.id != null && String(piece.id) !== id)
                    .map(piece => formedInstance(piece, producerOf(piece))),
                designs: list(call('designsOnParcel', id)).filter(entry => entry?.proposal)
                    .map(entry => designInstance(entry.proposal, entry.id ?? entry.proposal.proposalId, { serverId: entry.serverId || null, onParcel: true })),
                built: feature ? list(call('builtOnParcel', feature)).filter(hit => hit && hit.id != null).map(hit => ({
                    id: String(hit.id), feature: hit.feature, demolition: hit.demolition || null, tunnelled: hit.tunnelled === true,
                    label: call('buildingLabel', hit.feature) || '', onParcel: true })) : [],
                permitted: list(call('permittedOnParcel', id)).filter(item => item && item.id != null).map(item => ({ ...item, id: String(item.id) }))
            };
        }
        if (kind === 'built') return instance.affectedDesign ? { designs: [{ ...instance.affectedDesign, id: String(instance.affectedDesign.id) }] } : {};
        if (kind === 'permitted') {
            const parcelId = call('permittedParcel', instance);
            return parcelId ? { parcels: [parcelInstance(String(parcelId))] } : {};
        }
        return {};
    }

    // The hits with the selected object's neighbours merged in: instances already present keep
    // their place and their fields (a neighbour only fills what they lack); new ones follow them.
    // Returns { hits, added }: `hits` is the same object when nothing changed, so callers can skip
    // a rebuild; `added` lists, per kind, the ids this call appended, so a later selection in the
    // same section can take them out again (withoutInstances).
    function withNeighbours(hits, kind, instance, lookups) {
        const found = neighboursOf(kind, instance, lookups);
        const added = {};
        let changed = false;
        const merged = { ...(hits || {}) };
        for (const [target, additions] of Object.entries(found)) {
            const existing = Array.isArray(merged[target]) ? merged[target] : [];
            const byId = new Map(existing.map(item => [String(item.id), item]));
            const next = existing.slice();
            for (const item of additions) {
                const key = String(item.id);
                const present = byId.get(key);
                if (!present) { byId.set(key, item); next.push(item); (added[target] ||= []).push(key); changed = true; continue; }
                const filled = { ...item, ...present };
                for (const field of Object.keys(item)) {
                    if (present[field] == null && item[field] != null) { filled[field] = item[field]; changed = true; }
                }
                next[next.indexOf(present)] = filled;
            }
            merged[target] = next;
        }
        return { hits: changed ? merged : hits, added };
    }

    // The hits without the instances `removed` names per kind, except those `protect` names per
    // kind (what the stack arrived with, what another selection derived, what is selected now).
    // Returns the same object when nothing is taken out.
    function withoutInstances(hits, removed = {}, protect = {}) {
        let changed = false;
        const merged = { ...(hits || {}) };
        for (const [kind, ids] of Object.entries(removed)) {
            const drop = new Set((ids || []).map(String));
            const keep = new Set((protect[kind] || []).map(String));
            const list = Array.isArray(merged[kind]) ? merged[kind] : [];
            const next = list.filter(item => !drop.has(String(item.id)) || keep.has(String(item.id)));
            if (next.length !== list.length) { merged[kind] = next; changed = true; }
        }
        return changed ? merged : hits;
    }

    return Object.freeze({ neighboursOf, withNeighbours, withoutInstances });
});
