// Resolve intent against authoritative sources, then call the browser's pure builders and hash results.
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { cidOfObject, designObject, isCid } from './agreement-objects.js';
const require = createRequire(import.meta.url);
const builder = require('../../frontend/js/intent-design.js');
const links = require('../../frontend/js/draft-link.js');
const fail = (code, message, next) => Object.assign(new Error(message), { code, next });
const geometry = value => value?.type === 'Feature' ? value.geometry : value;
function union(features) {
    return features.reduce((a, b) => a ? turf.union(a, b) : b, null)?.geometry;
}

export function createMcpDraftTools({ read, appOrigin }) {
    async function result(design, parcelSourceId) {
        const binding = await read.request('/designs/binding', {}, { site: read.siteOfDesign(design), city: design.city, toleranceM: design.toleranceM, parcelSourceId });
        if (binding.binding?.coverage === 'unknown' || binding.binding?.unknownM2 > 0) throw fail('ground-unavailable', 'The site binding is unknown.', { action: 'Retry when parcel coverage is available.' });
        return { design, cid: cidOfObject(design), takes: (binding.binding?.parcels || []).map(p => p.parcelId), binding: binding.binding,
            warnings: [ ...(design.goal === 'buildings' ? ['An intent drawing is not a planning permission; envelope applicability remains unresolved.'] : []),
                ...(binding.binding?.unsurveyedM2 > 0 ? ['The site includes ground outside the parcel register.'] : []) ],
            previewUrl: await links.build({ origin: appOrigin, design, parcelSourceId }) };
    }
    async function draft(kind, args) {
        let intent = { ...args, kind };
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
    async function resolveDesign(value) {
        if (isCid(value)) return (await read.getDesign({ designCid: value })).content;
        const content = value?.untrusted?.design || value?.design || value;
        const rebuilt = designObject({ ...content, createdAt: content?.authoredAt });
        if (cidOfObject(content) !== rebuilt.cid) throw fail('invalid-design', 'Draft is not a canonical design/v1 object.', { action: 'Use a design returned by a draft tool.' });
        return content;
    }
    return {
        resolveDesign,
        draftRoad: args => draft('road', args), draftBuilding: args => draft('building', args),
        draftSpace: args => draft('space', args), draftParcelLayout: args => draft('parcel-layout', args), draftUrbanRule: args => draft('urban-rule', args),
        async modifyDesign({ design, changes, parcelSourceId }) {
            const original = await resolveDesign(design);
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
            return result(modified, parcelSourceId);
        },
        async compare({ targets }) {
            const results = [];
            for (const target of targets) {
                let content = target;
                if (typeof target === 'string') {
                    try { content = (await read.getDesign({ designCid: target })).content; }
                    catch (error) { if (error.code !== 'http-404' && error.code !== 'design-not-found') throw error; content = (await read.request(`/agreements/${encodeURIComponent(target)}`)).content; }
                }
                const agreement = content.schema === 'agreement/v1';
                const designs = agreement ? await Promise.all(content.designs.map(d => resolveDesign(d.cid))) : [await resolveDesign(content)];
                let floorAreaM2 = 0, greenAreaM2 = 0, roadAreaM2 = 0;
                for (const d of designs) {
                    for (const building of d.geometry?.buildings || []) {
                        const floors = building.properties?.floors;
                        if (typeof floors !== 'number' || !Number.isFinite(floors)) { floorAreaM2 = null; break; }
                        if (floorAreaM2 !== null) floorAreaM2 += turf.area(building) * floors;
                    }
                    if (d.goal === 'park') greenAreaM2 += turf.area(turf.feature(d.structureProposal.geometry));
                    if (d.roadProposal) roadAreaM2 += turf.area(turf.feature(d.roadProposal.definition.polygon));
                }
                results.push({ cid: cidOfObject(content), title: content.title, floorAreaM2, greenAreaM2, roadAreaM2,
                    parcelsTaken: agreement ? content.inputs.parcels.map(p => p.parcelId) : null, buildingsRemoved: null,
                    ledger: agreement ? content.money : null,
                    previewUrl: agreement ? `${appOrigin}/agreements/${cidOfObject(content)}` : await links.build({ origin: appOrigin, design: content }) });
            }
            return { alternatives: results, warnings: ['Buildings removed and missing land or ledger measurements remain unknown. Areas are authored geometry, not a prediction of construction.'] };
        }
    };
}
