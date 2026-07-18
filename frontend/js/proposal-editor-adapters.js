// Purpose: provide one editor contract for every creatable proposal goal.
(function attachProposalEditorAdapters(global) {
    'use strict';

    // Canonical map-application accessor from proposals/status.js. Global in the browser (status.js
    // loads first), required directly in node tests. The require branch never runs in the browser.
    const appliedOf = (typeof isApplied === 'function')
        ? isApplied
        : require('./proposals/status.js').isApplied;

    const CREATABLE_PROPOSAL_GOALS = [
        'as-is',
        'square',
        'park',
        'lake',
        'station',
        'single',
        'buildings',
        'row',
        'parcelBased',
        'urban-rule',
        'road-track',
        'reparcellization',
        'ownership-transfer'
    ];

    function clone(value) {
        if (value === undefined || value === null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function normalizeGoal(rawGoal) {
        if (rawGoal === undefined || rawGoal === null) return '';
        try {
            if (typeof global.normalizeProposalGoalKey === 'function') {
                const value = global.normalizeProposalGoalKey(rawGoal);
                if (value) return value;
            }
        } catch (_) { }
        const value = String(rawGoal).trim().toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-');
        if (['road', 'track', 'road-track'].includes(value)) return 'road-track';
        if (['building(s)', 'single-building'].includes(value)) return 'single';
        if (value === 'parcelbased' || value === 'parcel-based') return 'parcelBased';
        if (value === 'ownership-transfer-to-me' || value === 'ownership-transfer-from-me') return 'ownership-transfer';
        return value;
    }

    function sourceGoal(proposal) {
        try {
            if (typeof global.resolveProposalGoalKey === 'function') {
                const value = global.resolveProposalGoalKey(proposal, null);
                if (value) return normalizeGoal(value);
            }
        } catch (_) { }
        if (proposal?.roadProposal || proposal?.geometry?.roadPlan) return 'road-track';
        if (proposal?.reparcellization) return 'reparcellization';
        if (proposal?.buildingProposal || proposal?.geometry?.buildings || proposal?.buildingGeometry) {
            return normalizeGoal(proposal.typologyType || proposal.buildingProposal?.typologyType || proposal.goal || 'buildings');
        }
        if (proposal?.structureProposal?.kind) return normalizeGoal(proposal.structureProposal.kind);
        return normalizeGoal(proposal?.goal || proposal?.primaryType || proposal?.proposalType || proposal?.type || '');
    }

    function sourceId(proposal) {
        const candidates = [proposal?.proposalId, proposal?.proposal_id, proposal?.chainProposalId, proposal?.hash, proposal?.id];
        const value = candidates.find(item => item !== undefined && item !== null && String(item));
        return value === undefined ? null : String(value);
    }

    function sourceName(proposal) {
        return proposal?.title || proposal?.name || proposal?.proposalName || sourceId(proposal) || '';
    }

    function sourceParcels(proposal) {
        const values = proposal?.parentParcelIds
            || proposal?.buildingProposal?.parentParcelIds
            || proposal?.roadProposal?.parentParcelIds
            || proposal?.reparcellization?.parcelIds
            || [];
        return Array.isArray(values) ? values.map(String) : [];
    }

    function sourceChildParcels(proposal) {
        const values = [
            ...(Array.isArray(proposal?.childParcelIds) ? proposal.childParcelIds : []),
            ...(Array.isArray(proposal?.roadProposal?.childParcelIds) ? proposal.roadProposal.childParcelIds : []),
            ...(Array.isArray(proposal?.buildingProposal?.childParcelIds) ? proposal.buildingProposal.childParcelIds : []),
            ...(Array.isArray(proposal?.reparcellization?.childParcelIds) ? proposal.reparcellization.childParcelIds : []),
            ...(Array.isArray(proposal?.decideLaterProposal?.childParcelIds) ? proposal.decideLaterProposal.childParcelIds : [])
        ];
        return [...new Set(values.map(String).filter(Boolean))];
    }

    function sourceIsApplied(proposal) {
        if (!proposal) return false;
        if (appliedOf(proposal)) return true;
        return ['roadProposal', 'buildingProposal', 'structureProposal', 'reparcellization', 'decideLaterProposal']
            .some(k => proposal[k] && appliedOf(proposal, proposal[k]));
    }

    function sourceFields(proposal) {
        return {
            name: sourceName(proposal),
            description: proposal?.description || '',
            parentParcelIds: sourceParcels(proposal),
            offer: Number.isFinite(Number(proposal?.offer)) ? Number(proposal.offer) : 0,
            offerCurrency: proposal?.offerCurrency || proposal?.budgetCurrency || 'USDT',
            acquisitionMode: proposal?.acquisitionMode || null,
            boundaryAdjustment: proposal?.boundaryAdjustment || null,
            ownership: proposal?.facets?.ownership || proposal?.proposalFacets?.ownership || null,
            recipientScope: proposal?.facets?.recipientScope || proposal?.proposalFacets?.recipientScope || proposal?.recipientScope || null,
            recipientAddress: proposal?.facets?.recipientAddress || proposal?.proposalFacets?.recipientAddress || proposal?.recipientAddress || null,
            isConditional: proposal?.isConditional === true,
            expiresAt: proposal?.expiresAt || null,
            decayEnabled: proposal?.decayEnabled === true,
            decayPercent: Number(proposal?.decayPercent) || 0,
            decayDurationMs: Number(proposal?.decayDurationMs) || 0,
            depositEnabled: proposal?.depositEnabled === true,
            depositPercent: Number(proposal?.depositPercent) || 0,
            facets: clone(proposal?.facets || proposal?.proposalFacets || null)
        };
    }

    function issue(code, message, path, mapTarget) {
        return { code, message, path: path || null, mapTarget: clone(mapTarget || null) };
    }

    function commonValidation(draft) {
        const errors = [];
        const warnings = [];
        if (!draft?.fields?.name || !String(draft.fields.name).trim()) {
            errors.push(issue('missing-name', 'Add a proposal name.', 'fields.name'));
        }
        if (!Array.isArray(draft?.fields?.parentParcelIds) || draft.fields.parentParcelIds.length === 0) {
            errors.push(issue('missing-parcels', 'Select at least one parcel.', 'fields.parentParcelIds'));
        }
        if (!draft?.fields?.description || !String(draft.fields.description).trim()) {
            warnings.push(issue('missing-description', 'A description will help others understand the replacement.', 'fields.description'));
        }
        return { errors, warnings };
    }

    function validLngLatPoint(point) {
        if (!point) return false;
        const lat = Number(point.lat !== undefined ? point.lat : (Array.isArray(point) ? point[1] : null));
        const lng = Number(point.lng !== undefined ? point.lng : (Array.isArray(point) ? point[0] : null));
        return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    }

    function corridorDefinition(proposal) {
        return proposal?.roadProposal?.definition || proposal?.geometry?.roadPlan || proposal?.definition || null;
    }

    function corridorSegments(definition) {
        const raw = Array.isArray(definition?.points) && definition.points.length
            ? definition.points
            : (Array.isArray(definition?.segments) ? definition.segments : []);
        if (!raw.length) return [];
        const nested = Array.isArray(raw[0]);
        return nested ? raw : [raw];
    }

    function corridorSeed(definition, kind) {
        const segments = corridorSegments(definition);
        return {
            centerline: clone(segments),
            segmentIds: clone(definition?.segmentIds || []),
            profile: clone(definition?.profile || null),
            width: definition?.width,
            sidewalkWidth: definition?.sidewalkWidth,
            tunnels: clone(definition?.tunnels || []),
            gradeSeparations: clone(definition?.gradeSeparations || []),
            demolishedBuildings: clone(definition?.demolishedBuildings || []),
            segmentProfiles: clone(definition?.segmentProfiles || {}),
            trackSpeed: definition?.metadata?.trackSpeed,
            trackMinRadius: definition?.metadata?.trackMinRadius,
            kind
        };
    }

    function corridorPayloadFromSeed(seed, sourceDefinition) {
        const kind = seed?.kind || (global.corridorIsTrack(sourceDefinition) ? 'track' : 'road');
        const segments = clone(seed?.centerline || []);
        const payload = {
            ...(clone(sourceDefinition || {})),
            points: segments,
            segments,
            segmentIds: clone(seed?.segmentIds || []),
            profile: clone(seed?.profile || null),
            width: seed?.width,
            sidewalkWidth: seed?.sidewalkWidth,
            tunnels: clone(seed?.tunnels || []),
            gradeSeparations: clone(seed?.gradeSeparations || sourceDefinition?.gradeSeparations || []),
            demolishedBuildings: clone(seed?.demolishedBuildings || sourceDefinition?.demolishedBuildings || []),
            segmentProfiles: clone(seed?.segmentProfiles || sourceDefinition?.segmentProfiles || {}),
            polygon: clone(seed?.polygon !== undefined ? seed.polygon : sourceDefinition?.polygon || null),
            latLngPairs: clone(seed?.latLngPairs !== undefined ? seed.latLngPairs : sourceDefinition?.latLngPairs || null),
            metadata: {
                ...(clone(sourceDefinition?.metadata || {})),
                isCorridor: true,
                isTrack: kind === 'track',
                isRoad: kind !== 'track',
                trackSpeed: seed?.trackSpeed,
                trackMinRadius: seed?.trackMinRadius
            }
        };
        // Every editor-built corridor definition passes through here on its way to the draft and,
        // from there, to the API. Re-derive the surface footprint from the payload's OWN tunnels
        // and centerline: the spread above would otherwise carry a stale one over from the source
        // definition. It is the ground the corridor actually clears and actually buys, and only the
        // browser can compute it (city projection) — see attachCorridorSurfaceFootprint.
        if (typeof global.attachCorridorSurfaceFootprint === 'function') {
            global.attachCorridorSurfaceFootprint(payload);
        } else {
            payload.surfaceFootprint = null;
        }
        return payload;
    }

    function proposalBuildingContext(proposal) {
        const bp = proposal?.buildingProposal || {};
        const buildings = Array.isArray(bp.buildings) && bp.buildings.length
            ? bp.buildings
            : (Array.isArray(proposal?.geometry?.buildings) ? proposal.geometry.buildings : []);
        let primary = bp.buildingFeature || buildings[0] || null;
        if (!primary && proposal?.buildingGeometry) {
            primary = { type: 'Feature', geometry: clone(proposal.buildingGeometry), properties: clone(proposal.buildingProperties || {}) };
        }
        return {
            parcelIds: sourceParcels(proposal),
            parentDetails: clone(bp.parentParcelNumbers || bp.parentDetails || null),
            blockName: bp.blockName || null,
            parameters: clone(bp.parameters || {}),
            buildingFeature: clone(primary),
            buildings: clone(buildings.length ? buildings : (primary ? [primary] : []))
        };
    }

    function featureGeometryValid(feature) {
        const geometry = feature?.type === 'Feature' ? feature.geometry : feature;
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return false;
        const coordinates = geometry.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
        const ring = geometry.type === 'Polygon' ? coordinates[0] : coordinates[0]?.[0];
        return Array.isArray(ring) && ring.length >= 4;
    }

    function planFeatures(plan) {
        return (Array.isArray(plan?.polygons) ? plan.polygons : []).map((polygon, index) => ({
            type: 'Feature',
            properties: { index, ownerKey: polygon.ownerKey || null },
            geometry: clone(polygon.geometry || polygon)
        })).filter(feature => featureGeometryValid(feature));
    }

    function geometryArea(value) {
        try {
            if (global.turf && typeof global.turf.area === 'function' && value) {
                const feature = value.type === 'Feature' ? value : { type: 'Feature', properties: {}, geometry: value };
                return global.turf.area(feature);
            }
        } catch (_) { }
        return null;
    }

    function reparcellizationTopologyValidation(plan) {
        const errors = [];
        const warnings = [];
        const features = planFeatures(plan);
        const rawCount = Array.isArray(plan?.polygons) ? plan.polygons.length : 0;
        if (!rawCount) {
            errors.push(issue('missing-polygons', 'Add at least one replacement parcel.', 'editorPayload.plan.polygons'));
            return { errors, warnings };
        }
        if (features.length !== rawCount) {
            errors.push(issue('invalid-polygon', 'Every replacement parcel needs a valid polygon.', 'editorPayload.plan.polygons'));
        }
        features.forEach((feature, index) => {
            try {
                if (typeof global.turf?.booleanValid === 'function' && !global.turf.booleanValid(feature)) {
                    errors.push(issue('invalid-polygon', `Replacement parcel ${index + 1} is self-intersecting or otherwise invalid.`, 'editorPayload.plan.polygons', feature.geometry));
                }
            } catch (_) { }
        });
        const geometryKeys = new Set();
        features.forEach(feature => {
            const key = stable(feature.geometry);
            if (geometryKeys.has(key)) {
                errors.push(issue('overlapping-polygons', 'Two replacement parcels have identical geometry.', 'editorPayload.plan.polygons', feature.geometry));
            }
            geometryKeys.add(key);
        });
        const targetArea = Number(plan?.totalArea);
        const assignedArea = (plan?.polygons || []).reduce((sum, polygon) => {
            const recorded = Number(polygon?.area);
            if (Number.isFinite(recorded) && recorded >= 0) return sum + recorded;
            return sum + (Number(geometryArea(polygon?.geometry || polygon)) || 0);
        }, 0);
        if (Number.isFinite(targetArea) && targetArea > 0 && assignedArea > 0) {
            const tolerance = Math.max(0.5, targetArea * 0.005);
            if (assignedArea < targetArea - tolerance) {
                errors.push(issue('coverage-gap', 'Replacement parcels leave part of the required parent area uncovered.', 'editorPayload.plan.polygons'));
            } else if (assignedArea > targetArea + tolerance) {
                errors.push(issue('coverage-excess', 'Replacement parcel areas exceed the required parent coverage.', 'editorPayload.plan.polygons'));
            }
        }
        if (!global.turf || typeof global.turf.intersect !== 'function' || typeof global.turf.area !== 'function') return { errors, warnings };
        for (let i = 0; i < features.length; i += 1) {
            for (let j = i + 1; j < features.length; j += 1) {
                try {
                    const intersection = global.turf.intersect(features[i], features[j]);
                    if (!intersection) continue;
                    const overlapArea = Number(global.turf.area(intersection)) || 0;
                    const smaller = Math.min(
                        Number(geometryArea(features[i].geometry)) || 0,
                        Number(geometryArea(features[j].geometry)) || 0
                    );
                    // Manual line cuts leave hairline slivers along the shared edges (float noise);
                    // only a real two-dimensional overlap counts as a plan error.
                    if (overlapArea > Math.max(0.5, smaller * 0.001)) {
                        errors.push(issue('overlapping-polygons', `Replacement parcels ${i + 1} and ${j + 1} overlap.`, 'editorPayload.plan.polygons', features[i].geometry));
                    }
                } catch (_) { }
            }
        }
        return { errors, warnings };
    }

    function stripImmutableProposalIdentity(proposal) {
        const output = clone(proposal || {});
        [
            'proposalId', 'proposal_id', 'id', 'hash', 'chainProposalId', 'tokenId', 'onchain', 'nft',
            'createdAt', 'updatedAt', 'acceptedParcelIds', 'ownerAcceptances', 'executedAt', 'appliedAt'
        ].forEach(key => delete output[key]);
        return output;
    }

    function applyFieldsToProposal(output, draft) {
        const fields = draft.fields || {};
        output.title = fields.name || output.title || output.name || '';
        output.name = output.title;
        output.proposalName = output.title;
        output.description = fields.description || '';
        output.parentParcelIds = clone(fields.parentParcelIds || []);
        output.offer = Number(fields.offer) || 0;
        output.budget = output.offer;
        output.offerCurrency = fields.offerCurrency || 'USDT';
        output.budgetCurrency = output.offerCurrency;
        output.acquisitionMode = fields.acquisitionMode || output.acquisitionMode || null;
        output.boundaryAdjustment = fields.boundaryAdjustment || output.boundaryAdjustment || null;
        output.isConditional = fields.isConditional === true;
        output.disbursementMode = output.isConditional ? 'conditional' : 'partial';
        output.expiresAt = fields.expiresAt || null;
        output.decayEnabled = fields.decayEnabled === true;
        output.decayPercent = Number(fields.decayPercent) || 0;
        output.decayDurationMs = Number(fields.decayDurationMs) || 0;
        output.depositEnabled = fields.depositEnabled === true;
        output.depositPercent = Number(fields.depositPercent) || 0;
        const facets = clone(fields.facets || output.facets || output.proposalFacets || {}) || {};
        if (fields.ownership !== undefined && fields.ownership !== null && fields.ownership !== '') facets.ownership = fields.ownership;
        if (fields.recipientScope !== undefined && fields.recipientScope !== null && fields.recipientScope !== '') facets.recipientScope = fields.recipientScope;
        if (fields.recipientAddress !== undefined && fields.recipientAddress !== null) facets.recipientAddress = fields.recipientAddress;
        if (Object.keys(facets).length) {
            output.facets = facets;
            output.proposalFacets = clone(facets);
        }
        return output;
    }

    function commonProposalFromDraft(draft) {
        const output = stripImmutableProposalIdentity(draft.sourceSnapshot || {});
        output.goal = draft.goal;
        output.city = draft.cityId || output.city || null;
        output.applied = false;
        return applyFieldsToProposal(output, draft);
    }

    function stable(value) {
        if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => `${key}:${stable(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    function same(a, b) {
        try { return stable(a) === stable(b); } catch (_) { return a === b; }
    }

    function summarizeCommonChanges(source, draft) {
        const before = sourceFields(source || {});
        const after = draft.fields || {};
        const facets = [
            ['name', 'Name'],
            ['description', 'Description'],
            ['offer', 'Offer'],
            ['offerCurrency', 'Currency'],
            ['ownership', 'Ownership'],
            ['recipientScope', 'Recipient'],
            ['recipientAddress', 'Recipient address'],
            ['acquisitionMode', 'Acquisition'],
            ['isConditional', 'Conditional terms'],
            ['expiresAt', 'Expiry'],
            ['decayEnabled', 'Decay'],
            ['decayPercent', 'Decay percent'],
            ['decayDurationMs', 'Decay duration'],
            ['depositEnabled', 'Deposit'],
            ['depositPercent', 'Deposit percent']
        ];
        const changedFacets = facets.filter(([key]) => !same(before[key], after[key])).map(([key, label]) => ({
            key,
            label,
            before: clone(before[key]),
            after: clone(after[key])
        }));
        const beforeParcels = new Set(before.parentParcelIds || []);
        const afterParcels = new Set(after.parentParcelIds || []);
        return {
            sourceProposalId: draft.sourceProposalId || sourceId(source),
            draftId: draft.id,
            sourceName: sourceName(source),
            replacementName: after.name || '',
            changedFacets,
            parcels: {
                added: [...afterParcels].filter(id => !beforeParcels.has(id)),
                removed: [...beforeParcels].filter(id => !afterParcels.has(id)),
                unchanged: [...afterParcels].filter(id => beforeParcels.has(id))
            },
            geometry: { changed: false },
            unchanged: changedFacets.length === 0 && same([...beforeParcels].sort(), [...afterParcels].sort())
        };
    }

    function resolveParcelLayer(id) {
        try {
            if (global.multiParcelSelection && typeof global.multiParcelSelection.findParcelById === 'function') {
                const value = global.multiParcelSelection.findParcelById(id);
                if (value) return value;
            }
            if (typeof global.resolveParcelLayerById === 'function') return global.resolveParcelLayerById(id);
        } catch (_) { }
        return null;
    }

    async function prepareParcelSelection(parcelIds) {
        const ids = [...new Set((parcelIds || []).map(String).filter(Boolean))];
        if (!ids.length) return { ids: [], layers: [], substituted: false };
        try {
            if (typeof global.ensureParentParcelsLoaded === 'function') await global.ensureParentParcelsLoaded(ids);
        } catch (error) {
            console.warn('[ProposalEditorAdapters] Could not hydrate all draft parcels', error);
        }
        // Resolve each id to a live layer; an id whose parcel was split away (e.g. a road cut
        // slices out of it) substitutes its CURRENT descendants, so proposing over a partially
        // replaced parent keeps working on today's parcel fabric.
        const resolved = [];
        let substituted = false;
        const layerIndex = global.parcelLayerById instanceof Map
            ? global.parcelLayerById
            : (typeof global.getParcelLayerIdMap === 'function' ? global.getParcelLayerIdMap() : null);
        ids.forEach(id => {
            const direct = resolveParcelLayer(id);
            if (direct) {
                resolved.push({ id, layer: direct });
                return;
            }
            if (layerIndex && typeof layerIndex.forEach === 'function') {
                const prefix = id + '#p-';
                layerIndex.forEach((layer, key) => {
                    if (typeof key !== 'string' || !key.startsWith(prefix) || !layer) return;
                    // The corridor slice that caused the split belongs to the road, not to this
                    // proposal's land — only the remainder slices substitute the parent.
                    if (layer.feature?.properties?.isCorridor === true) return;
                    resolved.push({ id: key, layer });
                    substituted = true;
                });
            }
        });
        if (!resolved.length) return { ids: [], layers: [], substituted: false };
        // Only seed the multi-parcel selection once we know the parcels exist — a failed stage
        // must not leave the checkbox flipped with nothing selected.
        const selection = global.multiParcelSelection;
        if (selection) {
            selection.isActive = true;
            // Seeded programmatically for an editor/dialog flow — released when that flow ends
            // (releaseEditorSeededMultiSelection), so a cancelled Propose or closed design tool
            // doesn't leave multi-select armed and the panel popping on later clicks.
            selection.__seededByEditor = true;
            if (selection.selectedParcels && typeof selection.selectedParcels.clear === 'function') selection.selectedParcels.clear();
            resolved.forEach(entry => {
                selection.selectedParcels?.add(entry.id);
                try { if (typeof selection.addParcelHighlight === 'function') selection.addParcelHighlight(entry.layer); } catch (_) { }
            });
            selection.lastSelectedParcelId = resolved[resolved.length - 1].id;
            try { if (typeof selection.updateUI === 'function') selection.updateUI(); } catch (_) { }
        }
        return { ids: resolved.map(entry => entry.id), layers: resolved.map(entry => entry.layer), substituted };
    }

    // Exit a multi-parcel selection that an editor flow seeded (never one the user built by hand).
    function releaseEditorSeededMultiSelection() {
        const selection = global.multiParcelSelection;
        if (!selection || !selection.isActive || !selection.__seededByEditor) return;
        selection.__seededByEditor = false;
        try {
            if (typeof selection.toggle === 'function') {
                selection.toggle({ restoreSingleSelection: false });
                return;
            }
        } catch (_) { }
        try {
            selection.clearSelection?.();
            selection.isActive = false;
            selection.updateUI?.();
        } catch (_) { }
    }

    async function prepareProposalDraftParcelSelection(draftOrParcelIds) {
        if (Array.isArray(draftOrParcelIds)) return prepareParcelSelection(draftOrParcelIds);
        const draft = draftOrParcelIds || {};
        const originalIds = (draft.fields?.parentParcelIds || []).map(String);
        const childIds = sourceChildParcels(draft.sourceSnapshot || {});
        if (sourceIsApplied(draft.sourceSnapshot) && childIds.length) {
            const descendants = await prepareParcelSelection(childIds);
            if (descendants.layers.length) {
                return { ...descendants, usesSourceChildren: true, originalIds };
            }
        }
        return { ...(await prepareParcelSelection(originalIds)), usesSourceChildren: false, originalIds };
    }

    function proposalTypeLabel(goal) {
        const labels = {
            'road-track': 'Road / Track', buildings: 'Block', row: 'Row houses', parcelBased: 'Detached houses',
            single: 'Freeform building', reparcellization: 'Reparcellization', park: 'Park', square: 'Square', lake: 'Lake',
            station: 'Transit station',
            'urban-rule': 'Urban rule', 'decide-later': 'Merge parcels', 'ownership-transfer': 'Ownership transfer', 'as-is': 'Proposal'
        };
        return labels[goal] || String(goal || 'Proposal').replace(/-/g, ' ');
    }

    function buildGenericAdapter(key, options = {}) {
        return {
            key,
            label: options.label || proposalTypeLabel(key),
            sections: options.sections || ['parcels', 'ownership', 'terms', 'details'],
            hasDesign: options.hasDesign === true,
            canEdit() { return true; },
            draftFromProposal(proposal) {
                return {
                    adapterKey: key,
                    proposalType: proposal.primaryType || proposalTypeLabel(key),
                    fields: sourceFields(proposal),
                    editorPayload: {
                        geometry: clone(proposal.geometry || proposal.structureProposal?.geometry || null),
                        structureProposal: clone(proposal.structureProposal || null),
                        facets: clone(proposal.facets || proposal.proposalFacets || null)
                    },
                    previewGeometry: clone(proposal.geometry || proposal.structureProposal?.geometry || null)
                };
            },
            validate(draft) {
                const { errors, warnings } = commonValidation(draft);
                if (key === 'as-is' && !draft.sourceProposalId
                    && (!draft.fields?.ownership || draft.fields.ownership === 'no-change')) {
                    errors.push(issue('missing-goal', 'Choose a proposal type or an ownership change.', 'goal'));
                }
                return { valid: errors.length === 0, errors, warnings };
            },
            renderPreview(draft, viewMode) {
                return { kind: 'parcel-highlight', viewMode: viewMode || '2d', parcelIds: clone(draft.fields?.parentParcelIds || []), geometry: clone(draft.editorPayload?.geometry || null) };
            },
            openDesignEditor() { return false; },
            serializeProposal(draft) {
                const output = commonProposalFromDraft(draft);
                if (draft.editorPayload?.geometry) output.geometry = clone(draft.editorPayload.geometry);
                if (draft.editorPayload?.structureProposal) output.structureProposal = clone(draft.editorPayload.structureProposal);
                return output;
            },
            summarizeChanges(source, draft) {
                const summary = summarizeCommonChanges(source, draft);
                const beforeGeometry = source?.geometry || source?.structureProposal?.geometry || null;
                const afterGeometry = draft.editorPayload?.geometry || null;
                summary.geometry = {
                    changed: !same(beforeGeometry, afterGeometry),
                    beforeArea: geometryArea(beforeGeometry),
                    afterArea: geometryArea(afterGeometry)
                };
                summary.unchanged = summary.unchanged && !summary.geometry.changed;
                return summary;
            }
        };
    }

    function structureGeometry(proposal) {
        return clone(proposal?.structureProposal?.geometry
            || proposal?.geometry?.parkGraphics
            || proposal?.geometry?.squareGraphics
            || (['Polygon', 'MultiPolygon'].includes(proposal?.geometry?.type) ? proposal.geometry : null)
            || null);
    }

    function buildStructureAdapter(key) {
        const adapter = buildGenericAdapter(key, {
            hasDesign: true,
            sections: ['design', 'parcels', 'ownership', 'terms', 'details']
        });
        adapter.draftFromProposal = function draftStructureFromProposal(proposal) {
            const geometry = structureGeometry(proposal);
            const structureProposal = clone(proposal?.structureProposal || {
                kind: key,
                applied: false,
                geometry,
                parentParcelIds: sourceParcels(proposal)
            });
            structureProposal.kind = key;
            structureProposal.geometry = clone(geometry);
            return {
                adapterKey: key,
                proposalType: proposal.primaryType || proposalTypeLabel(key),
                fields: sourceFields(proposal),
                editorPayload: {
                    geometry: clone(geometry),
                    structureProposal,
                    facets: clone(proposal.facets || proposal.proposalFacets || null)
                },
                previewGeometry: clone(geometry)
            };
        };
        adapter.validate = function validateStructure(draft) {
            const { errors, warnings } = commonValidation(draft);
            const geometry = draft?.editorPayload?.structureProposal?.geometry || draft?.editorPayload?.geometry;
            if (!featureGeometryValid(geometry)) {
                errors.push(issue('invalid-structure-geometry', 'The structure needs a valid parcel boundary.', 'editorPayload.structureProposal.geometry'));
            }
            return { valid: errors.length === 0, errors, warnings };
        };
        adapter.renderPreview = function renderStructurePreview(draft, viewMode) {
            const structureProposal = clone(draft?.editorPayload?.structureProposal || {});
            return {
                kind: 'structure',
                structureKind: key,
                viewMode: viewMode || '2d',
                parcelIds: clone(draft?.fields?.parentParcelIds || []),
                geometry: clone(structureProposal.geometry || draft?.editorPayload?.geometry || null),
                decorations: clone(structureProposal.decorations || null)
            };
        };
        adapter.openDesignEditor = function openStructureDesignEditor(draft) {
            if (typeof global.openStructureGeometryEditor !== 'function') return false;
            return global.openStructureGeometryEditor(draft);
        };
        adapter.serializeProposal = function serializeStructure(draft) {
            const output = commonProposalFromDraft(draft);
            const structureProposal = clone(draft?.editorPayload?.structureProposal || {});
            structureProposal.kind = key;
            structureProposal.geometry = clone(structureProposal.geometry || draft?.editorPayload?.geometry || null);
            structureProposal.parentParcelIds = clone(draft?.fields?.parentParcelIds || []);
            output.structureProposal = structureProposal;
            output.geometry = clone(draft?.editorPayload?.geometry || structureProposal.geometry);
            return output;
        };
        return adapter;
    }

    function buildStationAdapter() {
        const adapter = buildGenericAdapter('station', {
            label: 'Transit station',
            sections: ['design', 'parcels', 'ownership', 'terms', 'details'],
            hasDesign: true
        });
        adapter.draftFromProposal = function draftStationFromProposal(proposal) {
            const structureProposal = clone(proposal?.structureProposal || {});
            structureProposal.kind = 'station';
            if (structureProposal.stationType === 'elevated' && !Number.isFinite(Number(structureProposal.platformHeightM))) {
                structureProposal.platformHeightM = Number(global.TransitStationModels?.specFor?.('elevated')?.defaultPlatformHeightM) || 10;
            }
            const geometry = clone(structureProposal.geometry || proposal?.geometry?.stationGraphics || proposal?.geometry || null);
            structureProposal.geometry = geometry;
            return {
                adapterKey: 'station',
                proposalType: proposal.primaryType || proposalTypeLabel('station'),
                fields: sourceFields(proposal),
                editorPayload: {
                    geometry: clone(geometry),
                    structureProposal,
                    facets: clone(proposal.facets || proposal.proposalFacets || null)
                },
                previewGeometry: clone(geometry)
            };
        };
        adapter.validate = function validateStation(draft) {
            const { errors, warnings } = commonValidation(draft);
            const station = draft?.editorPayload?.structureProposal || {};
            const geometry = station.geometry || draft?.editorPayload?.geometry;
            if (!featureGeometryValid(geometry)) {
                errors.push(issue('invalid-station-footprint', 'The station needs a valid footprint.', 'editorPayload.structureProposal.geometry'));
            }
            if (!['bus', 'tram', 'underground', 'elevated'].includes(String(station.stationType || ''))) {
                errors.push(issue('invalid-station-type', 'Choose a bus, tram, underground, or elevated station.', 'editorPayload.structureProposal.stationType'));
            }
            const center = station.center;
            if (!Array.isArray(center) || center.length < 2 || !center.every(Number.isFinite)) {
                errors.push(issue('invalid-station-centre', 'The station needs a valid centre point.', 'editorPayload.structureProposal.center'));
            }
            if (station.stationType === 'elevated') {
                const platformHeightM = Number(station.platformHeightM);
                if (!Number.isFinite(platformHeightM) || platformHeightM < 3 || platformHeightM > 40) {
                    errors.push(issue('invalid-station-platform-height', 'Elevated platform height must be between 3 and 40 metres.', 'editorPayload.structureProposal.platformHeightM'));
                }
            }
            return { valid: errors.length === 0, errors, warnings };
        };
        adapter.renderPreview = function renderStationPreview(draft, viewMode) {
            const station = clone(draft?.editorPayload?.structureProposal || {});
            return {
                kind: 'structure',
                structureKind: 'station',
                stationType: station.stationType || null,
                bearing: Number.isFinite(Number(station.bearing)) ? Number(station.bearing) : 0,
                platformHeightM: Number.isFinite(Number(station.platformHeightM)) ? Number(station.platformHeightM) : null,
                viewMode: viewMode || '2d',
                parcelIds: clone(draft?.fields?.parentParcelIds || []),
                geometry: clone(station.geometry || draft?.editorPayload?.geometry || null)
            };
        };
        adapter.openDesignEditor = function openStationDesignEditor(draft) {
            if (typeof global.openTransitStationGeometryEditor !== 'function') return false;
            return global.openTransitStationGeometryEditor(draft);
        };
        adapter.serializeProposal = function serializeStation(draft) {
            const output = commonProposalFromDraft(draft);
            const station = clone(draft?.editorPayload?.structureProposal || {});
            station.kind = 'station';
            station.geometry = clone(station.geometry || draft?.editorPayload?.geometry || null);
            station.parentParcelIds = clone(draft?.fields?.parentParcelIds || []);
            output.goal = 'station';
            output.primaryType = proposalTypeLabel('station');
            output.type = 'structure';
            output.structureProposal = station;
            output.geometry = { stationGraphics: clone(station.geometry) };
            return output;
        };
        return adapter;
    }

    const corridorAdapter = {
        key: 'road-track',
        label: 'Road / Track',
        sections: ['design', 'parcels', 'ownership', 'terms', 'details'],
        hasDesign: true,
        canEdit(proposal) {
            const definition = corridorDefinition(proposal);
            const segments = corridorSegments(definition);
            if (!definition || !segments.length || segments.some(segment => !Array.isArray(segment) || segment.length < 2 || segment.some(point => !validLngLatPoint(point)))) {
                return { editable: false, reason: 'This legacy corridor does not contain a recoverable centerline.' };
            }
            return true;
        },
        draftFromProposal(proposal) {
            const definition = clone(corridorDefinition(proposal));
            const kind = global.corridorIsTrack(definition) || proposal.primaryType === 'Track' ? 'track' : 'road';
            return {
                adapterKey: 'road-track',
                proposalType: kind === 'track' ? 'Track' : 'Road',
                fields: sourceFields(proposal),
                editorPayload: { kind, definition },
                previewGeometry: clone(definition?.polygon || null)
            };
        },
        validate(draft) {
            const { errors, warnings } = commonValidation(draft);
            const definition = draft.editorPayload?.definition;
            const segments = corridorSegments(definition);
            if (!segments.length || segments.some(segment => segment.length < 2 || segment.some(point => !validLngLatPoint(point)))) {
                errors.push(issue('invalid-centerline', 'The corridor needs at least one valid two-point segment.', 'editorPayload.definition.points'));
            }
            const width = Number(definition?.width);
            if (!Number.isFinite(width) || width <= 0) errors.push(issue('invalid-width', 'Set a corridor width greater than zero.', 'editorPayload.definition.width'));
            if (!definition?.polygon) warnings.push(issue('preview-pending', 'The corridor footprint will be rebuilt when Design opens.', 'editorPayload.definition.polygon'));
            return { valid: errors.length === 0, errors, warnings };
        },
        renderPreview(draft, viewMode) {
            return {
                kind: 'corridor',
                viewMode: viewMode || '2d',
                definition: clone(draft.editorPayload?.definition || null),
                sourceDefinition: clone(corridorDefinition(draft.sourceSnapshot) || null)
            };
        },
        async openDesignEditor(draft) {
            const definition = draft.editorPayload?.definition;
            if ((!definition || !corridorSegments(definition).length) && typeof global.requestCorridorDrawingTool === 'function') {
                return global.requestCorridorDrawingTool(draft.editorPayload?.kind === 'track' ? 'track' : 'road');
            }
            if (!definition || typeof global.startSeededCorridorDrawing !== 'function') return false;
            const kind = draft.editorPayload?.kind || (global.corridorIsTrack(definition) ? 'track' : 'road');
            const seed = corridorSeed(definition, kind);
            return global.startSeededCorridorDrawing(kind, seed, {
                proposalId: draft.sourceProposalId,
                name: draft.fields?.name || sourceName(draft.sourceSnapshot),
                draftId: draft.id,
                prefill: clone(draft.fields || {})
            });
        },
        serializeProposal(draft) {
            const output = commonProposalFromDraft(draft);
            const definition = clone(draft.editorPayload?.definition || {});
            const kind = draft.editorPayload?.kind || (global.corridorIsTrack(definition) ? 'track' : 'road');
            output.goal = 'road-track';
            output.primaryType = kind === 'track' ? 'Track' : 'Road';
            output.isCorridor = true;
            output.definition = definition;
            output.geometry = { ...(output.geometry || {}), roadPlan: clone(definition) };
            if (definition.polygon) output.geometry.roadGeometry = { polygon: clone(definition.polygon) };
            output.roadProposal = {
                ...(clone(output.roadProposal || {})),
                definition: clone(definition),
                parentParcelIds: clone(draft.fields?.parentParcelIds || []),
                childParcelIds: [],
                applied: false,
                isCorridor: true
            };
            return output;
        },
        summarizeChanges(source, draft) {
            const summary = summarizeCommonChanges(source, draft);
            const before = corridorDefinition(source) || {};
            const after = draft.editorPayload?.definition || {};
            summary.geometry = {
                changed: !same(before.points || before.segments, after.points || after.segments),
                beforeArea: geometryArea(before.polygon),
                afterArea: geometryArea(after.polygon),
                beforeWidth: Number(before.width) || null,
                afterWidth: Number(after.width) || null,
                widthChange: (Number(after.width) || 0) - (Number(before.width) || 0),
                profileChanged: !same(before.profile || null, after.profile || null),
                tunnelsChanged: !same(before.tunnels || [], after.tunnels || []),
                gradeSeparationsChanged: !same(before.gradeSeparations || [], after.gradeSeparations || [])
            };
            summary.unchanged = summary.unchanged && !summary.geometry.changed
                && summary.geometry.widthChange === 0 && !summary.geometry.profileChanged
                && !summary.geometry.tunnelsChanged && !summary.geometry.gradeSeparationsChanged;
            return summary;
        },
        payloadFromDrawingSeed(seed, sourceDefinition) {
            return { kind: seed?.kind || (global.corridorIsTrack(sourceDefinition) ? 'track' : 'road'), definition: corridorPayloadFromSeed(seed, sourceDefinition) };
        }
    };

    function buildingGoalForProposal(proposal, fallback) {
        const typology = proposal?.typologyType || proposal?.buildingProposal?.typologyType || proposal?.buildingProposal?.parameters?.typology || fallback;
        const normalized = normalizeGoal(typology);
        if (normalized === 'single') return 'single';
        if (normalized === 'row') return 'row';
        if (normalized === 'parcelBased') return 'parcelBased';
        return 'buildings';
    }

    function buildBuildingAdapter(key) {
        return {
            key,
            label: proposalTypeLabel(key),
            sections: ['design', 'parcels', 'ownership', 'terms', 'details'],
            hasDesign: true,
            canEdit(proposal) {
                const context = proposalBuildingContext(proposal);
                const features = context.buildings?.length ? context.buildings : (context.buildingFeature ? [context.buildingFeature] : []);
                if (!features.length || features.some(feature => !featureGeometryValid(feature))) {
                    return { editable: false, reason: 'This legacy building proposal does not contain recoverable footprint geometry.' };
                }
                return true;
            },
            draftFromProposal(proposal) {
                const resolvedKey = buildingGoalForProposal(proposal, key);
                const context = proposalBuildingContext(proposal);
                return {
                    adapterKey: resolvedKey,
                    proposalType: proposal.primaryType || proposalTypeLabel(resolvedKey),
                    fields: sourceFields(proposal),
                    editorPayload: { typology: resolvedKey, context },
                    previewGeometry: clone(context.buildings?.length ? context.buildings : [context.buildingFeature].filter(Boolean))
                };
            },
            validate(draft) {
                const { errors, warnings } = commonValidation(draft);
                const context = draft.editorPayload?.context || {};
                const features = context.buildings?.length ? context.buildings : (context.buildingFeature ? [context.buildingFeature] : []);
                if (!features.length) errors.push(issue('missing-building', 'Create at least one building footprint.', 'editorPayload.context.buildings'));
                features.forEach((feature, index) => {
                    if (!featureGeometryValid(feature)) errors.push(issue('invalid-building', `Building ${index + 1} has an invalid footprint.`, `editorPayload.context.buildings.${index}`, feature?.geometry));
                });
                return { valid: errors.length === 0, errors, warnings };
            },
            renderPreview(draft, viewMode) {
                return {
                    kind: 'buildings',
                    viewMode: viewMode || '2d',
                    typology: draft.editorPayload?.typology || key,
                    features: clone(draft.editorPayload?.context?.buildings || [draft.editorPayload?.context?.buildingFeature].filter(Boolean))
                };
            },
            async openDesignEditor(draft) {
                const context = clone(draft.editorPayload?.context || {});
                const selection = await prepareProposalDraftParcelSelection(draft);
                if (!selection.layers.length) throw new Error('The source parcels are not available in this city view.');
                context.parcelIds = selection.ids;
                global.pendingBuildingProposalContext = context;
                if (typeof global.setPendingBuildingProposalContext === 'function') global.setPendingBuildingProposalContext(context, { fromDraft: true });
                const typology = draft.editorPayload?.typology || key;
                const features = context.buildings?.length ? context.buildings : [context.buildingFeature].filter(Boolean);
                if (typology === 'single' && typeof global.openSingleBuildingForParcels === 'function') {
                    global.openSingleBuildingForParcels({ blockName: context.blockName, parcels: selection.layers, initialBuildings: features });
                    return true;
                }
                if (typology === 'row' && typeof global.openRowHouseForParcels === 'function') {
                    global.openRowHouseForParcels({ blockName: context.blockName, parcels: selection.layers, initialParameters: context.parameters || null });
                    return true;
                }
                if (typology === 'parcelBased' && typeof global.openParcelBasedForParcels === 'function') {
                    global.openParcelBasedForParcels({ blockName: context.blockName, parcels: selection.layers, initialParameters: context.parameters || null });
                    return true;
                }
                const opener = global.openUrbanRuleForParcels || global.openBlockifyForParcels;
                if (typeof opener === 'function') {
                    const seed = typeof global.buildBlockifySeed === 'function' ? global.buildBlockifySeed(context) : context.parameters;
                    opener({ blockName: context.blockName, parcels: selection.layers, initialState: seed || null });
                    return true;
                }
                return false;
            },
            serializeProposal(draft) {
                const output = commonProposalFromDraft(draft);
                const context = clone(draft.editorPayload?.context || {});
                const features = context.buildings?.length ? context.buildings : [context.buildingFeature].filter(Boolean);
                const typology = draft.editorPayload?.typology || key;
                output.goal = typology === 'single' ? 'single' : 'buildings';
                output.primaryType = 'Urban Rule';
                output.typologyType = typology;
                output.geometry = { ...(output.geometry || {}), buildings: clone(features) };
                output.buildingGeometry = clone(features[0]?.geometry || null);
                output.buildingProperties = clone(features[0]?.properties || {});
                output.buildingProposal = {
                    ...(clone(output.buildingProposal || {})),
                    applied: false,
                    typologyType: typology,
                    parentParcelIds: clone(draft.fields?.parentParcelIds || []),
                    parameters: clone(context.parameters || {}),
                    buildingFeature: clone(features[0] || null),
                    buildings: clone(features),
                    blockName: context.blockName || null
                };
                return output;
            },
            summarizeChanges(source, draft) {
                const summary = summarizeCommonChanges(source, draft);
                const beforeContext = proposalBuildingContext(source);
                const afterContext = draft.editorPayload?.context || {};
                const beforeFeatures = beforeContext.buildings?.length ? beforeContext.buildings : [beforeContext.buildingFeature].filter(Boolean);
                const afterFeatures = afterContext.buildings?.length ? afterContext.buildings : [afterContext.buildingFeature].filter(Boolean);
                const height = feature => Number(feature?.properties?.height || feature?.properties?.heightM || feature?.properties?.floors || 0) || null;
                summary.geometry = {
                    changed: !same(beforeFeatures, afterFeatures),
                    beforeArea: beforeFeatures.reduce((sum, feature) => sum + (geometryArea(feature) || 0), 0),
                    afterArea: afterFeatures.reduce((sum, feature) => sum + (geometryArea(feature) || 0), 0),
                    beforeHeight: height(beforeFeatures[0]),
                    afterHeight: height(afterFeatures[0]),
                    buildingCountBefore: beforeFeatures.length,
                    buildingCountAfter: afterFeatures.length,
                    parametersChanged: !same(beforeContext.parameters || {}, afterContext.parameters || {})
                };
                summary.unchanged = summary.unchanged && !summary.geometry.changed && !summary.geometry.parametersChanged;
                return summary;
            }
        };
    }

    const reparcellizationAdapter = {
        key: 'reparcellization',
        label: 'Reparcellization',
        sections: ['design', 'parcels', 'ownership', 'terms', 'details'],
        hasDesign: true,
        canEdit(proposal) {
            const plan = proposal?.reparcellization;
            if (!plan || !Array.isArray(plan.polygons) || !plan.polygons.length) {
                return { editable: false, reason: 'This legacy reparcellization proposal does not contain saved replacement polygons.' };
            }
            return true;
        },
        draftFromProposal(proposal) {
            const plan = clone(proposal.reparcellization || null);
            return {
                adapterKey: 'reparcellization',
                proposalType: 'Reparcellization',
                fields: sourceFields(proposal),
                editorPayload: { plan },
                previewGeometry: clone(plan?.polygons || null)
            };
        },
        validate(draft) {
            const common = commonValidation(draft);
            const topology = reparcellizationTopologyValidation(draft.editorPayload?.plan);
            const requiredParents = new Set((draft.fields?.parentParcelIds || []).map(String));
            const planParents = new Set((draft.editorPayload?.plan?.parcelIds || []).map(String));
            const missingParents = [...requiredParents].filter(id => !planParents.has(id));
            if (missingParents.length) {
                topology.errors.push(issue(
                    'missing-parent-coverage',
                    `The plan is missing ${missingParents.length} required parent parcel(s).`,
                    'editorPayload.plan.parcelIds'
                ));
            }
            return {
                valid: common.errors.length + topology.errors.length === 0,
                errors: [...common.errors, ...topology.errors],
                warnings: [...common.warnings, ...topology.warnings]
            };
        },
        renderPreview(draft, viewMode) {
            return { kind: 'reparcellization', viewMode: viewMode || '2d', polygons: clone(draft.editorPayload?.plan?.polygons || []) };
        },
        async openDesignEditor(draft) {
            const plan = clone(draft.editorPayload?.plan || {});
            const selection = await prepareProposalDraftParcelSelection(draft);
            if (!selection.layers.length) throw new Error('The source parcels are not available in this city view.');
            plan.parcelIds = selection.ids;
            global.pendingReparcellizationPlan = plan;
            if (typeof global.openReparcellizationModal !== 'function' && typeof global.ensureReparcellizationModuleLoaded === 'function') {
                await global.ensureReparcellizationModuleLoaded();
            }
            if (typeof global.openReparcellizationModal !== 'function') return false;
            return global.openReparcellizationModal({
                algorithm: plan.algorithm || 'sweep-line',
                ownershipMode: plan.ownershipMode || 'multiple',
                initialPolygons: clone(plan.polygons || [])
            });
        },
        serializeProposal(draft) {
            const output = commonProposalFromDraft(draft);
            const plan = clone(draft.editorPayload?.plan || {});
            plan.parcelIds = clone(draft.fields?.parentParcelIds || []);
            output.goal = 'reparcellization';
            output.primaryType = 'Reparcellization';
            output.reparcellization = plan;
            return output;
        },
        summarizeChanges(source, draft) {
            const summary = summarizeCommonChanges(source, draft);
            const before = source?.reparcellization?.polygons || [];
            const after = draft.editorPayload?.plan?.polygons || [];
            const totalArea = polygons => planFeatures({ polygons }).reduce((sum, feature) => sum + (geometryArea(feature) || 0), 0);
            summary.geometry = {
                changed: !same(before, after),
                polygonCountBefore: before.length,
                polygonCountAfter: after.length,
                beforeArea: totalArea(before),
                afterArea: totalArea(after),
                ownershipChanged: !same(before.map(p => p.ownerKey || p.owners), after.map(p => p.ownerKey || p.owners))
            };
            summary.unchanged = summary.unchanged && !summary.geometry.changed;
            return summary;
        }
    };

    function createRegistry() {
        const adapters = new Map();
        const aliases = new Map();
        const readOnly = new Map();

        function register(key, adapter, options = {}) {
            const normalized = normalizeGoal(key);
            if (!normalized) throw new Error('Adapter key is required.');
            const value = { ...adapter, key: adapter?.key || normalized };
            adapters.set(normalized, value);
            (options.aliases || []).forEach(alias => aliases.set(normalizeGoal(alias), normalized));
            return value;
        }

        function declareReadOnly(key, reason) {
            const normalized = normalizeGoal(key);
            readOnly.set(normalized, reason || 'This proposal type is read-only.');
        }

        function get(keyOrProposal) {
            const rawKey = typeof keyOrProposal === 'object' ? sourceGoal(keyOrProposal) : normalizeGoal(keyOrProposal);
            // A direct adapter key always wins; aliases only catch names no adapter owns.
            // (The legacy 'building(s)' label normalizes to 'single' — an alias registered under
            // that name would shadow the Detached adapter and open the wrong design editor.)
            const key = adapters.has(rawKey) ? rawKey : (aliases.get(rawKey) || rawKey);
            if (adapters.has(key)) return adapters.get(key);
            if (readOnly.has(key)) {
                return {
                    key,
                    label: proposalTypeLabel(key),
                    sections: ['details'],
                    hasDesign: false,
                    canEdit: () => ({ editable: false, reason: readOnly.get(key) })
                };
            }
            return null;
        }

        function canEdit(proposal) {
            const adapter = get(proposal);
            if (!adapter) return { editable: false, reason: 'No editor adapter is registered for this proposal type.' };
            const result = typeof adapter.canEdit === 'function' ? adapter.canEdit(proposal) : true;
            if (result === true) return { editable: true, reason: null, adapter };
            if (typeof result === 'string') return { editable: false, reason: result, adapter };
            return { editable: result?.editable === true, reason: result?.reason || null, adapter };
        }

        function completeness(goals = CREATABLE_PROPOSAL_GOALS) {
            const missing = goals.map(normalizeGoal).filter(key => !adapters.has(key) && !readOnly.has(key));
            return { complete: missing.length === 0, missing };
        }

        function list() {
            return [...adapters.entries()].map(([key, adapter]) => ({ key, label: adapter.label || proposalTypeLabel(key), readOnly: false }))
                .concat([...readOnly.entries()].map(([key, reason]) => ({ key, label: proposalTypeLabel(key), readOnly: true, reason })));
        }

        return { register, declareReadOnly, get, getAdapter: get, canEdit, completeness, list, normalizeGoal };
    }

    const registry = createRegistry();
    registry.register('road-track', corridorAdapter, { aliases: ['road', 'track', 'road/track'] });
    registry.register('buildings', buildBuildingAdapter('buildings'), { aliases: ['residences', 'block'] });
    registry.register('row', buildBuildingAdapter('row'));
    registry.register('parcelBased', buildBuildingAdapter('parcelBased'), { aliases: ['parcel-based', 'parcelbased'] });
    registry.register('single', buildBuildingAdapter('single'), { aliases: ['single-building'] });
    registry.register('reparcellization', reparcellizationAdapter);
    registry.register('urban-rule', buildGenericAdapter('urban-rule'));
    registry.register('as-is', buildGenericAdapter('as-is'));
    registry.register('park', buildStructureAdapter('park'));
    registry.register('square', buildStructureAdapter('square'));
    registry.register('lake', buildGenericAdapter('lake', { hasDesign: true }));
    registry.register('station', buildStationAdapter(), { aliases: ['transit-station'] });
    // Existing stored merge proposals remain readable/applicable, but this removed goal cannot be
    // used as the source of a new or replacement draft.
    registry.declareReadOnly('decide-later', 'Merge / Decide Later is no longer a creatable proposal type.');
    registry.register('ownership-transfer', buildGenericAdapter('ownership-transfer'), {
        aliases: ['ownership-transfer-to-me', 'ownership-transfer-from-me']
    });

    function getProposalEditorAdapter(proposalOrGoal) {
        return registry.get(proposalOrGoal);
    }

    function summarizeProposalDraftChanges(draftOrId) {
        const draft = typeof draftOrId === 'string'
            ? global.proposalDraftStore?.getDraft(draftOrId)
            : draftOrId;
        if (!draft) return null;
        const adapter = registry.get(draft.adapterKey || draft.goal);
        if (!adapter || typeof adapter.summarizeChanges !== 'function') return summarizeCommonChanges(draft.sourceSnapshot || {}, draft);
        return adapter.summarizeChanges(draft.sourceSnapshot || {}, draft);
    }

    async function openProposalDraftDesign(draftOrId) {
        const draft = typeof draftOrId === 'string'
            ? global.proposalDraftStore?.getDraft(draftOrId)
            : draftOrId;
        if (!draft) return false;
        const adapter = registry.get(draft.adapterKey || draft.goal);
        if (!adapter || typeof adapter.openDesignEditor !== 'function') return false;
        if (typeof global.beginProposalDraftDesignSession === 'function') {
            global.beginProposalDraftDesignSession(draft.id);
        }
        try {
            const opened = await adapter.openDesignEditor(draft);
            if (opened === false && typeof global.finishProposalDraftDesignSession === 'function') {
                global.finishProposalDraftDesignSession(draft.id);
            }
            return opened;
        } catch (error) {
            if (typeof global.finishProposalDraftDesignSession === 'function') {
                global.finishProposalDraftDesignSession(draft.id);
            }
            throw error;
        }
    }

    global.CREATABLE_PROPOSAL_GOALS = CREATABLE_PROPOSAL_GOALS.slice();
    global.createProposalEditorAdapterRegistry = createRegistry;
    global.proposalEditorAdapterRegistry = registry;
    global.proposalEditorAdapters = registry;
    global.getProposalEditorAdapter = getProposalEditorAdapter;
    global.summarizeProposalDraftChanges = summarizeProposalDraftChanges;
    global.openProposalDraftDesign = openProposalDraftDesign;
    global.prepareProposalDraftParcelSelection = prepareProposalDraftParcelSelection;
    global.releaseEditorSeededMultiSelection = releaseEditorSeededMultiSelection;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            CREATABLE_PROPOSAL_GOALS,
            createProposalEditorAdapterRegistry: createRegistry,
            registry,
            normalizeGoal,
            corridorAdapter,
            buildBuildingAdapter,
            reparcellizationAdapter,
            buildGenericAdapter,
            buildStructureAdapter,
            buildStationAdapter,
            summarizeCommonChanges
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
