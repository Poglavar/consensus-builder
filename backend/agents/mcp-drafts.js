// Resolve intent against authoritative sources, then call the browser's pure builders and hash results.
import { appTurf as turf, intentDesign as builder } from './mcp-geometry.js';
import { cidOfObject, designObject, isCid } from './agreement-objects.js';
import { createMcpComparison } from './mcp-compare.js';
import { previewArtifact } from './mcp-preview.js';
import { parcelSourceIdOf } from './mcp-read-tools.js';
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
        if (kind === 'road' && !intent.points) {
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
        } else if (kind !== 'road') {
            if (args.parcelIds?.length) {
                const source = await read.parcels(args);
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
        const design = builder.build(intent, { turf });
        const checked = designObject({ ...design, createdAt: design.authoredAt });
        return result(checked.content, intent.parcelSourceId || args.parcelSourceId);
    }
    async function resolveDesignSource(value) {
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
        const rebuilt = designObject({ ...content, createdAt: content?.authoredAt });
        if (cidOfObject(content) !== rebuilt.cid) throw fail('invalid-design', 'Draft is not a canonical design/v1 object.', { action: 'Use a design returned by a draft tool.' });
        if (row?.cid && row.cid !== rebuilt.cid) throw fail('cid-mismatch', 'The supplied canonical design differs from its claimed CID.');
        return { content, parcelSourceId: row?.parcelSourceId };
    }
    const resolveDesign = async value => (await resolveDesignSource(value)).content;
    return {
        resolveDesign, resolveDesignSource,
        draftRoad: args => draft('road', args), draftBuilding: args => draft('building', args),
        draftSpace: args => draft('space', args), draftParcelLayout: args => draft('parcel-layout', args), draftUrbanRule: args => draft('urban-rule', args),
        async modifyDesign({ design, changes, parcelSourceId }) {
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
            return result(modified, parcelSourceId);
        },
        compare: createMcpComparison({ read, resolveDesign, appOrigin, resolveDraftReference })
    };
}
