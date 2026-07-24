// Purpose: persist immutable-source proposal edits as recoverable, versioned local drafts.
(function attachProposalDraftStore(global) {
    'use strict';

    const PROPOSAL_DRAFT_SCHEMA_VERSION = 1;
    const PROPOSAL_DRAFT_STORAGE_KEY = 'consensus-builder.proposal-drafts.v1';
    const LEGACY_CORRIDOR_DRAFT_KEY = 'consensus-builder.active-corridor-draft.v1';
    const DEFAULT_HISTORY_LIMIT = 100;
    const DEFAULT_COALESCE_MS = 800;
    const VALID_DRAFT_STATES = new Set(['editing', 'review', 'publishing', 'error']);

    function cloneDraftValue(value) {
        if (value === undefined || value === null) return value;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_) {
            return value;
        }
    }

    function isPlainObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function mergeDraftValues(base, patch) {
        if (!isPlainObject(base) || !isPlainObject(patch)) return cloneDraftValue(patch);
        const result = cloneDraftValue(base) || {};
        Object.keys(patch).forEach(key => {
            const next = patch[key];
            if (next === undefined) return;
            result[key] = isPlainObject(result[key]) && isPlainObject(next)
                ? mergeDraftValues(result[key], next)
                : cloneDraftValue(next);
        });
        return result;
    }

    function stableDraftJson(value) {
        if (Array.isArray(value)) return `[${value.map(stableDraftJson).join(',')}]`;
        if (isPlainObject(value)) {
            return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableDraftJson(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    function valuesEqual(a, b) {
        if (a === b) return true;
        try { return stableDraftJson(a) === stableDraftJson(b); } catch (_) { return false; }
    }

    function isoNow(now) {
        const value = typeof now === 'function' ? now() : new Date();
        const date = value instanceof Date ? value : new Date(value);
        return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
    }

    function timestampMs(value) {
        const parsed = new Date(value || 0).getTime();
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function defaultDraftId() {
        try {
            if (global.crypto && typeof global.crypto.randomUUID === 'function') {
                return `draft-${global.crypto.randomUUID()}`;
            }
        } catch (_) { }
        return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function currentDraftCityId() {
        try {
            if (global.CityConfigManager && typeof global.CityConfigManager.getCurrentCityId === 'function') {
                return global.CityConfigManager.getCurrentCityId() || null;
            }
        } catch (_) { }
        return null;
    }

    function normalizeDraftCityId(rawCityId) {
        if (rawCityId === undefined || rawCityId === null || !String(rawCityId).trim()) return null;
        const value = String(rawCityId).trim();
        const normalized = value.toLowerCase();
        try {
            const manager = global.CityConfigManager;
            const cities = typeof manager?.getAvailableCities === 'function' ? manager.getAvailableCities() : [];
            const exact = cities.find(city => String(city?.id || '').toLowerCase() === normalized);
            if (exact?.id) return String(exact.id);
            if (typeof manager?.getCityCodeForCityId === 'function') {
                const alias = cities.find(city => String(manager.getCityCodeForCityId(city?.id) || '').toLowerCase() === normalized);
                if (alias?.id) return String(alias.id);
            }
        } catch (_) { }
        return value;
    }

    function normalizeGoalKey(rawGoal) {
        if (rawGoal === undefined || rawGoal === null) return '';
        const raw = String(rawGoal).trim();
        if (!raw) return '';
        try {
            if (typeof global.normalizeProposalGoalKey === 'function') {
                const normalized = global.normalizeProposalGoalKey(raw);
                if (normalized) return normalized;
            }
        } catch (_) { }
        const compact = raw.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
        if (compact === 'road' || compact === 'track' || compact === 'road-track') return 'road-track';
        if (compact === 'single-building' || compact === 'building(s)') return 'single';
        if (compact === 'parcelbased' || compact === 'parcel-based') return 'parcelBased';
        if (compact === 'ownership-transfer-to-me' || compact === 'ownership-transfer-from-me') return 'ownership-transfer';
        return compact;
    }

    function proposalGoal(proposal) {
        if (!proposal || typeof proposal !== 'object') return '';
        try {
            if (typeof global.resolveProposalGoalKey === 'function') {
                const resolved = global.resolveProposalGoalKey(proposal, null);
                if (resolved) return resolved;
            }
        } catch (_) { }
        if (proposal.roadProposal || proposal.definition?.metadata?.isCorridor) return 'road-track';
        if (proposal.reparcellization) return 'reparcellization';
        if (proposal.buildingProposal || proposal.buildingGeometry) {
            const typology = proposal.typologyType || proposal.buildingProposal?.typologyType;
            return normalizeGoalKey(typology || proposal.goal || 'buildings');
        }
        if (proposal.structureProposal?.kind) return normalizeGoalKey(proposal.structureProposal.kind);
        return normalizeGoalKey(proposal.goal || proposal.proposalType || proposal.primaryType || proposal.type || '');
    }

    function proposalIdentity(proposal) {
        if (!proposal || typeof proposal !== 'object') return null;
        try {
            if (typeof global.getProposalKey === 'function') {
                const key = global.getProposalKey(proposal);
                if (key !== undefined && key !== null && String(key)) return String(key);
            }
        } catch (_) { }
        const candidates = [
            proposal.proposalId,
            proposal.proposal_id,
            proposal.chainProposalId,
            proposal.hash,
            proposal.id,
            proposal.onchain && proposal.onchain.proposalId
        ];
        const found = candidates.find(value => value !== undefined && value !== null && String(value));
        return found === undefined ? null : String(found);
    }

    function proposalFields(proposal) {
        const parentParcelIds = Array.isArray(proposal?.parentParcelIds)
            ? proposal.parentParcelIds.map(String)
            : [];
        return {
            name: proposal?.title || proposal?.name || proposal?.proposalName || '',
            description: proposal?.description || '',
            parentParcelIds,
            ownership: cloneDraftValue(proposal?.ownership || proposal?.proposalFacets?.ownership || proposal?.facets?.ownership || null),
            recipientScope: proposal?.recipientScope || proposal?.proposalFacets?.recipientScope || proposal?.facets?.recipientScope || null,
            recipientAddress: proposal?.recipientAddress || proposal?.proposalFacets?.recipientAddress || proposal?.facets?.recipientAddress || null,
            offer: Number.isFinite(Number(proposal?.offer)) ? Number(proposal.offer) : 0,
            offerCurrency: proposal?.offerCurrency || proposal?.budgetCurrency || 'USDT',
            acquisitionMode: proposal?.acquisitionMode || null,
            boundaryAdjustment: proposal?.boundaryAdjustment || null,
            isConditional: proposal?.isConditional === true,
            expiresAt: proposal?.expiresAt || null,
            decayEnabled: proposal?.decayEnabled === true,
            decayPercent: Number.isFinite(Number(proposal?.decayPercent)) ? Number(proposal.decayPercent) : 0,
            decayDurationMs: Number.isFinite(Number(proposal?.decayDurationMs)) ? Number(proposal.decayDurationMs) : 0,
            depositEnabled: proposal?.depositEnabled === true,
            depositPercent: Number.isFinite(Number(proposal?.depositPercent)) ? Number(proposal.depositPercent) : 0,
            facets: cloneDraftValue(proposal?.proposalFacets || proposal?.facets || null)
        };
    }

    function basePayloadFromProposal(proposal, goal) {
        if (goal === 'road-track') {
            const definition = proposal?.roadProposal?.definition || proposal?.geometry?.roadPlan || proposal?.definition || null;
            if (!definition) return { kind: proposal?.primaryType === 'Track' ? 'track' : 'road', definition: null };
            return {
                kind: global.corridorIsTrack(definition) || proposal?.primaryType === 'Track' ? 'track' : 'road',
                definition: cloneDraftValue(definition)
            };
        }
        if (goal === 'reparcellization') {
            return { plan: cloneDraftValue(proposal?.reparcellization || null) };
        }
        if (['buildings', 'row', 'parcelBased', 'single'].includes(goal)) {
            const buildingProposal = proposal?.buildingProposal || {};
            const buildings = Array.isArray(buildingProposal.buildings) && buildingProposal.buildings.length
                ? buildingProposal.buildings
                : (Array.isArray(proposal?.geometry?.buildings) ? proposal.geometry.buildings : []);
            return {
                typology: proposal?.typologyType || buildingProposal.typologyType || goal,
                context: {
                    parcelIds: cloneDraftValue(buildingProposal.parentParcelIds || proposal?.parentParcelIds || []),
                    parentDetails: cloneDraftValue(buildingProposal.parentParcelNumbers || null),
                    blockName: buildingProposal.blockName || null,
                    parameters: cloneDraftValue(buildingProposal.parameters || {}),
                    buildingFeature: cloneDraftValue(buildingProposal.buildingFeature || buildings[0] || null),
                    buildings: cloneDraftValue(buildings)
                }
            };
        }
        return {
            geometry: cloneDraftValue(proposal?.geometry || proposal?.structureProposal?.geometry || null),
            proposalFacets: cloneDraftValue(proposal?.proposalFacets || proposal?.facets || null)
        };
    }

    function previewFromPayload(payload, goal) {
        if (!payload) return null;
        if (goal === 'road-track') {
            return cloneDraftValue(payload.definition?.polygon || null);
        }
        if (goal === 'reparcellization') {
            return cloneDraftValue(payload.plan?.polygons || null);
        }
        if (['buildings', 'row', 'parcelBased', 'single'].includes(goal)) {
            const context = payload.context || {};
            return cloneDraftValue(context.buildings?.length ? context.buildings : (context.buildingFeature ? [context.buildingFeature] : null));
        }
        return cloneDraftValue(payload.geometry || null);
    }

    function normalizeIssue(issue, severity) {
        if (typeof issue === 'string') {
            return { code: 'validation', message: issue, severity };
        }
        const value = issue && typeof issue === 'object' ? issue : {};
        return {
            code: value.code || 'validation',
            message: value.message || value.code || 'Draft validation issue',
            severity: value.severity || severity,
            path: value.path || null,
            mapTarget: cloneDraftValue(value.mapTarget || null)
        };
    }

    function normalizeValidation(result) {
        if (result === true || result === undefined || result === null) {
            return { valid: true, errors: [], warnings: [], checkedAt: null };
        }
        if (result === false) {
            return { valid: false, errors: [normalizeIssue('Draft is invalid.', 'error')], warnings: [], checkedAt: null };
        }
        const errors = Array.isArray(result.errors) ? result.errors.map(issue => normalizeIssue(issue, 'error')) : [];
        const warnings = Array.isArray(result.warnings) ? result.warnings.map(issue => normalizeIssue(issue, 'warning')) : [];
        return {
            valid: result.valid !== false && errors.length === 0,
            errors,
            warnings,
            checkedAt: result.checkedAt || null
        };
    }

    function editableSnapshot(draft) {
        return {
            goal: draft.goal || '',
            proposalType: draft.proposalType || null,
            adapterKey: draft.adapterKey || draft.goal || null,
            fields: cloneDraftValue(draft.fields || {}),
            editorPayload: cloneDraftValue(draft.editorPayload || {}),
            previewGeometry: cloneDraftValue(draft.previewGeometry || null)
        };
    }

    function restoreEditableSnapshot(draft, snapshot) {
        draft.goal = normalizeGoalKey(snapshot?.goal || draft.goal || '');
        draft.proposalType = snapshot?.proposalType || draft.proposalType || draft.goal || null;
        draft.adapterKey = snapshot?.adapterKey || draft.adapterKey || draft.goal || null;
        draft.fields = cloneDraftValue(snapshot?.fields || {});
        draft.editorPayload = cloneDraftValue(snapshot?.editorPayload || {});
        draft.previewGeometry = cloneDraftValue(snapshot?.previewGeometry || null);
    }

    function normalizeHistory(history) {
        return {
            past: Array.isArray(history?.past) ? cloneDraftValue(history.past) : [],
            future: Array.isArray(history?.future) ? cloneDraftValue(history.future) : []
        };
    }

    function normalizeDraftRecord(raw, now) {
        if (!raw || typeof raw !== 'object') return null;
        const id = raw.id || raw.draftId;
        if (!id) return null;
        const createdAt = raw.createdAt || isoNow(now);
        const updatedAt = raw.updatedAt || createdAt;
        const goal = normalizeGoalKey(raw.goal || raw.proposalGoal || raw.type || '');
        return {
            schemaVersion: PROPOSAL_DRAFT_SCHEMA_VERSION,
            id: String(id),
            cityId: normalizeDraftCityId(raw.cityId),
            goal,
            proposalType: raw.proposalType || raw.type || goal || null,
            adapterKey: raw.adapterKey || goal || null,
            createdAt,
            updatedAt,
            sourceProposalId: raw.sourceProposalId === undefined || raw.sourceProposalId === null ? null : String(raw.sourceProposalId),
            sourceSnapshot: cloneDraftValue(raw.sourceSnapshot || null),
            fields: cloneDraftValue(raw.fields || {}),
            editorPayload: cloneDraftValue(raw.editorPayload || raw.payload || {}),
            previewGeometry: cloneDraftValue(raw.previewGeometry || null),
            dirty: raw.dirty !== false,
            validation: normalizeValidation(raw.validation),
            revision: Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0,
            history: normalizeHistory(raw.history),
            state: VALID_DRAFT_STATES.has(raw.state) ? raw.state : 'editing',
            publish: cloneDraftValue(raw.publish || null),
            incompatibilityReason: raw.incompatibilityReason || null
        };
    }

    function normalizeStoredEnvelope(raw, now) {
        const sourceDrafts = Array.isArray(raw)
            ? raw
            : (Array.isArray(raw?.drafts) ? raw.drafts : []);
        const drafts = sourceDrafts.map(item => normalizeDraftRecord(item, now)).filter(Boolean);
        const ids = new Set();
        const uniqueDrafts = drafts.filter(draft => {
            if (ids.has(draft.id)) return false;
            ids.add(draft.id);
            return true;
        });
        return {
            schemaVersion: PROPOSAL_DRAFT_SCHEMA_VERSION,
            drafts: uniqueDrafts,
            activeDraftId: raw?.activeDraftId && ids.has(String(raw.activeDraftId)) ? String(raw.activeDraftId) : null,
            publishReceipts: Array.isArray(raw?.publishReceipts) ? cloneDraftValue(raw.publishReceipts).slice(-50) : [],
            migrations: isPlainObject(raw?.migrations) ? cloneDraftValue(raw.migrations) : {}
        };
    }

    function createProposalDraftStore(options = {}) {
        const storage = options.storage || global.localStorage || null;
        const storageKey = options.storageKey || PROPOSAL_DRAFT_STORAGE_KEY;
        const legacyCorridorKey = options.legacyCorridorKey || LEGACY_CORRIDOR_DRAFT_KEY;
        const now = options.now || (() => new Date());
        const idFactory = options.idFactory || defaultDraftId;
        const historyLimit = Number.isFinite(Number(options.historyLimit)) ? Math.max(1, Number(options.historyLimit)) : DEFAULT_HISTORY_LIMIT;
        const coalesceMs = Number.isFinite(Number(options.coalesceMs)) ? Math.max(0, Number(options.coalesceMs)) : DEFAULT_COALESCE_MS;
        const subscribers = new Set();
        let envelope = normalizeStoredEnvelope(null, now);
        let lastLoadWasCorrupt = false;

        function readStoredEnvelope() {
            if (!storage || typeof storage.getItem !== 'function') return normalizeStoredEnvelope(null, now);
            const stored = storage.getItem(storageKey);
            if (!stored) return normalizeStoredEnvelope(null, now);
            try {
                lastLoadWasCorrupt = false;
                return normalizeStoredEnvelope(JSON.parse(stored), now);
            } catch (error) {
                lastLoadWasCorrupt = true;
                try {
                    const corruptKey = `${storageKey}.corrupt.${Date.now()}`;
                    if (typeof storage.setItem === 'function') storage.setItem(corruptKey, stored);
                } catch (_) { }
                console.warn('[ProposalDraftStore] Ignoring corrupt draft storage', error);
                return normalizeStoredEnvelope(null, now);
            }
        }

        function persist() {
            envelope.schemaVersion = PROPOSAL_DRAFT_SCHEMA_VERSION;
            if (storage && typeof storage.setItem === 'function') {
                // After a full wipe (nothing in memory, key already gone) the unload-time flush must
                // not resurrect the storage key. A normal "last draft deleted" still writes, because
                // the key exists and the deletion has to be recorded.
                const isEmpty = !envelope.drafts.length && !envelope.activeDraftId
                    && !envelope.publishReceipts.length && !Object.keys(envelope.migrations || {}).length;
                if (isEmpty && typeof storage.getItem === 'function' && storage.getItem(storageKey) === null) {
                    return true;
                }
                // A storage write can fail — most often QuotaExceededError when a draft carries a very
                // large/complex geometry. This is a background autosave: losing the persisted copy is
                // not fatal to editing, and it must NEVER throw into the caller (a live autosave firing
                // mid-build once surfaced the raw "Failed to execute 'setItem'… exceeded the quota" in
                // the status bar and aborted the flow). Swallow it, warn, and report the failure.
                try {
                    storage.setItem(storageKey, JSON.stringify(envelope));
                } catch (error) {
                    console.warn('[ProposalDraftStore] Could not persist drafts (storage full or unavailable) — keeping them in memory only', error);
                    return false;
                }
            }
            return true;
        }

        // Erase every draft, receipt, and stored byte of this store — used by "wipe ALL local data".
        // Empties the in-memory envelope too, so unload-time flushes cannot re-persist wiped drafts.
        function wipeAll() {
            envelope = normalizeStoredEnvelope(null, now);
            try {
                if (storage && typeof storage.removeItem === 'function') {
                    storage.removeItem(storageKey);
                    storage.removeItem(legacyCorridorKey);
                }
            } catch (_) { }
            notify('wipe', null);
            return true;
        }

        function notify(type, draftId) {
            const detail = { type, draftId: draftId || null, drafts: listDrafts(), activeDraftId: envelope.activeDraftId };
            subscribers.forEach(listener => {
                try { listener(detail); } catch (_) { }
            });
            try {
                if (global.document && typeof global.CustomEvent === 'function') {
                    global.document.dispatchEvent(new global.CustomEvent('proposal-drafts-changed', { detail }));
                }
            } catch (_) { }
        }

        function internalDraft(id) {
            const key = id === undefined || id === null ? null : String(id);
            return key ? envelope.drafts.find(draft => draft.id === key) || null : null;
        }

        function activeInternalDraft() {
            return internalDraft(envelope.activeDraftId);
        }

        function resolveAdapter(draftOrGoal) {
            const draft = typeof draftOrGoal === 'object' ? draftOrGoal : null;
            const goal = draft ? (draft.adapterKey || draft.goal) : draftOrGoal;
            const registry = options.adapterRegistry || global.proposalEditorAdapterRegistry || global.proposalEditorAdapters;
            if (!registry) return null;
            try {
                if (typeof registry.get === 'function') return registry.get(goal, draft) || null;
                if (typeof registry.getAdapter === 'function') return registry.getAdapter(goal, draft) || null;
                return registry[goal] || null;
            } catch (_) {
                return null;
            }
        }

        function migrateLegacyCorridorDraft() {
            if (envelope.migrations.legacyCorridorV1) return null;
            if (!storage || typeof storage.getItem !== 'function') {
                envelope.migrations.legacyCorridorV1 = true;
                return null;
            }
            let legacy = null;
            try { legacy = JSON.parse(storage.getItem(legacyCorridorKey) || 'null'); } catch (_) { legacy = null; }
            if (!legacy || !legacy.kind || !legacy.seed || legacy.dirty !== true) {
                envelope.migrations.legacyCorridorV1 = true;
                persist();
                return null;
            }

            const sourceProposalId = legacy.sourceProposalId || legacy.copySource?.proposalId || null;
            const prefill = legacy.copySource?.prefill || {};
            const createdAt = legacy.createdAt || legacy.updatedAt || isoNow(now);
            const definition = {
                points: cloneDraftValue(legacy.seed.centerline || []),
                segments: cloneDraftValue(legacy.seed.centerline || []),
                segmentIds: cloneDraftValue(legacy.seed.segmentIds || []),
                profile: cloneDraftValue(legacy.seed.profile || null),
                width: legacy.seed.width,
                sidewalkWidth: legacy.seed.sidewalkWidth,
                tunnels: cloneDraftValue(legacy.seed.tunnels || []),
                gradeSeparations: cloneDraftValue(legacy.seed.gradeSeparations || []),
                metadata: {
                    isTrack: legacy.kind === 'track',
                    isRoad: legacy.kind !== 'track',
                    isCorridor: true,
                    trackSpeed: legacy.seed.trackSpeed,
                    trackMinRadius: legacy.seed.trackMinRadius
                }
            };
            const migrated = normalizeDraftRecord({
                id: idFactory(),
                cityId: legacy.cityId || null,
                goal: 'road-track',
                proposalType: legacy.kind === 'track' ? 'Track' : 'Road',
                adapterKey: 'road-track',
                createdAt,
                updatedAt: legacy.updatedAt || createdAt,
                sourceProposalId,
                sourceSnapshot: null,
                fields: {
                    name: prefill.name || legacy.copySource?.name || '',
                    description: prefill.description || '',
                    parentParcelIds: cloneDraftValue(legacy.parentParcelIds || []),
                    offer: Number(prefill.offer) || 0,
                    offerCurrency: prefill.offerCurrency || 'USDT',
                    isConditional: prefill.isConditional === true
                },
                editorPayload: { kind: legacy.kind, definition },
                previewGeometry: cloneDraftValue(definition.polygon || null),
                dirty: true,
                revision: 0,
                state: 'editing'
            }, now);
            envelope.drafts.push(migrated);
            envelope.activeDraftId = migrated.id;
            envelope.migrations.legacyCorridorV1 = true;
            persist();
            try { if (typeof storage.removeItem === 'function') storage.removeItem(legacyCorridorKey); } catch (_) { }
            return cloneDraftValue(migrated);
        }

        function initialize() {
            envelope = readStoredEnvelope();
            const migrated = migrateLegacyCorridorDraft();
            if (!migrated && lastLoadWasCorrupt) persist();
        }

        function listDrafts(filters = {}) {
            let drafts = envelope.drafts;
            if (filters.cityId !== undefined && filters.cityId !== null) {
                const cityId = normalizeDraftCityId(filters.cityId);
                drafts = drafts.filter(draft => String(draft.cityId || '') === String(cityId || ''));
            }
            if (filters.sourceProposalId !== undefined && filters.sourceProposalId !== null) {
                drafts = drafts.filter(draft => String(draft.sourceProposalId || '') === String(filters.sourceProposalId));
            }
            if (filters.goal) drafts = drafts.filter(draft => draft.goal === normalizeGoalKey(filters.goal));
            if (filters.state) drafts = drafts.filter(draft => draft.state === filters.state);
            return drafts.slice().sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt)).map(cloneDraftValue);
        }

        function getDraft(id) {
            return cloneDraftValue(internalDraft(id));
        }

        function getActiveDraft() {
            return cloneDraftValue(activeInternalDraft());
        }

        function findDraftForSource(sourceProposalId, cityId) {
            if (sourceProposalId === undefined || sourceProposalId === null) return null;
            const sourceKey = String(sourceProposalId);
            const normalizedCityId = normalizeDraftCityId(cityId);
            const matches = envelope.drafts.filter(draft => draft.sourceProposalId === sourceKey
                && (cityId === undefined || cityId === null || String(draft.cityId || '') === String(normalizedCityId || '')));
            matches.sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt));
            return cloneDraftValue(matches[0] || null);
        }

        function createDraft(input = {}) {
            const createdAt = isoNow(now);
            const goal = normalizeGoalKey(input.goal || input.proposalGoal || input.proposalType || input.type || '');
            let id = String(input.id || input.draftId || idFactory());
            while (internalDraft(id)) id = String(idFactory());
            const draft = normalizeDraftRecord({
                id,
                cityId: input.cityId !== undefined ? input.cityId : currentDraftCityId(),
                goal,
                proposalType: input.proposalType || input.type || goal,
                adapterKey: input.adapterKey || goal,
                createdAt,
                updatedAt: createdAt,
                sourceProposalId: input.sourceProposalId || null,
                sourceSnapshot: cloneDraftValue(input.sourceSnapshot || null),
                fields: cloneDraftValue(input.fields || {}),
                editorPayload: cloneDraftValue(input.editorPayload || input.payload || {}),
                previewGeometry: cloneDraftValue(input.previewGeometry || null),
                dirty: input.dirty !== false,
                validation: input.validation,
                revision: Number(input.revision) || 0,
                history: input.history,
                state: input.state || 'editing',
                publish: input.publish || null,
                incompatibilityReason: input.incompatibilityReason || null
            }, now);
            envelope.drafts.push(draft);
            if (input.activate !== false) envelope.activeDraftId = draft.id;
            persist();
            notify('create', draft.id);
            return cloneDraftValue(draft);
        }

        function createDraftFromProposal(proposal, createOptions = {}) {
            if (!proposal || typeof proposal !== 'object') throw new TypeError('A source proposal is required.');
            const sourceProposalId = createOptions.sourceProposalId || proposalIdentity(proposal);
            if (!sourceProposalId) throw new Error('The source proposal has no stable ID.');
            const cityId = normalizeDraftCityId(createOptions.cityId !== undefined ? createOptions.cityId : (proposal.city || currentDraftCityId()));
            const existing = findDraftForSource(sourceProposalId, cityId);
            if (existing && createOptions.forceNew !== true) {
                resumeDraft(existing.id);
                return getDraft(existing.id);
            }

            const goal = normalizeGoalKey(createOptions.goal || proposalGoal(proposal));
            const adapter = resolveAdapter(goal);
            let adapterDraft = null;
            if (adapter && typeof adapter.draftFromProposal === 'function') {
                adapterDraft = adapter.draftFromProposal(cloneDraftValue(proposal), createOptions) || null;
            }
            const editorPayload = adapterDraft?.editorPayload || adapterDraft?.payload || basePayloadFromProposal(proposal, goal);
            const fields = mergeDraftValues(proposalFields(proposal), adapterDraft?.fields || {});
            const previewGeometry = adapterDraft?.previewGeometry !== undefined
                ? adapterDraft.previewGeometry
                : previewFromPayload(editorPayload, goal);
            const compatibility = adapter && typeof adapter.canEdit === 'function'
                ? adapter.canEdit(proposal)
                : true;
            const editable = compatibility === true || compatibility?.editable === true;
            const incompatibilityReason = editable
                ? null
                : (typeof compatibility === 'string' ? compatibility : compatibility?.reason || 'This legacy proposal cannot be edited safely.');

            const draft = createDraft({
                cityId,
                goal,
                proposalType: adapterDraft?.proposalType || proposal.primaryType || proposal.type || goal,
                adapterKey: adapterDraft?.adapterKey || adapter?.key || goal,
                sourceProposalId,
                sourceSnapshot: cloneDraftValue(proposal),
                fields,
                editorPayload,
                previewGeometry,
                incompatibilityReason,
                dirty: false,
                activate: createOptions.activate !== false
            });
            return validateDraft(draft.id);
        }

        function updateDraft(id, patchOrUpdater, updateOptions = {}) {
            const draft = internalDraft(id);
            if (!draft) return null;
            const before = editableSnapshot(draft);
            const sourceSnapshot = cloneDraftValue(draft.sourceSnapshot);
            const sourceProposalId = draft.sourceProposalId;
            const draftId = draft.id;
            let next = cloneDraftValue(draft);
            if (typeof patchOrUpdater === 'function') {
                const returned = patchOrUpdater(next);
                if (returned && typeof returned === 'object') next = returned;
            } else if (patchOrUpdater && typeof patchOrUpdater === 'object') {
                next = updateOptions.replace === true
                    ? mergeDraftValues(draft, patchOrUpdater)
                    : mergeDraftValues(next, patchOrUpdater);
            }
            next.id = draftId;
            next.sourceProposalId = sourceProposalId;
            next.sourceSnapshot = sourceSnapshot;
            const after = editableSnapshot(next);
            const meaningfulChange = !valuesEqual(before, after);
            if (!meaningfulChange && updateOptions.force !== true) return cloneDraftValue(draft);

            next.history = normalizeHistory(draft.history);
            if (meaningfulChange && updateOptions.recordHistory !== false) {
                const group = updateOptions.coalesceKey || null;
                const previous = next.history.past[next.history.past.length - 1];
                const elapsed = previous ? timestampMs(isoNow(now)) - timestampMs(previous.at) : Infinity;
                const coalesced = !!(group && previous && previous.coalesceKey === group && elapsed >= 0 && elapsed <= coalesceMs);
                if (!coalesced) {
                    next.history.past.push({ snapshot: before, at: isoNow(now), coalesceKey: group });
                    if (next.history.past.length > historyLimit) next.history.past.splice(0, next.history.past.length - historyLimit);
                }
                next.history.future = [];
            }
            next.updatedAt = isoNow(now);
            next.revision = Number(draft.revision || 0) + 1;
            if (updateOptions.dirty !== false && meaningfulChange) next.dirty = true;
            if (updateOptions.state && VALID_DRAFT_STATES.has(updateOptions.state)) next.state = updateOptions.state;
            const normalized = normalizeDraftRecord(next, now);
            const index = envelope.drafts.findIndex(item => item.id === draftId);
            envelope.drafts[index] = normalized;
            persist();
            if (updateOptions.validate === true) validateDraft(draftId);
            else notify('update', draftId);
            return getDraft(draftId);
        }

        function deleteDraft(id) {
            const key = String(id || '');
            const index = envelope.drafts.findIndex(draft => draft.id === key);
            if (index === -1) return false;
            envelope.drafts.splice(index, 1);
            if (envelope.activeDraftId === key) envelope.activeDraftId = null;
            persist();
            notify('delete', key);
            return true;
        }

        function resumeDraft(id) {
            const draft = internalDraft(id);
            if (!draft) return null;
            envelope.activeDraftId = draft.id;
            draft.updatedAt = isoNow(now);
            persist();
            notify('resume', draft.id);
            return cloneDraftValue(draft);
        }

        function clearActiveDraft() {
            const previous = envelope.activeDraftId;
            envelope.activeDraftId = null;
            persist();
            notify('deactivate', previous);
            return previous;
        }

        function undoDraft(id) {
            const draft = internalDraft(id);
            if (!draft || !draft.history?.past?.length) return cloneDraftValue(draft);
            const entry = draft.history.past.pop();
            draft.history.future.push({ snapshot: editableSnapshot(draft), at: isoNow(now), coalesceKey: entry.coalesceKey || null });
            restoreEditableSnapshot(draft, entry.snapshot);
            draft.updatedAt = isoNow(now);
            draft.revision += 1;
            draft.dirty = true;
            draft.state = 'editing';
            persist();
            notify('undo', draft.id);
            return validateDraft(draft.id, { persist: true, notify: false });
        }

        function redoDraft(id) {
            const draft = internalDraft(id);
            if (!draft || !draft.history?.future?.length) return cloneDraftValue(draft);
            const entry = draft.history.future.pop();
            draft.history.past.push({ snapshot: editableSnapshot(draft), at: isoNow(now), coalesceKey: entry.coalesceKey || null });
            restoreEditableSnapshot(draft, entry.snapshot);
            draft.updatedAt = isoNow(now);
            draft.revision += 1;
            draft.dirty = true;
            draft.state = 'editing';
            persist();
            notify('redo', draft.id);
            return validateDraft(draft.id, { persist: true, notify: false });
        }

        function validateDraft(id, validateOptions = {}) {
            const draft = internalDraft(id);
            if (!draft) return null;
            const adapter = resolveAdapter(draft);
            let result = null;
            try {
                if (typeof validateOptions.validator === 'function') result = validateOptions.validator(cloneDraftValue(draft));
                else if (adapter && typeof adapter.validate === 'function') result = adapter.validate(cloneDraftValue(draft));
                else {
                    const errors = [];
                    if (!draft.goal) errors.push({ code: 'missing-goal', message: 'Choose a proposal type.', path: 'goal' });
                    if (!draft.fields?.name?.trim()) errors.push({ code: 'missing-name', message: 'Add a proposal name.', path: 'fields.name' });
                    if (!Array.isArray(draft.fields?.parentParcelIds) || draft.fields.parentParcelIds.length === 0) {
                        errors.push({ code: 'missing-parcels', message: 'Select at least one parcel.', path: 'fields.parentParcelIds' });
                    }
                    result = { valid: errors.length === 0, errors, warnings: [] };
                }
            } catch (error) {
                result = { valid: false, errors: [{ code: 'validator-error', message: error?.message || 'Draft validation failed.' }], warnings: [] };
            }
            draft.validation = normalizeValidation(result);
            draft.validation.checkedAt = isoNow(now);
            if (validateOptions.persist !== false) persist();
            if (validateOptions.notify !== false) notify('validate', draft.id);
            return cloneDraftValue(draft);
        }

        function buildProposalFromDraft(id, buildOptions = {}) {
            const draft = internalDraft(id);
            if (!draft) return null;
            const validated = validateDraft(id, { notify: false });
            if (!validated.validation.valid && buildOptions.allowInvalid !== true) {
                const error = new Error('Draft validation failed.');
                error.validation = validated.validation;
                throw error;
            }
            const adapter = resolveAdapter(draft);
            let proposal = null;
            if (adapter && typeof adapter.serializeProposal === 'function') {
                proposal = adapter.serializeProposal(cloneDraftValue(draft), buildOptions);
            }
            if (!proposal) {
                proposal = mergeDraftValues(draft.sourceSnapshot || {}, draft.fields || {});
                proposal.goal = draft.goal;
                proposal.parentParcelIds = cloneDraftValue(draft.fields?.parentParcelIds || []);
                proposal.editorPayload = cloneDraftValue(draft.editorPayload || {});
            }
            const output = cloneDraftValue(proposal);
            delete output.id;
            delete output.proposalId;
            delete output.proposal_id;
            delete output.hash;
            delete output.chainProposalId;
            delete output.onchain;
            delete output.nft;
            // The share/upload link is the numeric serverProposalId. A proposal built from a draft is
            // a NEW proposal (buildings, structures, reparcellization, station, road design-finalize
            // all commit through here); it must not inherit the source's server-upload identity, or an
            // edit would silently reuse the original's /proposals/:id instead of a fresh upload.
            delete output.serverProposalId;
            output.sourceProposalId = draft.sourceProposalId || null;
            output.replacementOfProposalId = draft.sourceProposalId || null;
            output.proposalDraftId = draft.id;
            return output;
        }

        function markPublishing(id, publishOptions = {}) {
            const draft = internalDraft(id);
            if (!draft) return null;
            if (draft.state === 'publishing' && draft.publish?.operationId) return cloneDraftValue(draft);
            const operationId = publishOptions.operationId || draft.publish?.operationId || `publish-${draft.id}-${draft.revision}`;
            draft.state = 'publishing';
            draft.publish = {
                ...(draft.publish || {}),
                operationId,
                startedAt: isoNow(now),
                attempt: Number(draft.publish?.attempt || 0) + 1,
                error: null,
                persistedProposalId: draft.publish?.persistedProposalId || null
            };
            draft.updatedAt = isoNow(now);
            persist();
            notify('publishing', draft.id);
            return cloneDraftValue(draft);
        }

        function markPublishFailed(id, error) {
            const draft = internalDraft(id);
            if (!draft) return null;
            draft.state = 'error';
            draft.publish = {
                ...(draft.publish || {}),
                failedAt: isoNow(now),
                error: {
                    message: error?.message || String(error || 'Publishing failed.'),
                    code: error?.code || null
                }
            };
            draft.updatedAt = isoNow(now);
            persist();
            notify('publish-failed', draft.id);
            return cloneDraftValue(draft);
        }

        function consumeAfterPublish(id, persistedProposalId) {
            const draft = internalDraft(id);
            if (!draft) {
                return envelope.publishReceipts.find(receipt => receipt.draftId === String(id)) || null;
            }
            const receipt = {
                draftId: draft.id,
                operationId: draft.publish?.operationId || null,
                persistedProposalId: persistedProposalId === undefined || persistedProposalId === null ? null : String(persistedProposalId),
                sourceProposalId: draft.sourceProposalId || null,
                consumedAt: isoNow(now)
            };
            envelope.publishReceipts = envelope.publishReceipts.filter(item => item.draftId !== draft.id);
            envelope.publishReceipts.push(receipt);
            if (envelope.publishReceipts.length > 50) envelope.publishReceipts.splice(0, envelope.publishReceipts.length - 50);
            envelope.drafts = envelope.drafts.filter(item => item.id !== draft.id);
            if (envelope.activeDraftId === draft.id) envelope.activeDraftId = null;
            persist();
            notify('consume', draft.id);
            return cloneDraftValue(receipt);
        }

        function getPublishReceipt(id) {
            return cloneDraftValue(envelope.publishReceipts.find(receipt => receipt.draftId === String(id)) || null);
        }

        function setDraftState(id, state) {
            if (!VALID_DRAFT_STATES.has(state)) throw new Error(`Invalid draft state: ${state}`);
            const draft = internalDraft(id);
            if (!draft) return null;
            draft.state = state;
            draft.updatedAt = isoNow(now);
            persist();
            notify('state', draft.id);
            return cloneDraftValue(draft);
        }

        function subscribe(listener) {
            if (typeof listener !== 'function') return () => { };
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        }

        function reload() {
            envelope = readStoredEnvelope();
            notify('reload', envelope.activeDraftId);
            return listDrafts();
        }

        function inspectEnvelope() {
            return cloneDraftValue(envelope);
        }

        initialize();

        return {
            schemaVersion: PROPOSAL_DRAFT_SCHEMA_VERSION,
            storageKey,
            createDraft,
            createDraftFromProposal,
            getDraft,
            getActiveDraft,
            listDrafts,
            findDraftForSource,
            updateDraft,
            deleteDraft,
            resumeDraft,
            clearActiveDraft,
            undoDraft,
            redoDraft,
            validateDraft,
            buildProposalFromDraft,
            markPublishing,
            markPublishFailed,
            consumeAfterPublish,
            getPublishReceipt,
            setDraftState,
            wipeAll,
            flush: persist,
            reload,
            subscribe,
            inspectEnvelope,
            migrateLegacyCorridorDraft
        };
    }

    global.PROPOSAL_DRAFT_SCHEMA_VERSION = PROPOSAL_DRAFT_SCHEMA_VERSION;
    global.PROPOSAL_DRAFT_STORAGE_KEY = PROPOSAL_DRAFT_STORAGE_KEY;
    global.createProposalDraftStore = createProposalDraftStore;
    if (!global.proposalDraftStore) global.proposalDraftStore = createProposalDraftStore();

    if (global.addEventListener && global.proposalDraftStore) {
        const flush = () => {
            try { global.proposalDraftStore.flush(); } catch (_) { }
        };
        global.addEventListener('pagehide', flush);
        global.addEventListener('beforeunload', flush);
        global.addEventListener('storage', event => {
            // key === null means another tab cleared ALL of localStorage (a wipe) — re-read then too,
            // so this tab's in-memory drafts don't get re-persisted by its own unload flush.
            if (event && (event.key === PROPOSAL_DRAFT_STORAGE_KEY || event.key === null)) {
                try { global.proposalDraftStore.reload(); } catch (_) { }
            }
        });
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            PROPOSAL_DRAFT_SCHEMA_VERSION,
            PROPOSAL_DRAFT_STORAGE_KEY,
            LEGACY_CORRIDOR_DRAFT_KEY,
            createProposalDraftStore,
            cloneDraftValue,
            normalizeGoalKey
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
