// Resolve intent against authoritative sources, then call the browser's pure builders and hash results.
import { appTurf as turf, intentDesign as builder } from './mcp-geometry.js';
import { cidOfObject, designObject, isCid } from './agreement-objects.js';
import { createMcpComparison } from './mcp-compare.js';
import { previewArtifact } from './mcp-preview.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
import { editedDesign, valueAt } from './mcp-edit.js';
import { buildTypedDesign, validateTrackDesign } from './mcp-constructors.js';
import { trustedMetadata } from './mcp-results.js';
import { joinEditedRoad, joinNewRoads } from './mcp-road-network.js';
import { cityDrivingSide } from '../scripts/lib/frontend-city-money.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DesignRecord = require('../../frontend/js/design-record.js');
const fail = (code, message, next) => Object.assign(new Error(message), { code, next });
const geometry = value => value?.type === 'Feature' ? value.geometry : value;
function union(features) {
    return features.reduce((a, b) => a ? turf.union(a, b) : b, null)?.geometry;
}

export function createMcpDraftTools({ read, appOrigin, resolveDraftReference }) {
    async function result(design, parcelSourceId) {
        const binding = await read.request('/designs/binding', {}, { site: read.siteOfDesign(design), city: design.city, toleranceM: design.toleranceM, parcelSourceId });
        parcelSourceId = parcelSourceIdOf(binding) || parcelSourceId;
        if (binding.binding?.coverage === 'unknown' || binding.binding?.unknownM2 > 0) throw fail('ground-unavailable', 'The site binding is unknown.', { action: 'Retry when parcel coverage is available.' });
        return { design, cid: cidOfObject(design), parcelSourceId, takes: (binding.binding?.parcels || []).map(p => p.parcelId), binding: binding.binding,
            warnings: [ ...(design.goal === 'buildings' ? ['An intent drawing is not a planning permission; envelope applicability remains unresolved.'] : []),
                ...(binding.binding?.unsurveyedM2 > 0 ? ['The site includes ground outside the parcel register.'] : []) ],
            ...await previewArtifact({ origin: appOrigin, design, parcelSourceId }) };
    }
    async function draft(kind, args) {
        // A new artifact needs its actual authoring time. A null time would be filled by browser
        // import, changing its CID as soon as the person opened the supposedly exact preview.
        let intent = { ...args, kind, authoredAt: args.authoredAt ?? new Date().toISOString() };
        // A road keeps its traffic on the city's side, as one drawn in the app does.
        if (kind === 'road' || kind === 'track') intent.drivingSide = cityDrivingSide(args.city);
        let parcelFeatures = [];
        if (kind === 'station') {
            intent.corridors = await roadCorridors(args.corridors);
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
            if (!args.parcelIds?.length && !args.outline) throw fail('site-required', 'Choose source parcels or supply a WGS84 outline.',
                { tool: 'ugt_help', arguments: { topic: kind === 'building' ? 'ugt_draft_building' : `ugt_draft_${kind.replaceAll('-', '_')}` }, action: 'Supply parcelIds with parcelSourceId, or outline.' });
            if (args.parcelIds?.length && args.outline) throw fail('site-ambiguous', 'Choose either source parcels or an outline, not both.', { action: 'Remove one of parcelIds or outline.' });
            if (args.parcelIds?.length) {
                const source = await read.parcels(args);
                parcelFeatures = source.features;
                intent.site = union(source.features);
                intent.parcelSourceId = source.parcelSourceId;
            } else intent.site = geometry(args.outline);
            if (kind === 'building' && args.permitted) {
                if (!args.planningSource) throw fail('planning-source-required', 'Choose the planning source for the permitted envelope.', { action: 'Read ugt_parcel_context and supply planningSource.' });
                const envelopes = await read.request('/planning/envelopes', { city: args.city, source: args.planningSource, bbox: turf.bbox(turf.feature(intent.site)).join(',') });
                const items = envelopes.items.filter(item => args.parcelIds?.includes(item.source?.parcel));
                if (items.length !== 1) throw fail('envelope-ambiguous', 'Choose one parcel with a supported permitted envelope.', { action: 'Read ugt_parcel_context; choose one supported parcel and planningSource.' });
                intent.footprint = items[0].site;
                intent.height = items[0].metrics.heightM;
            }
        }
        const design = ['building', 'station', 'track'].includes(kind)
            ? buildTypedDesign(intent, { parcels: parcelFeatures }) : builder.build(intent, { turf });
        const checked = designObject({ ...design, createdAt: design.authoredAt });
        if (kind !== 'road' && kind !== 'track') return result(checked.content, intent.parcelSourceId || args.parcelSourceId);
        // A drafted road is finished as the map editor finishes a drawn one: joined to the named corridors.
        const joined = joinNewRoads([checked.content], await roadCorridors(args.corridors), checked.content.authoredAt);
        return junctionResult(await result(joined.designs[0], intent.parcelSourceId || args.parcelSourceId), joined);
    }
    // Named road/track designs, resolved as immutable references; they stand in for the editor's applied corridors.
    async function roadCorridors(inputs = []) {
        return Promise.all(inputs.map(async input => {
            const resolved = await resolveDesignSource(input);
            if (!resolved.content.roadProposal) throw fail('corridor-road-required', 'Name only road or track designs in corridors.', { action: 'Remove designs that are not roads or tracks from corridors.' });
            return { cid: cidOfObject(resolved.content), content: resolved.content, parcelSourceId: resolved.parcelSourceId };
        }));
    }
    // Neighbours whose junctions changed come back as private revisions the agent can put in its plan.
    async function junctionResult(primary, joined) {
        return { ...primary, changes: joined.changes, revisedCorridors: await Promise.all(joined.revisions.map(row => result(row.design, row.parcelSourceId))) };
    }
    // With corridors, an edited road re-derives its junctions against exactly those roads, as the editor does on an edit.
    async function joinedEdit(before, edited, corridors, parcelSourceId) {
        if (corridors === undefined) return result(edited, parcelSourceId);
        if (!edited.roadProposal) throw fail('corridors-road-only', 'Only a road or track edit joins corridors.', { action: 'Remove corridors from this edit.' });
        const joined = joinEditedRoad(before, edited, await roadCorridors(corridors), edited.authoredAt);
        return junctionResult(await result(joined.design, parcelSourceId), joined);
    }
    async function resolveDesignSource(value) {
        if (typeof value === 'string' && !isCid(value)) {
            try { const url = new URL(value); if (url.origin === new URL(appOrigin).origin && /^\/designs\/baf(?:krei|ybei)[a-z2-7]{52}\/?$/.test(url.pathname)) value = url.pathname.split('/')[2]; } catch { /* Private reference errors are reported below. */ }
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
    const resolveDesign = async value => (await resolveDesignSource(value)).content;
    return {
        resolveDesign, resolveDesignSource, roadCorridors, junctionResult,
        draftRoad: args => draft('road', args), draftTrack: args => draft('track', args), draftStation: args => draft('station', args), draftBuilding: args => draft('building', args),
        draftSpace: args => draft('space', args), draftParcelLayout: args => draft('parcel-layout', args), draftUrbanRule: args => draft('urban-rule', args),
        async inspectDesign({ design, paths = [''] }) {
            const resolved = await resolveDesignSource(design), content = resolved.content;
            return { cid: cidOfObject(content), parcelSourceId: resolved.parcelSourceId,
                values: paths.map(path => ({ path, untrustedValue: valueAt(content, path) })),
                editableRoots: Object.keys(content).filter(key => !['schema', 'origin', 'authoredAt'].includes(key)).map(key => `/${key}`),
                next: trustedMetadata({ tool: 'ugt_edit_design', action: 'Use this CID as expectedCid. Patch the authored JSON with ordered JSON Pointer edits. Canonical OSM changes rebuild the road footprint; coupled building geometry must remain consistent.' }) };
        },
        async editDesign({ design, expectedCid, edits, parcelSourceId, corridors }) {
            const resolved = await resolveDesignSource(design);
            if (cidOfObject(resolved.content) !== expectedCid) throw Object.assign(new Error('Inspect the intended design revision before editing.'), {
                code: 'design-revision-mismatch', currentCid: cidOfObject(resolved.content), expectedCid,
                next: { tool: 'ugt_inspect_design', arguments: { design }, action: 'Inspect this reference and use its current CID as expectedCid.' } });
            return joinedEdit(resolved.content, editedDesign(resolved.content, expectedCid, edits), corridors, parcelSourceId || resolved.parcelSourceId);
        },
        async modifyDesign({ design, changes, parcelSourceId, corridors }) {
            const resolved = await resolveDesignSource(design), original = resolved.content;
            parcelSourceId ||= resolved.parcelSourceId;
            let modified = original;
            for (const change of changes) {
                if (change.type === 'fit_to_permitted') {
                    if (!modified.buildingProposal) throw fail('invalid-change', 'Only a building can fit a permitted envelope.', { action: 'Choose a building design.' });
                    const answer = await read.request('/designs/binding', {}, { site: read.siteOfDesign(modified), city: modified.city, parcelSourceId });
                    const ids = answer.binding?.parcels?.map(p => p.parcelId) || [];
                    if (ids.length !== 1) throw fail('envelope-ambiguous', 'Choose a building on one parcel.', { action: 'Draft one parcel-bound building.' });
                    const fitted = await draft('building', { city: modified.city, parcelSourceId, parcelIds: ids, permitted: true, planningSource: change.planningSource, title: modified.title, description: modified.description, author: modified.author, authoredAt: modified.authoredAt });
                    modified = fitted.design;
                } else modified = builder.modify(modified, [change], { turf });
            }
            modified.origin = { cid: cidOfObject(original) };
            modified.authoredAt = new Date().toISOString();
            validateTrackDesign(modified, original);
            return joinedEdit(original, modified, corridors, parcelSourceId);
        },
        compare: createMcpComparison({ read, resolveDesign, appOrigin, resolveDraftReference })
    };
}
