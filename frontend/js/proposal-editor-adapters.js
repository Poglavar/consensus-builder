// Purpose: provide one editor contract for every creatable proposal goal.
(function attachProposalEditorAdapters(global) {
    'use strict';

    const turfRef = global.turf || null;

    const designGoals = global.ProposalDesignGoals || (typeof require === 'function'
        ? require('./proposals/design-goals.js') : null);
    if (!designGoals) throw new Error('Proposal design goals are unavailable.');
    const CREATABLE_PROPOSAL_GOALS = designGoals.keys;

    // Physical, material drafts may be explicitly moved to a new site. Parcel acts and
    // parcel layouts remain tied to their authored scope and pool, and the building rules (Block, Row,
    // Detached) to their parcels: leaving them is a conversion to a Freeform building or a re-run of
    // the rule on the parcels there (proposals/freeform-conversion.js), never a free placement.
    const FREE_PLACEMENT_GOALS = new Set([
        'park', 'square', 'lake', 'station', 'single'
    ]);
    const KNOWN_SITE_COVERAGE = new Set(['complete', 'partial', 'none']);

    function translate(key, fallback) {
        try {
            const value = global.i18n?.t?.(key);
            if (value && value !== key) return value;
        } catch (_) { }
        return fallback;
    }

    function placementMessage(key, fallback) {
        return translate(`proposalDrafts.placement.${key}`, fallback);
    }

    function clone(value) {
        if (value === undefined || value === null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    }

    function finalizeAuthoredProposal(proposal) {
        let boundary = global.__formationDepth;
        if ((!boundary || typeof boundary.stripDerivedRecordData !== 'function')
            && typeof require === 'function') {
            if (!global.ProposalAuthoredRecord) {
                global.ProposalAuthoredRecord = require('./proposals/authored-record.js');
            }
            boundary = require('./proposals/formation-depth.js');
        }
        if (!boundary || typeof boundary.stripDerivedRecordData !== 'function') {
            throw new Error('Cannot serialize proposal: the authored-record boundary is unavailable.');
        }
        const output = boundary.stripDerivedRecordData(proposal);
        const verdict = typeof boundary.conformanceOf === 'function'
            ? boundary.conformanceOf(output)
            : { flat: false, violations: [{ code: 'authored-boundary-unavailable' }] };
        if (!verdict.flat) {
            const violation = verdict.violations?.[0];
            throw new Error(`Cannot serialize proposal: ${violation?.field || violation?.code || 'cadastral scope is invalid'}.`);
        }
        return output;
    }

    function normalizeParcelId(value) {
        return value === undefined || value === null ? '' : String(value).trim();
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
        return designGoals.keyOf(proposal) || '';
    }

    function sourceId(proposal) {
        const candidates = [proposal?.proposalId, proposal?.id];
        const value = candidates.find(item => item !== undefined && item !== null && String(item));
        return value === undefined ? null : String(value);
    }

    function sourceName(proposal) {
        return proposal?.title || proposal?.name || proposal?.proposalName || sourceId(proposal) || '';
    }

    function sourceParcels(proposal) {
        const values = Array.isArray(proposal?.cadastreParcelIds)
            ? proposal.cadastreParcelIds
            : [];
        return Array.isArray(values) ? [...new Set(values.map(normalizeParcelId).filter(Boolean))] : [];
    }

    function sourceFields(proposal) {
        const authoredCadastreParcelIds = Array.isArray(proposal?.cadastreParcelIds)
            ? [...new Set(proposal.cadastreParcelIds.map(normalizeParcelId).filter(Boolean))]
            : [];
        return {
            name: sourceName(proposal),
            ...(proposal?.titleOrigin === 'generated' || proposal?.titleOrigin === 'user' ? { titleOrigin: proposal.titleOrigin } : {}),
            description: proposal?.description || '',
            selectedParcelIds: sourceParcels(proposal),
            // Keep the authored land declaration separate from the live parcel selection. An
            // untouched edit must preserve this immutable scope; only a changed/new selection is
            // projected through LiveParcelFabric at serialization time.
            cadastreParcelIds: authoredCadastreParcelIds,
            binding: clone(proposal?.binding || null),
            site: clone(proposal?.site || null),
            toleranceM: Number.isFinite(Number(proposal?.toleranceM)) ? Number(proposal.toleranceM) : 0,
            acquisitionMode: proposal?.acquisitionMode || null,
            boundaryAdjustment: proposal?.boundaryAdjustment || null,
            ownership: proposal?.facets?.ownership || proposal?.proposalFacets?.ownership || null,
            recipientScope: proposal?.facets?.recipientScope || proposal?.proposalFacets?.recipientScope || proposal?.recipientScope || null,
            recipientAddress: proposal?.facets?.recipientAddress || proposal?.proposalFacets?.recipientAddress || proposal?.recipientAddress || null,
            facets: clone(proposal?.facets || proposal?.proposalFacets || null)
        };
    }

    function freePlacementPatch(draft, placement) {
        if (!placement || placement.free !== true) return null;
        const goal = normalizeGoal(draft?.adapterKey || draft?.goal);
        if (!FREE_PLACEMENT_GOALS.has(goal)) {
            throw new Error(placementMessage('fixedSite', 'This proposal type has a fixed site and cannot be moved.'));
        }
        const site = siteDraftApi().toMultiPolygon(placement.site);
        if (!site) throw new Error(placementMessage('invalidSite', 'A free placement needs a valid polygon site.'));
        return {
            site: clone(site),
            placement: { free: true, site: clone(site), bindingStatus: 'pending' },
            fields: { site: clone(site), selectedParcelIds: [], cadastreParcelIds: [], binding: null }
        };
    }

    function isFreePlacementDraft(draft) {
        return !!(draft?.editorPayload?.placement?.free === true
            && FREE_PLACEMENT_GOALS.has(normalizeGoal(draft.adapterKey || draft.goal)));
    }

    function restoredFreePlacement(proposal, goal) {
        const key = normalizeGoal(goal || sourceGoal(proposal));
        if (proposal?.freePlacement !== true || !FREE_PLACEMENT_GOALS.has(key)) {
            return null;
        }
        const site = siteDraftApi().toMultiPolygon(proposal.site);
        if (!site) return null;
        return {
            free: true,
            site: clone(site),
            bindingStatus: String(proposal.binding?.source || '').startsWith('server:')
                && KNOWN_SITE_COVERAGE.has(proposal.binding?.coverage) ? 'bound' : 'pending'
        };
    }

    function markFreePlacementBound(draft, binding) {
        if (!isFreePlacementDraft(draft) || !binding || typeof binding !== 'object'
            || !String(binding.source || '').startsWith('server:')) {
            throw new Error(placementMessage('freshBinding', 'A free placement needs a fresh authoritative site binding.'));
        }
        if (binding.coverage === 'unknown') {
            throw new Error(placementMessage('unknownCoverage', 'The server cannot verify this site against a supported cadastre. Move it into a supported area or contact the city data team.'));
        }
        if (!KNOWN_SITE_COVERAGE.has(binding.coverage)) {
            throw new Error(placementMessage('unverifiedCoverage', 'The site binding did not confirm its cadastral coverage. Retry the binding before applying or publishing.'));
        }
        const site = siteDraftApi().toMultiPolygon(draft.editorPayload.placement.site);
        if (!site) throw new Error(placementMessage('invalidSite', 'A free placement needs a valid polygon site.'));
        const parcelIds = [...new Set((Array.isArray(binding.parcels) ? binding.parcels : [])
            .map(hit => normalizeParcelId(hit?.parcelId)).filter(Boolean))].sort();
        return {
            fields: { site: clone(site), selectedParcelIds: [], cadastreParcelIds: parcelIds, binding: clone(binding) },
            editorPayload: {
                placement: { ...clone(draft.editorPayload.placement), site: clone(site), free: true, bindingStatus: 'bound' }
            }
        };
    }

    function placementBindingIssue(draft) {
        if (!isFreePlacementDraft(draft)) return null;
        const binding = draft.fields?.binding;
        if (binding?.coverage === 'unknown') {
            return issue('placement-binding-unknown', placementMessage('unknownCoverage', 'The server cannot verify this site against a supported cadastre. Move it into a supported area or contact the city data team.'), 'editorPayload.placement.site');
        }
        if (binding && !KNOWN_SITE_COVERAGE.has(binding.coverage)) {
            return issue('placement-binding-unverified', placementMessage('unverifiedCoverage', 'The site binding did not confirm its cadastral coverage. Retry the binding before applying or publishing.'), 'editorPayload.placement.site');
        }
        if (draft.editorPayload.placement.bindingStatus !== 'bound'
            || !binding || !String(binding.source || '').startsWith('server:')) {
            return issue('placement-binding-pending', placementMessage('pending', 'The moved site must be rebound before this draft can be applied or published.'), 'editorPayload.placement.site');
        }
        return null;
    }

    function siteDraftApi() {
        if (global.__siteDraft) return global.__siteDraft;
        if (typeof require === 'function') return require('./proposals/site-draft.js');
        throw new Error('Cannot validate a draft: proposals/site-draft.js is not loaded.');
    }

    // The keys of a published or minted identity (proposals/corridor-authoring.js).
    function publishedIdentityKeys() {
        const api = global.CorridorAuthoring || (typeof require === 'function' ? require('./proposals/corridor-authoring.js') : null);
        if (!api) throw new Error('Cannot build proposal: proposals/corridor-authoring.js is not loaded.');
        return api.PUBLISHED_IDENTITY_KEYS;
    }

    // Synthetic plots cut from a site on bare ground (proposals/site-plots.js) are design input,
    // not cadastral ground: they never reach the declaration.
    function isSitePlotId(id) {
        return /^site(-plot)?:/.test(String(id || ''));
    }

    function boundParcelIds(binding) {
        const parcels = binding && Array.isArray(binding.parcels) ? binding.parcels : [];
        return [...new Set(parcels.map(hit => normalizeParcelId(hit && hit.parcelId)).filter(Boolean))].sort();
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
        // Parcel acts need parcels; material proposals need a site, parcels or their own design
        // geometry (proposals/site-draft.js, PARCEL-OPTIONAL.md).
        const groundIssue = siteDraftApi().draftGroundIssue(draft);
        if (groundIssue) errors.push(issue(groundIssue.code, groundIssue.message, groundIssue.path));
        const placementIssue = placementBindingIssue(draft);
        if (placementIssue) errors.push(placementIssue);
        if (!draft?.fields?.description || !String(draft.fields.description).trim()) {
            warnings.push(issue('missing-description', 'A description will help others understand this proposal.', 'fields.description'));
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
        return proposal?.roadProposal?.definition || null;
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
        delete payload.surfaceFootprint;
        return payload;
    }

    function proposalBuildingContext(proposal) {
        const bp = proposal?.buildingProposal || {};
        const buildings = Array.isArray(proposal?.geometry?.buildings)
            ? proposal.geometry.buildings
            : [];
        let primary = buildings[0] || null;
        if (!primary && proposal?.buildingGeometry) {
            primary = { type: 'Feature', geometry: clone(proposal.buildingGeometry), properties: clone(proposal.buildingProperties || {}) };
        }
        const designParcelIds = sourceParcels(proposal);
        return {
            parcelIds: designParcelIds,
            blockName: bp.blockName || null,
            parameters: clone(bp.parameters || {}),
            buildingFeature: clone(primary),
            buildings: clone(buildings.length ? buildings : (primary ? [primary] : [])),
            blockMassing: clone(proposal?.geometry?.blockMassing || null),
            ineligibleParcels: clone(bp.ineligibleParcels || []),
            // Freeform proposals may pave or green the parcel area around their buildings.
            groundSurface: clone(proposal?.geometry?.groundSurface || null),
            // Keep the authored host outline separate from the effective ground surface.
            groundBoundary: clone(proposal?.geometry?.groundBoundary || null),
            // §15a: footprint parcel (default) vs taking the whole host parcels.
            landTake: clone(proposal?.geometry?.landTake || null)
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

    function polygonCoordinatesValid(geometry) {
        if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return false;
        const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
        return Array.isArray(polygons) && polygons.length > 0 && polygons.every(rings =>
            Array.isArray(rings) && rings.length > 0 && rings.every(ring =>
                Array.isArray(ring) && ring.length >= 4
                && ring.every(point => Array.isArray(point) && point.length >= 2
                    && Number.isFinite(point[0]) && Number.isFinite(point[1]))
                && ring[0][0] === ring[ring.length - 1][0]
                && ring[0][1] === ring[ring.length - 1][1]));
    }

    function featureFromSite(site) {
        const geometry = site && site.type === 'Feature' ? site.geometry : site;
        if (!siteDraftApi().isPolygonal(geometry) || !polygonCoordinatesValid(geometry)) return null;
        return { type: 'Feature', properties: {}, geometry: clone(geometry) };
    }

    function geometryWithinSite(candidate, site) {
        const t = turfRef || global.turf;
        const candidateFeature = featureFromSite(candidate);
        const siteFeature = featureFromSite(site);
        if (!t || typeof t.difference !== 'function' || !candidateFeature || !siteFeature) return false;
        try {
            // Gaps can split one building into several pieces. Difference-null is exact
            // containment, including shared boundaries and holes, without a distance tolerance.
            const parts = candidateFeature.geometry.type === 'MultiPolygon'
                ? candidateFeature.geometry.coordinates
                : [candidateFeature.geometry.coordinates];
            return parts.every(coordinates => t.difference({
                type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates }
            }, siteFeature) === null);
        } catch (_) { return false; }
    }

    function geometryArea(value) {
        try {
            if (turfRef && typeof turfRef.area === 'function' && value) {
                const feature = value.type === 'Feature' ? value : { type: 'Feature', properties: {}, geometry: value };
                return turfRef.area(feature);
            }
        } catch (_) { }
        return null;
    }

    // `site`: a subdivision (plan.poolSource 'site', PARCEL-OPTIONAL.md phase 4) is checked against
    // its SITE, the bound parcels' part and the open ground alike, so the plots must tile exactly the
    // site's ground, whatever pool geometry the layout carries.
    function parcelLayoutGeometryValidation(plan, site) {
        const validator = global.ParcelLayoutValidation
            || (typeof require === 'function' ? require('./parcel-layout-validation.js') : null);
        if (!validator || typeof validator.validate !== 'function') throw new Error('Parcel layout validation is unavailable.');
        const result = validator.validate(plan, { turf: turfRef || global.turf, ...(site ? { site } : {}) });
        const shape = item => issue(item.code, item.message, 'editorPayload.plan',
            item.plotIndex == null ? null : plan?.plots?.[item.plotIndex]?.geometry);
        return { errors: (result.errors || []).map(shape), warnings: (result.warnings || []).map(shape) };
    }

    // A draft's source as a new design: none of the source's local or published (`published`)
    // identity, lifecycle or consent carries over.
    function stripImmutableProposalIdentity(proposal) {
        const output = clone(proposal || {});
        [
            ...publishedIdentityKeys(),
            'proposalId', 'id',
            'lifecycleStatus', 'effectiveStatus', 'effective_status',
            'createdAt', 'updatedAt', 'executedAt', 'appliedAt', 'localPurchaseSimulation'
        ].forEach(key => delete output[key]);
        return output;
    }

    function applyFieldsToProposal(output, draft) {
        const fields = draft.fields || {};
        const selectedParcelIds = [...new Set((fields.selectedParcelIds || [])
            .map(normalizeParcelId).filter(Boolean).filter(id => !isSitePlotId(id)))];
        const authoredCadastreParcelIds = [...new Set((fields.cadastreParcelIds || [])
            .map(normalizeParcelId).filter(Boolean))];
        const sourceSelectionIds = sourceParcels(draft.sourceSnapshot || {});
        const selectionUnchanged = selectedParcelIds.length === sourceSelectionIds.length
            && selectedParcelIds.every(id => sourceSelectionIds.includes(id));
        // No live selection: a site on bare ground (or on ground whose binding is computed at
        // publish). The declaration starts as the preview binding when the site carries one.
        const cadastreParcelIds = isFreePlacementDraft(draft)
            ? boundParcelIds(fields.binding)
            : (authoredCadastreParcelIds.length && selectionUnchanged
            ? authoredCadastreParcelIds
            : (selectedParcelIds.length ? cadastreIdsForLiveSelection(selectedParcelIds) : boundParcelIds(fields.binding)));
        const site = siteDraftApi().draftSite(draft);
        if (site) output.site = site;
        else delete output.site;
        const toleranceM = Number(fields.toleranceM);
        if (Number.isFinite(toleranceM) && toleranceM > 0) output.toleranceM = toleranceM;
        else delete output.toleranceM;
        if (isFreePlacementDraft(draft)) {
            const placementIssue = placementBindingIssue(draft);
            if (placementIssue) throw new Error(placementIssue.message);
            output.site = clone(draft.editorPayload.placement.site);
            output.binding = clone(fields.binding);
            output.freePlacement = true;
            // A moved draft is a new authored effect. Never inherit the ownership flow or cadastre
            // snapshot from its source record.
            ['ownershipFlow', 'cadastreFrame'].forEach(key => delete output[key]);
        } else if (fields.binding && typeof fields.binding === 'object') output.binding = clone(fields.binding);
        output.title = fields.name || output.title || output.name || '';
        if (fields.titleOrigin === 'generated' || fields.titleOrigin === 'user') output.titleOrigin = fields.titleOrigin;
        else delete output.titleOrigin;
        output.name = output.title;
        output.proposalName = output.title;
        output.description = fields.description || '';
        output.cadastreParcelIds = cadastreParcelIds.slice();
        output.acquisitionMode = fields.acquisitionMode || output.acquisitionMode || null;
        output.boundaryAdjustment = fields.boundaryAdjustment || output.boundaryAdjustment || null;
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

    // `facetKeys` limits the compared fields to those the draft's editor offers (a parcel layout has
    // only its name and description besides its geometry).
    function summarizeCommonChanges(source, draft, { facetKeys = null } = {}) {
        const before = sourceFields(source || {});
        const after = draft.fields || {};
        const allFacets = [
            ['name', 'Name'],
            ['description', 'Description'],
            ['ownership', 'Ownership'],
            ['recipientScope', 'Recipient'],
            ['recipientAddress', 'Recipient address'],
            ['acquisitionMode', 'Acquisition']
        ];
        const facets = Array.isArray(facetKeys) ? allFacets.filter(([key]) => facetKeys.includes(key)) : allFacets;
        const changedFacets = facets.filter(([key]) => !same(before[key], after[key])).map(([key, label]) => ({
            key,
            label,
            before: clone(before[key]),
            after: clone(after[key])
        }));
        const beforeParcels = new Set(before.selectedParcelIds || []);
        const afterParcels = new Set(after.selectedParcelIds || []);
        return {
            sourceLocalProposalId: draft.sourceLocalProposalId || sourceId(source),
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
            // Domain membership comes from the committed fabric; the presenter is the sole source
            // of its Leaflet projection. Missing services are a hard "not selectable yet", never
            // permission to consult a stale layer registry.
            const fabric = global.LiveParcelFabric;
            const presenter = global.ParcelPresenter;
            if (fabric && typeof fabric.get === 'function'
                && presenter && typeof presenter.getLayer === 'function') {
                const key = String(id || '');
                if (!key || !fabric.get(key)) return null;
                return presenter.getLayer(key) || null;
            }
        } catch (_) { }
        return null;
    }

    function liveParcelFeature(id, layer = null) {
        const fabric = global.LiveParcelFabric;
        void layer;
        if (fabric && typeof fabric.get === 'function') return fabric.get(String(id || ''));
        return null;
    }

    function cadastreIdsForLiveSelection(values) {
        const fabric = global.LiveParcelFabric;
        if (!fabric || typeof fabric.cadastreIdsForParcelIds !== 'function') {
            const error = new Error('Live parcel fabric is required to resolve selected cadastral ground.');
            error.code = 'live-parcel-fabric-unavailable';
            throw error;
        }
        return fabric.cadastreIdsForParcelIds(values);
    }

    // Polygon-clip failures are typed and counted in one place (parcel-arrangement.js clipHealth).
    function clipFailureApi() {
        const api = (global && global.__parcelArrangement)
            || (typeof require === 'function' ? require('./proposals/parcel-arrangement.js') : null);
        if (!api || typeof api.clipFailure !== 'function') throw new Error('parcel-arrangement.js (clip failures) is not loaded');
        return api;
    }

    function featureOverlapsFootprint(domainFeature, footprint) {
        if (!footprint) return true;
        // Building drafts preview an array of authored features. Passing that array to Turf as
        // one polygon reports zero overlap and makes every consumed cadastral anchor unavailable.
        if (Array.isArray(footprint)) {
            return footprint.some(part => featureOverlapsFootprint(domainFeature, part));
        }
        const feature = domainFeature || null;
        if (!feature?.geometry) return false;
        try {
            const order = global.__planOrder;
            if (order && typeof order.intersectionArea === 'function') {
                return order.intersectionArea(feature, footprint) > 0.25;
            }
            if (turfRef && typeof turfRef.intersect === 'function' && typeof turfRef.area === 'function') {
                const hit = turfRef.intersect(feature, footprint);
                return !!hit && turfRef.area(hit) > 0.25;
            }
        } catch (error) {
            // "Does not overlap" would silently drop a parcel from the draft's selection.
            throw clipFailureApi().clipFailure('intersect', error, {
                site: 'proposal-editor-adapters.featureOverlapsFootprint',
                parcelId: feature.properties && (feature.properties.parcelId || feature.properties.id)
            }, [feature, footprint]);
        }
        return true;
    }

    async function prepareParcelSelection(parcelIds, footprint = null) {
        const ids = [...new Set((parcelIds || []).map(String).filter(Boolean))];
        if (!ids.length) {
            return { ids: [], layers: [], substituted: false, complete: true, unresolvedIds: [] };
        }
        // A site's synthetic design parcels (the site as a superparcel, or plots cut from it) have
        // no live layer; they resolve through the site tool while it holds them.
        if (ids.every(isSitePlotId)) {
            const resolve = global.resolveDesignParcelFeature;
            const unresolvedIds = ids.filter(id => typeof resolve !== 'function' || !resolve(id));
            return unresolvedIds.length
                ? { ids: [], layers: [], substituted: false, complete: false, unresolvedIds }
                : { ids, layers: [], substituted: false, complete: true, unresolvedIds: [], synthetic: true };
        }
        // With no footprint the ids are exact live selection ids. With a footprint they are the
        // record's explicit cadastral anchors, which the repository may need to provision before
        // the fabric can project the current pieces occupying that authored area.
        if (footprint) try {
            const ground = global.CadastralParcelRepository;
            if (!ground || typeof ground.ensureIds !== 'function') {
                throw new Error('Cadastral ground service is unavailable.');
            }
            await ground.ensureIds(ids);
        } catch (error) {
            console.warn('[ProposalEditorAdapters] Could not hydrate all draft parcels', error);
        }
        // A fresh selection names exact LIVE parcels. Never turn one stale id into every current
        // remnant of its cadastral root: a road may have separated those remnants by hundreds of
        // metres, and silently selecting all of them authors an impossible multi-place parcel.
        //
        // Existing authored records are different. They deliberately persist flat cadastral
        // anchors plus an immutable footprint; when reopening one, that footprint may rebase the
        // anchor onto only the live pieces that still occupy the authored area. The footprint is
        // therefore the authority to substitute descendants — without it, there is no guess.
        const resolved = [];
        const resolvedIds = new Set();
        const unresolvedIds = [];
        let substituted = false;
        const addResolved = (id, layer) => {
            const key = String(id || '');
            if (!key || !layer || resolvedIds.has(key)) return;
            resolvedIds.add(key);
            resolved.push({ id: key, layer });
        };
        ids.forEach(id => {
            const direct = resolveParcelLayer(id);
            if (direct && featureOverlapsFootprint(liveParcelFeature(id, direct), footprint)) {
                addResolved(id, direct);
                return;
            }
            if (!footprint) {
                unresolvedIds.push(id);
                return;
            }
            let matched = false;
            const fabric = global.LiveParcelFabric;
            const presenter = global.ParcelPresenter;
            if (fabric && typeof fabric.entriesForCadastre === 'function'
                && presenter && typeof presenter.getLayer === 'function') {
                const candidates = fabric.entriesForCadastre([id], { includeCorridors: true });
                (Array.isArray(candidates) ? candidates : []).forEach(feature => {
                    const childId = typeof fabric.featureId === 'function'
                        ? fabric.featureId(feature)
                        : '';
                    if (!childId || !feature || !liveParcelFeature(childId, null)) return;
                    const layer = presenter.getLayer(childId);
                    if (!layer) return;
                    const props = feature.properties || {};
                    if (props.isCorridor === true) return;
                    if (!featureOverlapsFootprint(feature, footprint)) return;
                    matched = true;
                    addResolved(childId, layer);
                    substituted = true;
                });
            }
            if (!matched) unresolvedIds.push(id);
        });
        // Selection is atomic. Dropping one stale member and proceeding with the remainder is just
        // as dangerous as expanding it: the authored park/block would no longer match what the
        // person selected.
        if (unresolvedIds.length || !resolved.length) {
            return {
                ids: [],
                layers: [],
                substituted: false,
                complete: false,
                unresolvedIds
            };
        }
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
        return {
            ids: resolved.map(entry => entry.id),
            layers: resolved.map(entry => entry.layer),
            substituted,
            complete: true,
            unresolvedIds: []
        };
    }

    // Exit a multi-parcel selection that an editor flow seeded (never one the user built by hand).
    function releaseEditorSeededMultiSelection() {
        const selection = global.multiParcelSelection;
        if (!selection || !selection.isActive || !selection.__seededByEditor) return;
        selection.__seededByEditor = false;
        selection.isActive = false;
        selection.clearSelection();
    }

    async function prepareProposalDraftParcelSelection(draftOrParcelIds) {
        if (Array.isArray(draftOrParcelIds)) return prepareParcelSelection(draftOrParcelIds);
        const draft = draftOrParcelIds || {};
        // A free placement is authored against its current site, never the source proposal's old
        // parcel IDs. Editors may use that site as a synthetic host, but it is not a cadastre act.
        if (isFreePlacementDraft(draft)) {
            return { ids: [], layers: [], substituted: false, complete: true, unresolvedIds: [], site: clone(draft.editorPayload.placement.site) };
        }
        const originalIds = (draft.fields?.selectedParcelIds || []).map(String);
        const authoredBuildingSite = draft.sourceLocalProposalId
            && ['buildings', 'row', 'parcelBased', 'single'].includes(draft.adapterKey || draft.goal)
            ? draft.fields?.site : null;
        const footprint = authoredBuildingSite || draft.editorPayload?.structureProposal?.geometry
            || draft.editorPayload?.definition?.polygon
            || draft.editorPayload?.plan?.pool
            || draft.editorPayload?.geometry
            || draft.previewGeometry
            || null;
        return { ...(await prepareParcelSelection(originalIds, footprint)), usesSourceChildren: false, originalIds };
    }

    function proposalTypeLabel(goal) {
        const labels = {
            'road-track': 'Road / Track', buildings: 'Block', row: 'Row houses', parcelBased: 'Detached houses',
            single: 'Freeform building', 'parcel-layout': 'Parcel layout', park: 'Park', square: 'Square', lake: 'Lake',
            station: 'Transit station',
            'urban-rule': 'Urban rule', 'ownership-transfer': 'Ownership transfer', 'as-is': 'Proposal'
        };
        return labels[goal] || String(goal || 'Proposal').replace(/-/g, ' ');
    }

    function buildGenericAdapter(key, options = {}) {
        return {
            key,
            label: options.label || proposalTypeLabel(key),
            sections: options.sections || ['parcels', 'details'],
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
                if (key === 'as-is' && !draft.sourceLocalProposalId
                    && (!draft.fields?.ownership || draft.fields.ownership === 'no-change')) {
                    errors.push(issue('missing-goal', 'Choose a proposal type or an ownership change.', 'goal'));
                }
                return { valid: errors.length === 0, errors, warnings };
            },
            renderPreview(draft, viewMode) {
                return { kind: 'parcel-highlight', viewMode: viewMode || '2d', parcelIds: clone(draft.fields?.selectedParcelIds || []), geometry: clone(draft.editorPayload?.geometry || null) };
            },
            openDesignEditor() { return false; },
            serializeProposal(draft) {
                const output = commonProposalFromDraft(draft);
                if (draft.editorPayload?.geometry) output.geometry = clone(draft.editorPayload.geometry);
                if (draft.editorPayload?.structureProposal) output.structureProposal = clone(draft.editorPayload.structureProposal);
                return finalizeAuthoredProposal(output);
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
            sections: ['design', 'parcels', 'details']
        });
        adapter.draftFromProposal = function draftStructureFromProposal(proposal) {
            const geometry = structureGeometry(proposal);
            const structureProposal = clone(proposal?.structureProposal || {
                kind: key,
                applied: false,
                geometry
            });
            const placement = restoredFreePlacement(proposal, key);
            structureProposal.kind = key;
            structureProposal.geometry = clone(geometry);
            return {
                adapterKey: key,
                proposalType: proposal.primaryType || proposalTypeLabel(key),
                fields: sourceFields(proposal),
                editorPayload: {
                    geometry: clone(geometry),
                    structureProposal,
                    facets: clone(proposal.facets || proposal.proposalFacets || null),
                    ...(placement ? { placement } : {})
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
                parcelIds: clone(draft?.fields?.selectedParcelIds || []),
                geometry: clone(structureProposal.geometry || draft?.editorPayload?.geometry || null),
                decorations: clone(structureProposal.decorationDesign || structureProposal.decorations || null)
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
            delete structureProposal.selectedParcelIds;
            output.structureProposal = structureProposal;
            output.geometry = clone(draft?.editorPayload?.geometry || structureProposal.geometry);
            return finalizeAuthoredProposal(output);
        };
        return adapter;
    }

    function buildStationAdapter() {
        const adapter = buildGenericAdapter('station', {
            label: 'Transit station',
            sections: ['design', 'parcels', 'details'],
            hasDesign: true
        });
        adapter.draftFromProposal = function draftStationFromProposal(proposal) {
            const structureProposal = clone(proposal?.structureProposal || {});
            structureProposal.kind = 'station';
            if (structureProposal.stationType === 'elevated' && !Number.isFinite(Number(structureProposal.platformHeightM))) {
                structureProposal.platformHeightM = Number(global.TransitStationModels?.specFor?.('elevated')?.defaultPlatformHeightM) || 10;
            }
            const geometry = clone(structureProposal.geometry || proposal?.geometry?.stationGraphics || proposal?.geometry || null);
            const placement = restoredFreePlacement(proposal, 'station');
            structureProposal.geometry = geometry;
            return {
                adapterKey: 'station',
                proposalType: proposal.primaryType || proposalTypeLabel('station'),
                fields: sourceFields(proposal),
                editorPayload: {
                    geometry: clone(geometry),
                    structureProposal,
                    facets: clone(proposal.facets || proposal.proposalFacets || null),
                    ...(placement ? { placement } : {})
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
                parcelIds: clone(draft?.fields?.selectedParcelIds || []),
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
            delete station.selectedParcelIds;
            output.goal = 'station';
            output.primaryType = proposalTypeLabel('station');
            output.type = 'structure';
            output.structureProposal = station;
            output.geometry = { stationGraphics: clone(station.geometry) };
            return finalizeAuthoredProposal(output);
        };
        return adapter;
    }

    const corridorAdapter = {
        key: 'road-track',
        label: 'Road / Track',
        sections: ['design', 'parcels', 'details'],
        hasDesign: true,
        canEdit(proposal) {
            const definition = corridorDefinition(proposal);
            const segments = corridorSegments(definition);
            if (!definition || !segments.length || segments.some(segment => !Array.isArray(segment) || segment.length < 2 || segment.some(point => !validLngLatPoint(point)))) {
                return { editable: false, reason: 'This corridor does not contain a valid centerline.' };
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
                proposalId: draft.sourceLocalProposalId,
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
            output.roadProposal = {
                ...(clone(output.roadProposal || {})),
                definition: clone(definition),
                applied: false,
                isCorridor: true
            };
            return finalizeAuthoredProposal(output);
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

    function buildingTypologyForProposal(proposal, fallback) {
        const raw = proposal?.typologyType || proposal?.buildingProposal?.typologyType
            || proposal?.buildingProposal?.parameters?.typology || fallback;
        const typology = normalizeGoal(raw);
        return ['single', 'row', 'parcelBased', 'block'].includes(typology)
            ? typology
            : (fallback === 'buildings' ? 'block' : fallback);
    }

    function buildBuildingAdapter(key) {
        return {
            key,
            label: proposalTypeLabel(key),
            sections: ['design', 'parcels', 'details'],
            hasDesign: true,
            canEdit(proposal) {
                const context = proposalBuildingContext(proposal);
                const features = context.buildings?.length ? context.buildings : (context.buildingFeature ? [context.buildingFeature] : []);
                if (!features.length || features.some(feature => !featureGeometryValid(feature))) {
                    return { editable: false, reason: 'This building proposal does not contain valid footprint geometry.' };
                }
                return true;
            },
            draftFromProposal(proposal) {
                const resolvedKey = buildingGoalForProposal(proposal, key);
                const designTypology = buildingTypologyForProposal(proposal, key);
                const context = proposalBuildingContext(proposal);
                const placement = restoredFreePlacement(proposal, resolvedKey);
                return {
                    adapterKey: resolvedKey,
                    proposalType: proposal.primaryType || proposalTypeLabel(resolvedKey),
                    fields: sourceFields(proposal),
                    editorPayload: { typology: designTypology, context, ...(placement ? { placement } : {}) },
                    previewGeometry: clone(context.buildings?.length ? context.buildings : [context.buildingFeature].filter(Boolean))
                };
            },
            validate(draft) {
                const { errors, warnings } = commonValidation(draft);
                const context = draft.editorPayload?.context || {};
                const features = context.buildings?.length ? context.buildings : (context.buildingFeature ? [context.buildingFeature] : []);
                if (!features.length) errors.push(issue('missing-building', 'Create at least one building footprint.', 'editorPayload.context.buildings'));
                if ((draft.editorPayload?.typology || key) === 'single' && features.length > 1) {
                    errors.push(issue('freeform-building-count', 'Each Freeform proposal contains one building. Use Done in the geometry editor to save separate buildings.', 'editorPayload.context.buildings'));
                }
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
                const typology = draft.editorPayload?.typology || key;
                // Only a Freeform building moves freely; the rules stay on their parcels.
                const relocated = typology === 'single' && isFreePlacementDraft(draft);
                const placementSite = relocated ? clone(draft.editorPayload.placement.site) : null;
                if (relocated) {
                    context.placement = { free: true, site: clone(placementSite) };
                    context.parcelIds = [];
                    context.ineligibleParcels = [];
                }
                const savedBuildingEdit = Boolean(draft.sourceLocalProposalId);
                const authoredSite = draft.fields?.site || null;
                if (savedBuildingEdit && !siteDraftApi().isPolygonal(authoredSite)) {
                    throw new Error(global.i18n?.t?.('onMapEditor.missingSite') || 'This saved building has no valid authored site boundary, so its geometry cannot be edited safely.');
                }
                const selection = relocated
                    ? { ids: [], layers: [], complete: true, unresolvedIds: [] }
                    : await prepareProposalDraftParcelSelection(draft);
                if (!selection.ids.length && !siteDraftApi().isPolygonal(placementSite || authoredSite)) {
                    throw new Error('The source parcels are not available in this city view.');
                }
                context.parcelIds = selection.ids;
                global.pendingBuildingProposalContext = context;
                if (typeof global.setPendingBuildingProposalContext === 'function') global.setPendingBuildingProposalContext(context, { fromDraft: true });
                const features = context.buildings?.length ? context.buildings : [context.buildingFeature].filter(Boolean);
                if (typology === 'single' && typeof global.openSingleBuildingForParcels === 'function') {
                    const opened = await global.openSingleBuildingForParcels({
                        blockName: context.blockName,
                        parcelIds: selection.ids,
                        initialBuildings: features,
                        site: placementSite || authoredSite,
                        placement: relocated ? clone(context.placement) : null,
                        initialGroundTreatment: context.groundSurface?.treatment || null, initialDecorationDesign: context.groundSurface?.decorationDesign || null,
                        initialLandTake: clone(context.landTake || null),
                        initialGroundBoundary: clone(context.groundBoundary || null)
                    });
                    return opened !== false;
                }
                if (typology === 'row' && typeof global.openRowHouseForParcels === 'function') {
                    const opened = await global.openRowHouseForParcels({
                        blockName: context.blockName,
                        parcelIds: selection.ids,
                        initialParameters: context.parameters || null,
                        initialGroundTreatment: context.groundSurface?.treatment || null, initialDecorationDesign: context.groundSurface?.decorationDesign || null,
                        site: authoredSite,
                        initialFeature: features[0] || null
                    });
                    return opened !== false;
                }
                if (typology === 'parcelBased' && typeof global.openParcelBasedForParcels === 'function') {
                    const opened = await global.openParcelBasedForParcels({ blockName: context.blockName, parcelIds: selection.ids, site: authoredSite, initialParameters: context.parameters || null, initialGroundTreatment: context.groundSurface?.treatment || null, initialDecorationDesign: context.groundSurface?.decorationDesign || null });
                    return opened !== false;
                }
                if (typeof global.openUrbanRuleForParcels === 'function') {
                    const seed = { ...(typeof global.buildBlockifySeed === 'function'
                        ? (global.buildBlockifySeed(context) || {})
                        : (context.parameters || {})) };
                    const opened = await global.openUrbanRuleForParcels({ blockName: context.blockName, parcelIds: selection.ids, site: authoredSite, initialState: seed || null, initialGroundTreatment: context.groundSurface?.treatment || null, initialDecorationDesign: context.groundSurface?.decorationDesign || null });
                    return opened !== false;
                }
                return false;
            },
            serializeProposal(draft) {
                const output = commonProposalFromDraft(draft);
                const context = clone(draft.editorPayload?.context || {});
                const features = context.buildings?.length ? context.buildings : [context.buildingFeature].filter(Boolean);
                const typology = draft.editorPayload?.typology || key;
                if (typology === 'single' && features.length !== 1) {
                    throw new Error('Each Freeform proposal must contain exactly one building.');
                }
                if (isFreePlacementDraft(draft)) {
                    const site = draft.editorPayload.placement.site;
                    if (!features.length || features.some(feature => !geometryWithinSite(feature, site))) {
                        throw new Error(placementMessage('buildingOutsideSite', 'The moved building geometry must fit entirely inside its new site.'));
                    }
                    context.ineligibleParcels = [];
                    if (context.groundSurface?.polygon && !geometryWithinSite(context.groundSurface.polygon, site)) {
                        throw new Error(placementMessage('surroundingsOutsideSite', 'The moved surroundings must fit entirely inside the new site. Move the whole proposal or adjust its ground boundary before saving.'));
                    }
                }
                output.goal = typology === 'single' ? 'single' : 'buildings';
                output.primaryType = 'Urban Rule';
                output.typologyType = typology;
                output.geometry = { ...(output.geometry || {}), buildings: clone(features) };
                const blockMassing = typology === 'block' && featureGeometryValid(context.blockMassing)
                        ? clone(context.blockMassing)
                        : null;
                if (blockMassing) output.geometry.blockMassing = blockMassing;
                else delete output.geometry.blockMassing;
                // Every building typology owns its authored surroundings within this same design.
                const groundSurface = clone(context.groundSurface || null);
                if (groundSurface) output.geometry.groundSurface = groundSurface;
                else delete output.geometry.groundSurface;
                const groundBoundary = typology === 'single' ? clone(context.groundBoundary || null) : null;
                if (groundBoundary) output.geometry.groundBoundary = groundBoundary;
                else delete output.geometry.groundBoundary;
                const landTake = typology === 'single' ? clone(context.landTake || null) : null;
                if (landTake) {
                    if (!geometryWithinSite(landTake, output.site) || !features.every(building => geometryWithinSite(building, landTake))) {
                        throw new Error(global.i18n?.t?.('landTake.invalid') || 'The reviewed land take must contain the building and fit within the site.');
                    }
                    output.geometry.landTake = landTake;
                } else delete output.geometry.landTake;
                output.buildingProposal = {
                    ...(clone(output.buildingProposal || {})),
                    applied: false,
                    typologyType: typology,

                    parameters: clone(context.parameters || {}),
                    // Plots the rule left out, with the building each would carry. Not buildings and
                    // never applied — the 3D view draws them see-through so a gap in an applied block
                    // says "this plot cannot take one as it stands" instead of nothing at all.
                    ineligibleParcels: isFreePlacementDraft(draft) ? [] : clone(context.ineligibleParcels || []),
                    blockName: context.blockName || null
                };
                delete output.buildingProposal.takeWholeParcels;
                return finalizeAuthoredProposal(output);
            },
            summarizeChanges(source, draft) {
                const summary = summarizeCommonChanges(source, draft);
                const beforeContext = proposalBuildingContext(source);
                const afterContext = draft.editorPayload?.context || {};
                const beforeFeatures = beforeContext.buildings?.length ? beforeContext.buildings : [beforeContext.buildingFeature].filter(Boolean);
                const afterFeatures = afterContext.buildings?.length ? afterContext.buildings : [afterContext.buildingFeature].filter(Boolean);
                const height = feature => Number(feature?.properties?.height || feature?.properties?.heightM || feature?.properties?.floors || 0) || null;
                const groundTreatment = context => context?.groundSurface?.treatment || 'none';
                summary.groundTreatment = {
                    before: groundTreatment(beforeContext),
                    after: groundTreatment(afterContext)
                };
                summary.groundTreatment.changed = summary.groundTreatment.before !== summary.groundTreatment.after;
                summary.unchanged = summary.unchanged && !summary.groundTreatment.changed;
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

    // The record fields a parcel layout never carries: it is geometry only, and its owners belong to
    // the agreement that includes it (plan-design-agreement.md, M1 (a)).
    const PARCEL_LAYOUT_DROPPED_FIELDS = Object.freeze([
        'acquisitionMode', 'boundaryAdjustment', 'facets', 'proposalFacets', 'recipientScope', 'recipientAddress'
    ]);

    // A layout's draft fields: its name, description and ground, never owners.
    function parcelLayoutFields(proposal) {
        const fields = sourceFields(proposal);
        return Object.fromEntries(['name', 'titleOrigin', 'description', 'selectedParcelIds', 'cadastreParcelIds', 'binding', 'site', 'toleranceM']
            .filter(key => key in fields).map(key => [key, fields[key]]));
    }

    function layoutPlotsArea(plots) {
        return (Array.isArray(plots) ? plots : []).reduce((sum, plot) => sum + (geometryArea(plot?.geometry) || 0), 0);
    }

    const parcelLayoutAdapter = {
        key: 'parcel-layout',
        get label() { return translate('proposalDrafts.design.parcelLayout', 'Parcel layout'); },
        sections: ['design', 'parcels', 'details'],
        hasDesign: true,
        canEdit(proposal) {
            const plots = proposal?.parcelLayout?.plots;
            if (!Array.isArray(plots) || !plots.length) {
                return { editable: false, reason: translate('proposalDrafts.errors.layoutWithoutPlots', 'This parcel layout has no plots.') };
            }
            return true;
        },
        draftFromProposal(proposal) {
            const plan = clone(proposal.parcelLayout || null);
            return {
                adapterKey: 'parcel-layout',
                proposalType: 'ParcelLayout',
                fields: parcelLayoutFields(proposal),
                editorPayload: { plan },
                previewGeometry: clone(plan?.plots || null)
            };
        },
        validate(draft) {
            const common = commonValidation(draft);
            const plan = draft.editorPayload?.plan;
            const site = plan && plan.poolSource === 'site' ? siteDraftApi().draftSite(draft) : null;
            const geometry = parcelLayoutGeometryValidation(plan, site);
            return {
                valid: common.errors.length + geometry.errors.length === 0,
                errors: [...common.errors, ...geometry.errors],
                warnings: [...common.warnings, ...geometry.warnings]
            };
        },
        renderPreview(draft, viewMode) {
            return { kind: 'parcel-layout', viewMode: viewMode || '2d', plots: clone(draft.editorPayload?.plan?.plots || []) };
        },
        async openDesignEditor(draft) {
            const plan = clone(draft.editorPayload?.plan || {});
            let sitePool = null;
            if (plan.poolSource === 'site') {
                // A subdivision (PARCEL-OPTIONAL.md phase 4): the pool is the draft's site, the bound
                // parcels' part and the open ground alike. The bound parcels are the site's binding,
                // never a live selection.
                const site = siteDraftApi().draftSite(draft);
                if (!site) throw new Error(translate('proposalDrafts.errors.subdivisionWithoutSite', 'This subdivision has no site.'));
                const bound = boundParcelIds(draft.fields?.binding);
                plan.parcelIds = bound.length ? bound
                    : [...new Set((draft.fields?.cadastreParcelIds || []).map(normalizeParcelId).filter(Boolean))];
                plan.pool = clone(site);
                // The saved open-ground area guards a reopened subdivision against a changed cadastre.
                sitePool = {
                    site: clone(site),
                    boundParcelIds: plan.parcelIds.slice(),
                    expectedOpenGroundM2: typeof plan.openGroundM2 === 'number' && Number.isFinite(plan.openGroundM2) ? plan.openGroundM2 : null
                };
            } else {
                const selection = await prepareProposalDraftParcelSelection(draft);
                // Input land belongs to the draft fields and ultimately the record's single root
                // cadastre declaration. The layout itself holds only its pool and plots.
                plan.parcelIds = (draft.fields?.selectedParcelIds || selection.ids).filter(Boolean).map(String);
                // A saved layout can be reopened without its parcels on the map: the editor fetches
                // them by id. Only a layout with nothing to reopen on genuinely needs a live selection.
                if (!selection.layers.length && !(Array.isArray(plan.plots) && plan.plots.length)) {
                    throw new Error('The source parcels are not available in this city view.');
                }
            }
            global.pendingParcelLayout = plan;
            if (typeof global.openParcelLayoutEditor !== 'function' && typeof global.ensureParcelLayoutModuleLoaded === 'function') {
                await global.ensureParcelLayoutModuleLoaded();
            }
            if (typeof global.openParcelLayoutEditor !== 'function') return false;
            return global.openParcelLayoutEditor({
                algorithm: plan.algorithm || 'equal',
                initialPlots: clone(plan.plots || []),
                pool: clone(plan.pool || null),
                ...(sitePool ? { sitePool } : {}),
                ...(Number.isFinite(plan.plotCount) ? { plotCount: plan.plotCount } : {})
            });
        },
        serializeProposal(draft) {
            const output = commonProposalFromDraft(draft);
            const plan = clone(draft.editorPayload?.plan || {});
            delete plan.parcelIds;
            PARCEL_LAYOUT_DROPPED_FIELDS.forEach(key => delete output[key]);
            output.goal = 'parcel-layout';
            output.primaryType = 'ParcelLayout';
            output.parcelLayout = plan;
            return finalizeAuthoredProposal(output);
        },
        summarizeChanges(source, draft) {
            const summary = summarizeCommonChanges(source, draft, { facetKeys: ['name', 'description'] });
            const before = source?.parcelLayout?.plots || [];
            const after = draft.editorPayload?.plan?.plots || [];
            summary.geometry = {
                changed: !same(before, after),
                plotCountBefore: before.length,
                plotCountAfter: after.length,
                beforeArea: layoutPlotsArea(before),
                afterArea: layoutPlotsArea(after)
            };
            summary.unchanged = summary.unchanged && !summary.geometry.changed;
            return summary;
        }
    };

    function createRegistry() {
        const adapters = new Map();
        const aliases = new Map();

        function register(key, adapter, options = {}) {
            const normalized = normalizeGoal(key);
            if (!normalized) throw new Error('Adapter key is required.');
            // Accessors are copied as accessors, so a label read through i18n stays live.
            const value = Object.defineProperties({}, Object.getOwnPropertyDescriptors(adapter || {}));
            if (!value.key) value.key = normalized;
            adapters.set(normalized, value);
            (options.aliases || []).forEach(alias => aliases.set(normalizeGoal(alias), normalized));
            return value;
        }

        function get(keyOrProposal) {
            const rawKey = typeof keyOrProposal === 'object' ? sourceGoal(keyOrProposal) : normalizeGoal(keyOrProposal);
            // A direct adapter key always wins; aliases only catch names no adapter owns.
            // (The generic 'building(s)' label normalizes to 'single' — an alias registered under
            // that name would shadow the Detached adapter and open the wrong design editor.)
            const key = adapters.has(rawKey) ? rawKey : (aliases.get(rawKey) || rawKey);
            return adapters.get(key) || null;
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
            const missing = goals.map(normalizeGoal).filter(key => !adapters.has(key));
            return { complete: missing.length === 0, missing };
        }

        function list() {
            return [...adapters.entries()].map(([key, adapter]) => ({ key, label: adapter.label || proposalTypeLabel(key) }));
        }

        return { register, get, getAdapter: get, canEdit, completeness, list, normalizeGoal };
    }

    const registry = createRegistry();
    registry.register('road-track', corridorAdapter, { aliases: ['road', 'track', 'road/track'] });
    registry.register('buildings', buildBuildingAdapter('buildings'), { aliases: ['residences', 'block'] });
    registry.register('row', buildBuildingAdapter('row'));
    registry.register('parcelBased', buildBuildingAdapter('parcelBased'), { aliases: ['parcel-based', 'parcelbased'] });
    registry.register('single', buildBuildingAdapter('single'), { aliases: ['single-building'] });
    registry.register('parcel-layout', parcelLayoutAdapter);
    registry.register('urban-rule', buildGenericAdapter('urban-rule'));
    registry.register('as-is', buildGenericAdapter('as-is'));
    registry.register('park', buildStructureAdapter('park'));
    registry.register('square', buildStructureAdapter('square'));
    registry.register('lake', buildStructureAdapter('lake'));
    registry.register('station', buildStationAdapter(), { aliases: ['transit-station'] });
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
        if (global.OnMapEditor?.isActive?.()) return false;
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
    global.proposalDraftPlacement = {
        freePlacementPatch,
        isFreePlacementDraft,
        markFreePlacementBound,
        placementBindingIssue
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            CREATABLE_PROPOSAL_GOALS,
            createProposalEditorAdapterRegistry: createRegistry,
            registry,
            normalizeGoal,
            corridorAdapter,
            buildBuildingAdapter,
            parcelLayoutAdapter,
            buildGenericAdapter,
            buildStructureAdapter,
            buildStationAdapter,
            summarizeCommonChanges,
            prepareParcelSelection,
            freePlacementPatch,
            isFreePlacementDraft,
            markFreePlacementBound,
            placementBindingIssue
        };
    }
})(typeof window !== 'undefined' ? window : globalThis);
