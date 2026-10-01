// Binding drift (PARCEL-OPTIONAL.md rule 5): a published record keeps the binding the server
// computed at publish; when the cadastre changes later, the binding the server would compute now
// may differ. This module compares the two (shared by GET /proposals/:id/binding-drift and the
// details panel), turns a drift into the notice the panel shows, and derives the NEW record a
// re-bind publishes — the source record is never edited. Pure; UMD so backend tests and the
// server require it, the browser reads `window.__bindingDrift`.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__bindingDrift = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // Open ground that grows or shrinks by less than this is arithmetic, not a cadastre change
    // (the same 1 m² sliver budget as the live fabric and the arrangement's MIN_PIECE_M2).
    const OPEN_GROUND_CHANGE_M2 = 1;

    // Keys of a published record that belong to that record's identity, publication, chain state or
    // local materialisation — never carried into a derived record. Publish re-stamps the effect
    // (ownershipFlow, cadastreFrame, effectHash) for the new binding.
    const RECORD_STATE_KEYS = Object.freeze([
        'id', 'proposalId', 'serverProposalId', 'hash', 'proposal_id',
        'tokenId', 'nftId', 'mint', 'mintAddress', 'isMinted', 'onchain', 'onchainData', 'onchain_data',
        'acceptedParcelIds', 'ownerAcceptances', 'lifecycleStatus', 'effectiveStatus', 'effective_status',
        'applied', 'appliedAt', 'status', 'localEditAt', 'editSeq', 'revertSnapshot',
        'childParcelIds', 'descendantParcelIds', 'parentFeatures', 'childFeatures', 'formation',
        'parentProposals', 'childProposals', 'parentProposalIds', 'childProposalIds',
        'demolishedBuildings', 'demolitionScanned',
        'createdAt', 'updatedAt', 'created_at', 'updated_at', 'authoredAt',
        'ownershipFlow', 'cadastreFrame', 'effectHash', 'screenshotUrl', 'screenshot_url',
        'editToken', 'agentPaymentId', 'agent_payment_id',
        'proposalDraftId', 'proposalDraftRevision', 'supersededBy', 'supersededByProposalId',
        'replacementOfProposalId', 'sourceProposalId', 'copiedFromProposalId', 'copiedFromName',
        'landFork', 'rebind'
    ]);
    const SUB_PROPOSAL_KEYS = Object.freeze(['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']);
    const SUB_STATE_KEYS = Object.freeze(['applied', 'appliedAt', 'status', 'childParcelIds', 'parentFeatures', 'parentsToRemove', 'formation', 'childFeatures']);

    const isNumber = value => typeof value === 'number' && Number.isFinite(value);

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function parcelEntries(binding) {
        const list = binding && Array.isArray(binding.parcels) ? binding.parcels : [];
        const out = new Map();
        list.forEach(entry => {
            const id = entry && (entry.parcelId ?? entry.id);
            if (id === undefined || id === null || id === '') return;
            out.set(String(id), {
                parcelId: String(id),
                overlapM2: isNumber(entry.overlapM2) ? entry.overlapM2 : null,
                intrusionM: isNumber(entry.intrusionM) ? entry.intrusionM : null
            });
        });
        return out;
    }

    function boundParcelIds(binding) {
        return Array.from(parcelEntries(binding).keys()).sort();
    }

    function openGroundOf(binding) {
        return binding && isNumber(binding.unsurveyedM2) ? binding.unsurveyedM2 : null;
    }

    /**
     * How the binding the server computes now differs from the stored one.
     * @returns {null | { added, removed, coverageChanged, coverage: {from, to}, openGroundM2: {from, to} }}
     *   null when nothing changed. `added`/`removed` are binding entries (current / stored side),
     *   sorted by parcel id. `coverageChanged`: the coverage class differs, or the open ground moved
     *   by at least OPEN_GROUND_CHANGE_M2 (both measured).
     */
    function bindingDrift(stored, current) {
        if (!stored || !current) return null;
        const before = parcelEntries(stored);
        const after = parcelEntries(current);
        const byId = (a, b) => (a.parcelId < b.parcelId ? -1 : a.parcelId > b.parcelId ? 1 : 0);
        const added = Array.from(after.values()).filter(entry => !before.has(entry.parcelId)).sort(byId);
        const removed = Array.from(before.values()).filter(entry => !after.has(entry.parcelId)).sort(byId);
        const fromGround = openGroundOf(stored);
        const toGround = openGroundOf(current);
        const groundMoved = fromGround !== null && toGround !== null
            && Math.abs(toGround - fromGround) >= OPEN_GROUND_CHANGE_M2;
        const coverageChanged = (stored.coverage || null) !== (current.coverage || null) || groundMoved;
        if (!added.length && !removed.length && !coverageChanged) return null;
        return {
            added,
            removed,
            coverageChanged,
            coverage: { from: stored.coverage || null, to: current.coverage || null },
            openGroundM2: { from: fromGround, to: toGround }
        };
    }

    /**
     * The details-panel notice for a drift answer, or null when there is nothing to say.
     * @param response GET /proposals/:id/binding-drift body.
     * @param {{ reboundAs?: object|null }} options a local record already derived from this one.
     */
    function driftNotice(response, options) {
        const opts = options || {};
        const drift = response && response.drift;
        if (!response || response.checkable === false || !drift) return null;
        const added = Array.isArray(drift.added) ? drift.added : [];
        const removed = Array.isArray(drift.removed) ? drift.removed : [];
        const reboundAs = opts.reboundAs || null;
        return {
            addedCount: added.length,
            removedCount: removed.length,
            addedIds: added.map(entry => entry.parcelId),
            removedIds: removed.map(entry => entry.parcelId),
            coverageChanged: !!drift.coverageChanged,
            coverageFrom: drift.coverage ? drift.coverage.from : null,
            coverageTo: drift.coverage ? drift.coverage.to : null,
            storedAt: response.stored && response.stored.computedAt ? response.stored.computedAt : null,
            reboundAs: reboundAs ? {
                proposalId: reboundAs.proposalId || null,
                serverProposalId: reboundAs.serverProposalId || null,
                title: reboundAs.title || reboundAs.name || null
            } : null,
            // A re-bind needs the server's current binding and a record not already re-bound here.
            canRebind: !reboundAs && !!(response.current && Array.isArray(response.current.parcels))
        };
    }

    // Same set of bound parcels and coverage → same key. Part of the derived record's content, so
    // re-binding twice against the same cadastre publishes once, and a later cadastre gives a new record.
    function bindingKey(binding) {
        return `${binding && binding.coverage ? binding.coverage : 'none'}:${boundParcelIds(binding).join(',')}`;
    }

    /**
     * The new record a re-bind publishes: the source's site and design, the server's current
     * binding as its declaration, and a link to its source. The source object is not touched.
     * @param source the published record (local copy).
     * @param response GET /proposals/:id/binding-drift body (needs `current`).
     * @param {{ sourceServerId?: string }} options
     */
    function deriveReboundRecord(source, response, options) {
        const opts = options || {};
        if (!source || typeof source !== 'object') throw new Error('A source record is required.');
        const current = response && response.current;
        if (!current || !Array.isArray(current.parcels)) throw new Error('The current binding is missing.');
        const sourceId = source.proposalId ?? source.id;
        if (sourceId === undefined || sourceId === null || sourceId === '') throw new Error('The source record has no id.');
        const derived = clone(source);
        RECORD_STATE_KEYS.forEach(key => { delete derived[key]; });
        SUB_PROPOSAL_KEYS.forEach(key => {
            const sub = derived[key];
            if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return;
            SUB_STATE_KEYS.forEach(state => { delete sub[state]; });
            delete sub.id;
            delete sub.proposalId;
        });
        const drift = response.drift || bindingDrift(response.stored, current);
        derived.binding = clone(current);
        derived.cadastreParcelIds = boundParcelIds(current);
        // The ordinary immutable-replacement lineage: applying the derived record supersedes the
        // source, removing it gives the source back (proposal-supersession.js).
        derived.sourceProposalId = String(sourceId);
        derived.replacementOfProposalId = String(sourceId);
        derived.copiedFromName = source.title || source.name || null;
        derived.rebind = {
            sourceProposalId: String(sourceId),
            sourceServerId: opts.sourceServerId ? String(opts.sourceServerId) : (source.serverProposalId ? String(source.serverProposalId) : null),
            storedComputedAt: response.stored && response.stored.computedAt ? response.stored.computedAt : null,
            currentComputedAt: current.computedAt || null,
            added: drift ? drift.added.map(entry => entry.parcelId) : [],
            removed: drift ? drift.removed.map(entry => entry.parcelId) : [],
            bindingKey: bindingKey(current)
        };
        return derived;
    }

    // A local record derived from the published record `serverId` (or local id), if any.
    function findRebound(records, { serverId, proposalId } = {}) {
        const server = serverId === undefined || serverId === null ? null : String(serverId);
        const local = proposalId === undefined || proposalId === null ? null : String(proposalId);
        return (Array.isArray(records) ? records : []).find(record => {
            const link = record && record.rebind;
            if (!link) return false;
            return (server && link.sourceServerId === server) || (local && link.sourceProposalId === local);
        }) || null;
    }

    return {
        OPEN_GROUND_CHANGE_M2,
        RECORD_STATE_KEYS,
        boundParcelIds,
        bindingDrift,
        driftNotice,
        bindingKey,
        deriveReboundRecord,
        findRebound
    };
});
