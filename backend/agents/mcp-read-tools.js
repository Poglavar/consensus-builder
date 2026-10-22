// Public MCP reads use the app's parcel gateway and search providers, with bounded upstream waits.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { cidOfObject, isCid } from '../cid.js';

const require = createRequire(import.meta.url);
const approvalLink = require('../../frontend/js/approval-link.js');
const footprintParts = require('../../frontend/js/proposals/footprint-parts.js');
const search = require('../../frontend/js/ui/search-model.js');
const databaseSources = JSON.parse(readFileSync(new URL('../parcels/source-catalog.json', import.meta.url), 'utf8')).databaseSources;
const vocabulary = () => readFileSync(new URL('../../vocabulary.md', import.meta.url), 'utf8');
const failure = (code, message, next) => Object.assign(new Error(message), { code, next });

export function createMcpReadTools({ apiBase, appOrigin, fetchImpl }) {
    async function request(path, query = {}, body, external = false) {
        const url = new URL(path, `${apiBase}/`);
        for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
        if (!external && url.origin !== new URL(apiBase).origin) throw new Error('API requests must stay on the configured origin');
        const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(30_000),
            headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', origin: appOrigin } : {}) },
            ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch { throw failure('invalid-upstream-response', `Source returned non-JSON (HTTP ${response.status})`, { action: 'Retry the source later.' }); }
        if (!response.ok) throw failure(data.code || `http-${response.status}`, data.error || `Source returned HTTP ${response.status}`,
            data.next || { action: response.status === 429 ? 'Wait for the source rate limit, then retry.' : 'Check the city, source and parcel using ugt_find_place.' });
        return data;
    }
    const mapUrl = (city, bbox) => {
        const url = new URL('/', appOrigin);
        if (city) url.searchParams.set('city', city);
        if (bbox) url.searchParams.set('at', `${(bbox[1] + bbox[3]) / 2},${(bbox[0] + bbox[2]) / 2},17`);
        return url.toString();
    };
    async function parcels({ city, parcelSourceId, parcelIds, point, geometry }) {
        if (!geometry && (Boolean(parcelIds) === Boolean(point))) throw failure('invalid-parcel-query', 'Provide exactly one of parcel ids or point.', { action: 'Supply parcelId or point.' });
        let source = parcelSourceId;
        if (!source) {
            const catalogue = await request('/parcel-sources');
            const sources = [...databaseSources, ...catalogue.sources];
            source = sources.find(item => item.defaultForCity !== false && (item.cityIds?.includes(city) || item.city === city))?.id;
            if (!source) throw failure('parcel-source-required', 'Choose a parcel source from ugt://cities or /parcel-sources.', { action: 'Supply parcelSourceId from /parcel-sources.' });
        }
        let result;
        if (databaseSources.some(item => item.id === source)) {
            const path = source === 'oss-wfs' ? '/parcels' : `/${source}`;
            const normalize = f => {
                const id = String(f.properties?.parcelId ?? f.id ?? '');
                if (!id) throw failure('parcel-id-missing', 'The source returned ground without an identity.', { action: 'Retry after the parcel source is repaired.' });
                return { ...f, id, properties: { ...f.properties, parcelId: id } };
            };
            let features = [];
            if (parcelIds) {
                const groups = source === 'oss-wfs' ? [parcelIds] : parcelIds.map(id => [id]);
                for (const group of groups) {
                    const answer = await request(path, { [source === 'parcel-ba' ? 'smp' : 'parcel_id']: group.join(',') });
                    if (answer.truncated) throw failure('parcel-coverage-incomplete', 'Database parcel query was truncated.', { action: 'Choose fewer parcel ids.' });
                    features.push(...answer.features.map(normalize));
                }
            } else if (source === 'oss-wfs') {
                const answer = geometry ? await request('/parcels/under', {}, { geometry, srid: 4326, parcelsOnly: true })
                    : await request(path, { coordinates: point.join(',') });
                features = answer.features.map(normalize);
            } else {
                const bounds = geometry ? turf.bbox(turf.feature(geometry)) : [point[0] - 0.00001, point[1] - 0.00001, point[0] + 0.00001, point[1] + 0.00001];
                const answer = await request(path, { bbox: bounds.join(',') });
                if (answer.truncated) throw failure('parcel-coverage-incomplete', 'Database parcel query was truncated.', { action: 'Choose a smaller outline.' });
                features = answer.features.map(normalize).filter(f => geometry ? turf.booleanIntersects(f, turf.feature(geometry)) : turf.booleanPointInPolygon(turf.point(point), f));
            }
            result = { complete: true, features };
        } else result = geometry
            ? await request(`/parcel-sources/${encodeURIComponent(source)}/under`, {}, { geometry })
            : await request(`/parcel-sources/${encodeURIComponent(source)}`, parcelIds ? { ids: parcelIds.join(',') } : { point: point.join(',') });
        if (result.complete !== true) throw failure('parcel-coverage-incomplete', 'The parcel source did not return complete coverage.', { action: 'Retry when the parcel source is available; do not draft from partial ground.' });
        if (parcelIds && parcelIds.some(id => !result.features.some(f => String(f.id ?? f.properties?.parcelId) === id))) {
            throw failure('parcel-missing', 'One or more requested parcels are absent.', { action: 'Correct the parcel ids using ugt_find_place.' });
        }
        return { ...result, parcelSourceId: source };
    }
    const listDesigns = async query => {
        const answer = await request('/designs', { ...query, bbox: query?.bbox?.join(',') });
        return { ...answer, designs: (answer.designs || []).map(row => ({ ...row, previewUrl: `${appOrigin}/designs/${row.cid}` })) };
    };
    async function getDesign({ designCid }) {
        const row = await request(`/designs/${encodeURIComponent(designCid)}`);
        if (row.cid !== designCid || !row.content || cidOfObject(row.content) !== designCid) throw failure('cid-mismatch', 'The index returned a different design.', { action: 'Retry from a trusted index.' });
        return { ...row, previewUrl: `${appOrigin}/designs/${designCid}` };
    }
    return {
        request, parcels, mapUrl, listDesigns, getDesign,
        siteOfDesign(content) {
            if (content.site) return content.site;
            const parts = footprintParts.footprintParts(content);
            if (parts.invalid || parts.approximate || !parts.polygons.length) throw failure('design-site-unavailable', 'This design has no exact polygon site to bind.', { action: 'Review the design in the app.' });
            return parts.polygons.reduce((out, shape) => out ? turf.union(out, turf.feature(shape)) : turf.feature(shape), null).geometry;
        },
        cities: async () => ({ sources: [...databaseSources, ...(await request('/parcel-sources')).sources] }),
        approvalLink: args => ({ approvalUrl: approvalLink.build({ origin: appOrigin, ...args }), next: { action: 'Open the link, review the agreement and press the selected action to sign with your wallet.' } }),
        async findPlace({ query, city, parcelSourceId, bbox, limit = 5 }) {
            if (isCid(query)) {
                try { return { candidates: [{ kind: 'design', ...await getDesign({ designCid: query }) }] }; }
                catch (error) {
                    if (!['http-404', 'design-not-found'].includes(error.code)) throw error;
                    return { candidates: [{ kind: 'agreement', ...await request(`/agreements/${query}`), previewUrl: `${appOrigin}/agreements/${query}` }] };
                }
            }
            if (search.looksLikeParcelId(query)) {
                const result = await parcels({ city, parcelSourceId, parcelIds: [query] });
                return { candidates: result.features.map(feature => ({ kind: 'parcel', city, parcelIds: [String(feature.id ?? feature.properties.parcelId)],
                    parcelSourceId: result.parcelSourceId, bbox: turf.bbox(feature), previewUrl: mapUrl(city, turf.bbox(feature)) })) };
            }
            const [designs, agreements] = await Promise.all([listDesigns({ city, q: query, limit }), request('/agreements', { city, limit: 100 })]);
            const places = await request('https://photon.komoot.io/api/', { q: query, limit, ...(bbox ? { bbox: bbox.join(',') } : {}) }, undefined, true);
            return { candidates: [...(designs.designs || []).map(row => ({ kind: 'design', ...row, previewUrl: `${appOrigin}/designs/${row.cid}` })),
                ...(agreements.agreements || []).filter(row => search.matchRank(row.title || row.content?.title, query) !== null).map(row => ({ kind: 'agreement', ...row, previewUrl: `${appOrigin}/agreements/${row.cid}` })),
                ...(places.features || []).map(feature => ({ kind: 'place', city: null, requestedCity: city || null, point: feature.geometry.coordinates,
                    title: feature.properties?.name, description: feature.properties, bbox: feature.properties?.extent || null,
                    previewUrl: mapUrl(city, [...feature.geometry.coordinates, ...feature.geometry.coordinates]) }))].slice(0, limit), warnings: agreements.count >= 100 ? ['Agreement title search covers the latest 100 agreements.'] : [] };
        },
        async parcelContext(args) {
            const result = await parcels({ ...args, parcelIds: args.parcelId ? [args.parcelId] : undefined });
            if (result.features.length !== 1) throw failure('parcel-ambiguous', 'The point must identify exactly one parcel.', { action: 'Choose a parcelId from ugt_find_place.' });
            const parcel = result.features[0], id = String(parcel.id ?? parcel.properties.parcelId), bbox = turf.bbox(parcel);
            const [designs, agreements, markets, buildings, history, planning] = await Promise.all([
                listDesigns({ city: args.city, bbox, limit: 100 }), request('/agreements', { parcel: id, limit: 100 }), request('/markets', { city: args.city }),
                request('/buildings/under', {}, { regions: [{ key: id, geometry: parcel.geometry }] }),
                request(`/parcels/${encodeURIComponent(id)}/history`), request('/planning/sources', { city: args.city, bbox: bbox.join(',') })
            ]);
            const urbanRules = result.parcelSourceId === 'oss-wfs'
                ? await request('/urban-rules', { coordinates: turf.pointOnFeature(parcel).geometry.coordinates.join(',') }) : null;
            designs.designs = (designs.designs || []).filter(d => d.binding?.parcels?.some(p => String(p.parcelId) === id));
            const studies = await Promise.all((planning.sources || []).filter(s => s.parcelStudy).map(async source => ({ source: source.id,
                study: await request('/planning/study', { city: args.city, source: source.id, parcel: id }) })));
            return { parcel, parcelSourceId: result.parcelSourceId, areaM2: turf.area(parcel), designs, agreements, markets, buildings, history, planning, studies, urbanRules,
                previewUrl: mapUrl(args.city, bbox) };
        },
        markets: ({ city }) => request('/markets', { city }),
        explain({ term }) {
            const sections = vocabulary().split(/(?=^#{2,4} )/m);
            const matches = sections.filter(section => section.split('\n')[0].toLowerCase().includes(term.toLowerCase()));
            return { term, entries: matches, resource: 'ugt://vocabulary' };
        },
        vocabulary
    };
}
