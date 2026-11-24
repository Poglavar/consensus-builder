// Resolve intent against authoritative sources, then call the browser's pure builders and hash results.
import { appTurf as turf, intentDesign as builder } from './mcp-geometry.js';
import { cidOfObject, designObject, isCid } from './agreement-objects.js';
import { createMcpComparison } from './mcp-compare.js';
import { previewArtifact } from './mcp-preview.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
import { editedDesign, valueAt } from './mcp-edit.js';
import { buildTypedDesign, validateTrackDesign } from './mcp-constructors.js';
import { trustedMetadata } from './mcp-results.js';
import { cityDrivingSide } from '../scripts/lib/frontend-city-money.mjs';
import { MAX_SOURCE_BINDING_PARCELS } from '../parcels/source-binding.js';
import { materializeWithApp } from './mcp-ground-runtime.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DesignRecord = require('../../frontend/js/design-record.js');
const PlanningSourceProposal = require('../../frontend/js/planning/source-proposal.js');
const { hasVerifiedCoverage } = require('../../frontend/js/proposals/site-binding.js');
const PlanPlots = require('../../frontend/js/planning/plan-plots.js');
const fail = (code, message, next) => Object.assign(new Error(message), { code, next });
const geometry = value => value?.type === 'Feature' ? value.geometry : value;
function union(features) {
    return features.reduce((a, b) => a ? turf.union(a, b) : b, null)?.geometry;
}
const URBAN_RULE_COMMON_FIELDS = new Set(['typology', 'kind', 'floors', 'height', 'floorHeightM', 'minPlotAreaM2', 'use', 'access', 'roof', 'balconyDepthM', 'seed']);
const URBAN_RULE_FIELDS = {
    block: new Set(['minHeightM', 'minDepthM', 'setbackM', 'depthM', 'simplifyM', 'chamferM', 'gapPositions', 'gapWidthM', 'wingPositions', 'wingLengthM']),
    row: new Set(['minHeightM', 'minDepthM', 'depthM', 'lengthM', 'chamferM', 'rotationDegrees', 'offsetEastM', 'offsetNorthM']),
    detached: new Set(['setbackM', 'minFootprintAreaM2', 'minFloors', 'frontSetbackM', 'rearSetbackM', 'setbackHeightRatio',
        'maxHeightM', 'minFrontageM', 'coverage', 'minNaturalGround', 'maxFloorAreaRatio', 'maxFootprintAreaM2'])
};
function urbanRuleIntent(args) {
    const rule = args?.rule;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw fail('urban-rule-required', 'Supply an urban rule with a supported typology.', { action: 'Set rule.typology to block, row or detached, and include floors or height.' });
    if (!['block', 'row', 'detached'].includes(rule.typology)) throw fail('unsupported-urban-rule-typology', 'Choose a block, row or detached urban rule.', { action: 'Set rule.typology to block, row or detached.' });
    const unsupported = Object.keys(rule).filter(key => !URBAN_RULE_COMMON_FIELDS.has(key) && !URBAN_RULE_FIELDS[rule.typology].has(key));
    if (unsupported.length) throw fail('unsupported-urban-rule-parameter', `Unsupported ${rule.typology} rule parameter: ${unsupported.join(', ')}.`, { action: 'Use only the rule fields supported for this typology.' });
    if (rule.floors == null && rule.height == null) throw fail('incomplete-urban-rule', 'An urban rule needs a floor count or height.', { action: 'Add rule.floors or rule.height.' });
    if (args.parcelIds?.length && !args.parcelSourceId) throw fail('parcel-source-required', 'Selected urban-rule parcels need their exact source ID.', { action: 'Pass parcelSourceId with parcelIds from the current parcel selection.' });
    const { typology, kind: ruleKind, ...parameters } = rule;
    return { ...args, ...parameters, kind: 'building', typology, ...(ruleKind == null ? {} : { ruleKind }), rule: undefined };
}

export function createMcpDraftTools({ read, appOrigin, resolveDraftReference, resolvePlan }) {
    // The server binds a draft as it binds a design drawn on the map (proposals/binding.js), so a site
    // too large for one design is refused here under the server's own codes, with how to recover.
    async function bindingOf(design, parcelSourceId) {
        try {
            return await read.request('/designs/binding', {}, { site: read.siteOfDesign(design), city: design.city, toleranceM: design.toleranceM, parcelSourceId });
        } catch (error) {
            const code = error?.upstream?.code;
            if (code === 'too-many-parcels') throw Object.assign(fail(code, `The site meets more than ${MAX_SOURCE_BINDING_PARCELS} parcels, more than one design may take.`,
                { action: 'Choose a smaller site or fewer parcels, or split the plan into several designs.' }), { field: 'site', constraints: { maximumParcels: MAX_SOURCE_BINDING_PARCELS }, status: error.status, upstream: error.upstream });
            if (code === 'parcel-source-area-limit') throw Object.assign(fail(code, 'The parcel source cannot be read for a site this large.',
                { action: 'Choose a smaller site, or split the plan into several designs.' }), { field: 'site', status: error.status, upstream: error.upstream });
            if (code === 'invalid-site') throw Object.assign(fail(code, 'The server cannot bind this site; its reason is in the upstream answer.',
                { action: 'Correct the site as the upstream reason says (a WGS84 Polygon or MultiPolygon within the vertex and extent limits), then retry.' }), { field: 'site', status: error.status, upstream: error.upstream });
            throw error;
        }
    }
    async function result(design, parcelSourceId) {
        let binding = null;
        try {
            const answer = await bindingOf(design, parcelSourceId);
            binding = answer.binding;
            parcelSourceId = parcelSourceIdOf(answer) || parcelSourceId;
        } catch (error) {
            if (!design.sourceReferences?.length) throw error;
        }
        const groundKnown = hasVerifiedCoverage(binding);
        if (!groundKnown && !design.sourceReferences?.length) throw fail('ground-unavailable', 'The site binding is unknown.', { action: 'Retry when parcel coverage is available.' });
        return { design, cid: cidOfObject(design), parcelSourceId, binding,
            ...(groundKnown ? { takes: binding.parcels.map(p => p.parcelId) } : {}),
            warnings: [ ...(design.goal === 'buildings' ? ['An intent drawing is not a planning permission; envelope applicability remains unresolved.'] : []),
                ...(!groundKnown ? ['The plan supplies the design boundary. Cadastral binding is pending.'] : []),
                ...(binding?.unsurveyedM2 > 0 ? ['The site includes ground outside the parcel register.'] : []) ],
            ...await previewArtifact({ origin: appOrigin, design, parcelSourceId }) };
    }
    async function planEnvelopes(building, members, parcelSourceId, planningSource) {
        const city = building.city, box = turf.bbox(turf.feature(building.footprint));
        const ids = new Set(), designs = [];
        for (const member of members) {
            if (member.content.city !== city) continue;
            if (member.parcelSourceId && parcelSourceId && member.parcelSourceId !== parcelSourceId) throw fail('mixed-source-ground-unavailable', 'These plan members use different parcel sources.');
            const answer = await bindingOf(member.content, member.parcelSourceId || parcelSourceId);
            if (!hasVerifiedCoverage(answer.binding)) throw fail('ground-incomplete', 'The parcel source could not establish this layout’s ground.');
            parcelSourceId ||= parcelSourceIdOf(answer);
            const parcelIds = answer.binding.parcels.map(row => row.parcelId);
            parcelIds.forEach(id => ids.add(id));
            designs.push({ cid: member.cid, content: member.content, parcelIds, binding: answer.binding });
        }
        const parcels = ids.size ? (await read.parcels({ city, parcelSourceId, parcelIds: [...ids] })).features : [];
        const { fabric, records } = await materializeWithApp({ designs, parcels });
        const byId = new Map(records.map(record => [record.proposalId, record]));
        const plots = PlanPlots.serialize(fabric, box, { getDesign: id => byId.get(id), geometry: turf });
        if (!plots.length) return null;
        const footprint = turf.feature(building.footprint), area = turf.area(footprint);
        const containing = plots.filter(plot => {
            if (['road', 'track'].includes(plot.kind)) return false;
            const shared = turf.intersect(footprint, turf.feature(plot.geometry));
            return shared && area - turf.area(shared) <= 0.05;
        });
        if (containing.length > 1) throw fail('envelope-ambiguous', 'Several plan plots cover this building.');
        const answer = await read.request('/planning/envelopes', {}, { city, source: planningSource, bbox: box, plots });
        return { items: answer.items, subject: containing[0]?.id, unavailable: answer.unavailable || [] };
    }
    async function draft(kind, args) {
        // A new artifact needs its actual authoring time. A null time would be filled by browser
        // import, changing its CID as soon as the person opened the supposedly exact preview.
        let intent = { ...args, kind, authoredAt: args.authoredAt ?? new Date().toISOString() };
        // A road keeps its traffic on the city's side, as one drawn in the app does.
        if (kind === 'road' || kind === 'track') intent.drivingSide = cityDrivingSide(args.city);
        let parcelFeatures = [];
        if (kind === 'station') {
            intent.corridors = await roadCorridors(args.corridors, args.plan);
        } else if (kind === 'road' && !intent.points && (args.parcelIds?.length || args.outline)) {
            // A road placed into a parcel (docs/road-in-parcel.md): the site is its land and its
            // streets are read from the site's shape.
            if (args.parcelIds?.length && args.outline) throw fail('site-ambiguous', 'Choose either source parcels or an outline, not both.', { action: 'Remove one of parcelIds or outline.' });
            if (args.parcelIds?.length) {
                const source = await read.parcels(args);
                parcelFeatures = source.features;
                intent.site = union(source.features);
                intent.parcelSourceId = source.parcelSourceId;
            } else intent.site = geometry(args.outline);
            intent.bounded = true;
        } else if ((kind === 'road' || kind === 'track') && !intent.points) {
            let bbox = args.bbox;
            if (!bbox && args.street) {
                const found = await read.findPlace({ query: args.street, city: args.city, limit: 1 });
                const point = found.candidates?.find(c => c.point)?.point;
                if (point) bbox = [point[0] - 0.003, point[1] - 0.003, point[0] + 0.003, point[1] + 0.003];
            }
            if (!bbox) throw fail('street-area-required', 'Supply a small WGS84 bbox to identify the street.', { tool: 'ugt_find_place', arguments: { query: args.street || args.streetId, city: args.city } });
            const found = await read.request('/streets/near', { bbox: bbox.join(',') });
            if (found.partial || found.truncated) throw fail('street-coverage-incomplete', 'Street source returned incomplete data.', { action: 'Choose a smaller bbox and retry.' });
            const ways = found.features.filter(f => f.geometry.type === 'LineString' && (args.streetId
                ? String(f.id ?? f.properties?.id ?? f.properties?.osm_id) === args.streetId
                : String(f.properties?.name || '').toLowerCase() === String(args.street).toLowerCase()));
            if (ways.length !== 1) throw fail('street-ambiguous', `Found ${ways.length} matching street stretches. Choose one streetId or supply points.`, { action: 'Choose a specific streetId from /streets/near or supply WGS84 points.' });
            intent.points = ways[0].geometry.coordinates;
        } else if (!['road', 'track'].includes(kind)) {
            if (args.planningArea && (args.parcelIds?.length || args.outline)) throw fail('site-ambiguous', 'Choose either a planning area, source parcels, or an outline.', { action: 'Remove planningArea or the other site input.' });
            if (!args.parcelIds?.length && !args.outline && !args.planningArea) throw fail('site-required', 'Choose source parcels, a planning area, or supply a WGS84 outline.',
                { tool: 'ugt_help', arguments: { topic: kind === 'building' ? 'ugt_draft_building' : `ugt_draft_${kind.replaceAll('-', '_')}` }, action: 'Supply parcelIds with parcelSourceId, or outline.' });
            if (args.planningArea) {
                const area = args.planningArea;
                if (!area || typeof area.source !== 'string' || typeof area.recordId !== 'string') throw fail('planning-area-invalid', 'planningArea needs source and recordId.');
                const answer = await read.request('/planning/record', { city: args.city, source: area.source, recordId: area.recordId, ...(area.scenario ? { scenario: area.scenario } : {}) });
                const item = (answer.items || []).find(candidate => candidate.source?.id === area.source && candidate.source?.recordId === area.recordId && candidate.areas?.length);
                if (!item) throw fail('planning-area-unavailable', 'The planning area record has no usable geometry.');
                const authored = PlanningSourceProposal.designSite(item);
                if (!authored) throw fail('planning-area-unavailable', 'The planning area record is not an exact zoning area.');
                intent.site = authored.site;
                intent.sourceReferences = authored.sourceReferences;
            } else if (args.parcelIds?.length) {
                const source = await read.parcels(args);
                parcelFeatures = source.features;
                intent.site = union(source.features);
                intent.parcelSourceId = source.parcelSourceId;
            } else intent.site = geometry(args.outline);
            // A detached rule with yards or a frontage measured from the street needs the streets
            // around its plots, read from the same source as the app's; envelopes record the basis.
            // An outline is cut into plots along the street it faces, as the site tool cuts them.
            if (kind === 'building' && args.typology === 'detached' && (!args.parcelIds?.length
                || ['frontSetbackM', 'rearSetbackM', 'setbackHeightRatio', 'minFrontageM'].some(key => args[key] != null))) {
                const [w, s, e, n] = turf.bbox(turf.feature(intent.site)), dLat = 35 / 111320, dLng = dLat / Math.cos((s + n) / 2 * Math.PI / 180);
                const found = await read.request('/streets/near', { bbox: [w - dLng, s - dLat, e + dLng, n + dLat].join(',') });
                intent.streets = Array.isArray(found?.features) ? found.features : [];
            }
            if (kind === 'building' && args.permitted) {
                if (!args.planningSource) throw fail('planning-source-required', 'Choose the planning source for the permitted envelope.', { action: 'Read ugt_parcel_context and supply planningSource.' });
                const envelopes = await read.request('/planning/envelopes', { city: args.city, source: args.planningSource, bbox: turf.bbox(turf.feature(intent.site)).join(',') });
                const items = envelopes.items.filter(item => args.planningArea
                    ? item.sourceEvidence?.planningArea?.source === args.planningArea.source && item.sourceEvidence.planningArea.recordId === args.planningArea.recordId
                    : args.parcelIds?.includes(item.source?.parcel));
                if (items.length !== 1) throw fail('envelope-ambiguous', 'Choose one parcel with a supported permitted envelope.', { action: 'Read ugt_parcel_context; choose one supported parcel and planningSource.' });
                intent.footprint = items[0].site;
                intent.height = items[0].metrics.heightM;
            }
        }
        const design = ['building', 'station', 'track'].includes(kind)
            ? buildTypedDesign(intent, { parcels: parcelFeatures }) : builder.build(intent, { turf });
        const checked = designObject({ ...design, ...(intent.sourceReferences ? { sourceReferences: intent.sourceReferences } : {}), createdAt: design.authoredAt });
        // Roads join the roads of the plan the caller places them in (agent-working-plan.md), not here.
        const drafted = await result(checked.content, intent.parcelSourceId || args.parcelSourceId);
        // A freeform outline is the site, as on the map: without footprint or coverage the building
        // starts as the editor's 20 x 20 m default inside it, which a caller cannot tell from the result.
        if (kind === 'building' && (args.typology ?? 'freeform') === 'freeform' && !intent.footprint && args.coverage == null)
            drafted.warnings.push('The building is the default 20 x 20 m footprint inside the site; pass footprint (the building outline) or coverage to shape it.');
        return drafted;
    }
    // A station's named corridor designs, resolved as immutable references.
    async function roadCorridors(inputs = [], plan) {
        return Promise.all(inputs.map(async input => {
            const resolved = await resolveDesignSource(input, plan);
            if (!resolved.content.roadProposal) throw fail('corridor-road-required', 'Name only road or track designs in corridors.', { action: 'Remove designs that are not roads or tracks from corridors.' });
            return { cid: cidOfObject(resolved.content), content: resolved.content, parcelSourceId: resolved.parcelSourceId };
        }));
    }
    async function resolveDesignSource(value, plan) {
        if (typeof value === 'string' && !isCid(value)) {
            try { const url = new URL(value); if (url.origin === new URL(appOrigin).origin && /^\/designs\/baf(?:krei|ybei)[a-z2-7]{52}\/?$/.test(url.pathname)) value = url.pathname.split('/')[2]; } catch { /* Private reference errors are reported below. */ }
        }
        if (isCid(value) && plan != null) {
            const resolved = await resolvePlan(plan);
            const member = resolved.designs.find(row => row.cid === value);
            if (member) return { content: structuredClone(member.content), parcelSourceId: member.parcelSourceId };
        }
        const reference = typeof value === 'string' && !isCid(value) ? value : value?.draftRef;
        if (reference) {
            if (!resolveDraftReference) throw fail('draft-reference-unavailable', 'Use a canonical draft object here; hosted draftRef references belong to their HTTP server.');
            const artifact = await resolveDraftReference(reference);
            if (!artifact.design) throw fail('design-reference-required', 'This operation needs a design draftRef, not an agreement.');
            if (value?.cid && value.cid !== cidOfObject(artifact.design)) throw fail('cid-mismatch', 'The draftRef does not identify the supplied CID.');
            value = { content: artifact.design, parcelSourceId: artifact.parcelSourceId };
        }
        const row = isCid(value) ? await read.getDesign({ designCid: value }) : value;
        const content = row?.untrusted?.design || row?.untrusted?.content || row?.design || row?.content || row;
        if (content?.schema === 'design/v1') {
            const checked = DesignRecord.validate(content);
            if (!checked.valid) throw fail('invalid-design', `Invalid published design: ${checked.errors.map(error => error.message).join('; ')}`, { action: 'Use a valid published design.' });
            const cid = cidOfObject(content);
            if (row?.cid && row.cid !== cid) throw fail('cid-mismatch', 'The supplied canonical design differs from its claimed CID.');
            return { content, parcelSourceId: row?.parcelSourceId };
        }
        const rebuilt = designObject({ ...content, createdAt: content?.authoredAt });
        if (cidOfObject(content) !== rebuilt.cid) throw fail('invalid-design', 'Draft is not a canonical design/v1 object.', { action: 'Use a design returned by a draft tool.' });
        if (row?.cid && row.cid !== rebuilt.cid) throw fail('cid-mismatch', 'The supplied canonical design differs from its claimed CID.');
        return { content, parcelSourceId: row?.parcelSourceId };
    }
    const resolveDesign = async (value, plan) => (await resolveDesignSource(value, plan)).content;
    return {
        resolveDesign, resolveDesignSource, roadCorridors, designResult: result,
        draftRoad: args => draft('road', args), draftTrack: args => draft('track', args), draftStation: args => draft('station', args), draftBuilding: args => draft('building', args),
        draftSpace: args => draft('space', args), draftParcelLayout: args => draft('parcel-layout', args),
        draftUrbanRule: args => draft('building', urbanRuleIntent(args)),
        async inspectDesign({ design, paths = [''], plan }) {
            const resolved = await resolveDesignSource(design, plan), content = resolved.content;
            return { cid: cidOfObject(content), parcelSourceId: resolved.parcelSourceId,
                values: paths.map(path => ({ path, untrustedValue: valueAt(content, path) })),
                editableRoots: Object.keys(content).filter(key => !['schema', 'origin', 'authoredAt'].includes(key)).map(key => `/${key}`),
                next: trustedMetadata({ tool: 'ugt_edit_design', action: 'Use this CID as expectedCid. Patch the authored JSON with ordered JSON Pointer edits. Canonical OSM changes rebuild the road footprint; coupled building geometry must remain consistent.' }) };
        },
        async editDesign({ design, expectedCid, edits, parcelSourceId, plan }) {
            const resolved = await resolveDesignSource(design, plan);
            if (cidOfObject(resolved.content) !== expectedCid) throw Object.assign(new Error('Inspect the intended design revision before editing.'), {
                code: 'design-revision-mismatch', currentCid: cidOfObject(resolved.content), expectedCid,
                next: { tool: 'ugt_inspect_design', arguments: { design }, action: 'Inspect this reference and use its current CID as expectedCid.' } });
            return result(editedDesign(resolved.content, expectedCid, edits), parcelSourceId || resolved.parcelSourceId);
        },
        async modifyDesign({ design, changes, parcelSourceId, plan }, { groundDesigns = [] } = {}) {
            const resolved = await resolveDesignSource(design, plan), original = resolved.content;
            parcelSourceId ||= resolved.parcelSourceId;
            let modified = original;
            for (const change of changes) {
                if (change.type === 'fit_to_permitted') {
                    if (!modified.buildingProposal) throw fail('invalid-change', 'Only a building can fit a permitted envelope.', { action: 'Choose a building design.' });
                    if (!change.planningSource) throw fail('planning-source-required', 'Choose the planning source for this fit.');
                    const buildings = modified.geometry.buildings;
                    const index = change.buildingIndex ?? (buildings.length === 1 ? 0 : null);
                    const footprint = buildings[index]?.geometry;
                    if (!footprint) throw fail('building-selection-required', 'Select the building to fit in this design.');
                    const city = modified.city, box = turf.bbox(turf.feature(footprint));
                    const live = groundDesigns.length ? await planEnvelopes({ city, footprint }, groundDesigns, parcelSourceId, change.planningSource) : null;
                    const areaRef = !live?.subject && modified.sourceReferences?.find(ref => ref.providerId === change.planningSource && ref.recordId);
                    const answer = live || await read.request('/planning/envelopes', { city, source: change.planningSource, bbox: box.join(',') });
                    const areaItems = areaRef ? answer.items.filter(item => item.sourceEvidence?.planningArea?.recordId === areaRef.recordId &&
                        turf.booleanWithin(turf.feature(footprint), turf.feature(item.derivation.parcel))) : [];
                    const binding = live?.subject || areaItems.length ? null : await bindingOf({ ...modified, site: footprint }, parcelSourceId);
                    const ids = live?.subject ? [live.subject] : binding?.binding?.parcels?.map(p => p.parcelId) || [];
                    if (!areaItems.length && ids.length !== 1) throw fail('envelope-ambiguous', 'The building needs to fit within one parcel or plan plot.');
                    const subjects = areaItems.length ? areaItems : answer.items.filter(item => item.source?.parcel === ids[0]);
                    const matches = subjects.filter(item => item.site && item.metrics?.heightM > 0);
                    if (matches.length !== 1) {
                        const reason = answer.unavailable?.find(entry => entry.parcelId === ids[0])?.reason;
                        throw fail(reason || 'envelope-ambiguous', 'There is no single supported building envelope on the selected parcel.');
                    }
                    const envelope = matches[0];
                    const fitted = buildTypedDesign({ kind: 'building', city, site: envelope.site, footprint: envelope.site, height: envelope.metrics.heightM,
                        title: modified.title, description: modified.description, author: modified.author, authoredAt: modified.authoredAt });
                    if (buildings.length === 1) modified = { ...modified, ...fitted };
                    else {
                        const updated = buildings.map((feature, i) => i === index ? fitted.geometry.buildings[0] : feature);
                        const site = union(updated);
                        modified = editedDesign(modified, cidOfObject(modified), [
                            { op: 'replace', path: '/geometry/buildings', value: updated },
                            { op: 'replace', path: '/site', value: site },
                            { op: 'replace', path: '/geometry/landTake', value: site }
                        ]);
                    }
                    modified.geometry.buildings[index].properties.permittedEvidence = { source: change.planningSource, envelopeId: envelope.id,
                        parcelReference: envelope.sourceEvidence?.parcelReference || null,
                        ...(envelope.sourceEvidence?.planningArea ? { planningArea: envelope.sourceEvidence.planningArea } : {}) };

                } else modified = builder.modify(modified, [change], { turf });
            }
            modified.origin = { cid: cidOfObject(original) };
            modified.authoredAt = new Date().toISOString();
            validateTrackDesign(modified, original);
            return result(modified, parcelSourceId);
        },
        compare: createMcpComparison({ read, resolveDesign, appOrigin, resolveDraftReference })
    };
}
