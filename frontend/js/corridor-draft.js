// Purpose: derive an editable road-drawing seed from an immutable corridor proposal definition.
(function attachCorridorDraft(global) {
    const LEGACY_ACTIVE_DRAFT_KEY = 'consensus-builder.active-corridor-draft.v1';
    const ACTIVE_DRAFT_KEY = global.PROPOSAL_DRAFT_STORAGE_KEY || 'consensus-builder.proposal-drafts.v1';
    const injectedStores = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

    let createStore = global.createProposalDraftStore || null;
    if (!createStore && typeof module !== 'undefined' && module.exports && typeof require === 'function') {
        try { createStore = require('./proposal-drafts.js').createProposalDraftStore; } catch (_) { }
    }

    function cloneDraftValue(value) {
        if (value === undefined || value === null) return value;
        return JSON.parse(JSON.stringify(value));
    }

    function buildCorridorDrawingSeed(definition, profileOverride) {
        if (!definition || typeof definition !== 'object') return null;
        const centerline = Array.isArray(definition.points) && definition.points.length
            ? definition.points
            : definition.segments;
        if (!Array.isArray(centerline) || !centerline.length) return null;

        return {
            centerline: cloneDraftValue(centerline),
            width: definition.width,
            sidewalkWidth: definition.sidewalkWidth,
            segmentIds: Array.isArray(definition.segmentIds) ? definition.segmentIds.slice() : [],
            profile: cloneDraftValue(profileOverride || definition.profile) || null,
            tunnels: cloneDraftValue(definition.tunnels) || [],
            gradeSeparations: cloneDraftValue(definition.gradeSeparations) || [],
            // Carry the build-through park/lake/square approvals so continuing the road reuses them
            // (seedRoadDrawing → seedApprovedStructureCrossings) instead of re-prompting.
            approvedStructures: cloneDraftValue(definition.approvedStructures) || []
        };
    }

    function resolveCorridorScreenshotGeometry(proposal, fallbackPolygon) {
        const corridor = proposal?.roadProposal?.definition?.polygon
            || proposal?.definition?.polygon
            || null;
        if (corridor && Array.isArray(corridor.coordinates) && corridor.coordinates.length) {
            return { polygon: corridor.coordinates, polygonOrder: 'lnglat', fitToPolygonOnly: true };
        }
        return { polygon: fallbackPolygon, polygonOrder: 'auto', fitToPolygonOnly: false };
    }

    function resolveDraftStore(storage) {
        if (!storage && global.proposalDraftStore) return global.proposalDraftStore;
        const target = storage || global.localStorage || null;
        if (!target || typeof createStore !== 'function') return null;
        if (injectedStores && injectedStores.has(target)) return injectedStores.get(target);
        const store = createStore({ storage: target });
        if (injectedStores) injectedStores.set(target, store);
        return store;
    }

    function corridorDefinitionFromSeed(seed, kind, previousDefinition) {
        const centerline = cloneDraftValue(seed?.centerline || []);
        return {
            ...(cloneDraftValue(previousDefinition || {})),
            points: centerline,
            segments: centerline,
            segmentIds: cloneDraftValue(seed?.segmentIds || []),
            profile: cloneDraftValue(seed?.profile || null),
            width: seed?.width,
            sidewalkWidth: seed?.sidewalkWidth,
            tunnels: cloneDraftValue(seed?.tunnels || []),
            gradeSeparations: cloneDraftValue(seed?.gradeSeparations || previousDefinition?.gradeSeparations || []),
            demolishedBuildings: cloneDraftValue(seed?.demolishedBuildings || []),
            segmentProfiles: cloneDraftValue(seed?.segmentProfiles || previousDefinition?.segmentProfiles || {}),
            polygon: cloneDraftValue(seed?.polygon !== undefined ? seed.polygon : previousDefinition?.polygon || null),
            latLngPairs: cloneDraftValue(seed?.latLngPairs !== undefined ? seed.latLngPairs : previousDefinition?.latLngPairs || null),
            metadata: {
                ...(cloneDraftValue(previousDefinition?.metadata || {})),
                isCorridor: true,
                isTrack: kind === 'track',
                isRoad: kind !== 'track',
                trackSpeed: seed?.trackSpeed,
                trackMinRadius: seed?.trackMinRadius
            }
        };
    }

    function legacyCorridorShape(draft) {
        if (!draft || draft.goal !== 'road-track') return null;
        const definition = draft.editorPayload?.definition || {};
        const kind = draft.editorPayload?.kind || (global.corridorIsTrack(definition) ? 'track' : 'road');
        return {
            draftId: draft.id,
            kind,
            cityId: draft.cityId,
            sourceProposalId: draft.sourceProposalId,
            copySource: draft.sourceProposalId ? {
                proposalId: draft.sourceProposalId,
                name: draft.sourceSnapshot?.title || draft.sourceSnapshot?.name || draft.fields?.name || null,
                draftId: draft.id,
                prefill: cloneDraftValue(draft.fields || {})
            } : null,
            seed: {
                centerline: cloneDraftValue(definition.points || definition.segments || []),
                segmentIds: cloneDraftValue(definition.segmentIds || []),
                profile: cloneDraftValue(definition.profile || null),
                width: definition.width,
                sidewalkWidth: definition.sidewalkWidth,
                tunnels: cloneDraftValue(definition.tunnels || []),
                gradeSeparations: cloneDraftValue(definition.gradeSeparations || []),
                demolishedBuildings: cloneDraftValue(definition.demolishedBuildings || []),
                segmentProfiles: cloneDraftValue(definition.segmentProfiles || {}),
                trackSpeed: definition.metadata?.trackSpeed,
                trackMinRadius: definition.metadata?.trackMinRadius
            },
            dirty: draft.dirty !== false,
            updatedAt: draft.updatedAt
        };
    }

    function saveActiveCorridorDraft(draft, storage) {
        if (!draft || !draft.kind || !draft.seed) return null;
        const store = resolveDraftStore(storage);
        if (!store) return null;
        const explicitId = draft.draftId || draft.copySource?.draftId || null;
        let existing = explicitId ? store.getDraft(explicitId) : store.getActiveDraft();
        if (existing && existing.goal !== 'road-track') existing = null;
        const sourceProposalId = draft.sourceProposalId || draft.copySource?.proposalId || existing?.sourceProposalId || null;
        const definition = corridorDefinitionFromSeed(draft.seed, draft.kind, existing?.editorPayload?.definition);
        let saved = null;
        if (existing) {
            saved = store.updateDraft(existing.id, {
                cityId: draft.cityId || existing.cityId,
                fields: {
                    ...(cloneDraftValue(draft.copySource?.prefill || {})),
                    parentParcelIds: cloneDraftValue(draft.parentParcelIds || existing.fields?.parentParcelIds || [])
                },
                editorPayload: { kind: draft.kind, definition },
                previewGeometry: cloneDraftValue(definition.polygon || null)
            }, { coalesceKey: 'corridor-drawing' });
            store.resumeDraft(existing.id);
        } else {
            saved = store.createDraft({
                cityId: draft.cityId || null,
                goal: 'road-track',
                proposalType: draft.kind === 'track' ? 'Track' : 'Road',
                adapterKey: 'road-track',
                sourceProposalId,
                fields: {
                    name: draft.copySource?.prefill?.name || draft.copySource?.name || '',
                    description: draft.copySource?.prefill?.description || '',
                    parentParcelIds: cloneDraftValue(draft.parentParcelIds || []),
                    offer: Number(draft.copySource?.prefill?.offer) || 0,
                    offerCurrency: draft.copySource?.prefill?.offerCurrency || 'USDT'
                },
                editorPayload: { kind: draft.kind, definition },
                previewGeometry: cloneDraftValue(definition.polygon || null),
                dirty: true
            });
        }
        return legacyCorridorShape(saved);
    }

    function getActiveCorridorDraft(storage) {
        const store = resolveDraftStore(storage);
        return legacyCorridorShape(store?.getActiveDraft());
    }

    function clearActiveCorridorDraft(storage) {
        const store = resolveDraftStore(storage);
        const active = store?.getActiveDraft();
        if (active?.goal === 'road-track') store.deleteDraft(active.id);
    }

    global.buildCorridorDrawingSeed = buildCorridorDrawingSeed;
    global.resolveCorridorScreenshotGeometry = resolveCorridorScreenshotGeometry;
    global.saveActiveCorridorDraft = saveActiveCorridorDraft;
    global.getActiveCorridorDraft = getActiveCorridorDraft;
    global.clearActiveCorridorDraft = clearActiveCorridorDraft;

    if (global.addEventListener) {
        global.addEventListener('beforeunload', () => {
            try { resolveDraftStore()?.flush(); } catch (_) { }
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            ACTIVE_DRAFT_KEY,
            LEGACY_ACTIVE_DRAFT_KEY,
            buildCorridorDrawingSeed,
            resolveCorridorScreenshotGeometry,
            saveActiveCorridorDraft,
            getActiveCorridorDraft,
            clearActiveCorridorDraft
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
