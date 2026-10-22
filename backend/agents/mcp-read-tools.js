// Public MCP reads use the app's parcel gateway and search providers, with bounded upstream waits.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
import { isCid } from '../cid.js';

const require = createRequire(import.meta.url);
const approvalLink = require('../../frontend/js/approval-link.js');
const search = require('../../frontend/js/ui/search-model.js');
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
            const { sources } = await request('/parcel-sources');
            source = sources.find(item => item.cityIds?.includes(city) || item.city === city)?.id;
            if (!source) throw failure('parcel-source-required', 'Choose a parcel source from ugt://cities or /parcel-sources.', { action: 'Supply parcelSourceId from /parcel-sources.' });
        }
        const result = geometry
            ? await request(`/parcel-sources/${encodeURIComponent(source)}/under`, {}, { geometry })
            : await request(`/parcel-sources/${encodeURIComponent(source)}`, parcelIds ? { ids: parcelIds.join(',') } : { point: point.join(',') });
        if (result.complete !== true) throw failure('parcel-coverage-incomplete', 'The parcel source did not return complete coverage.', { action: 'Retry when the parcel source is available; do not draft from partial ground.' });
        if (parcelIds && parcelIds.some(id => !result.features.some(f => String(f.id ?? f.properties?.parcelId) === id))) {
            throw failure('parcel-missing', 'One or more requested parcels are absent.', { action: 'Correct the parcel ids using ugt_find_place.' });
        }
        return { ...result, parcelSourceId: source };
    }
    const listDesigns = query => request('/designs', { ...query, bbox: query?.bbox?.join(',') });
    async function getDesign({ designCid }) {
        const row = await request(`/designs/${encodeURIComponent(designCid)}`);
        if (row.cid !== designCid) throw failure('cid-mismatch', 'The index returned a different design.', { action: 'Retry from a trusted index.' });
        return { ...row, previewUrl: `${appOrigin}/designs/${designCid}` };
    }
    return {
        request, parcels, mapUrl, listDesigns, getDesign,
        approvalLink: args => ({ approvalUrl: approvalLink.build({ origin: appOrigin, ...args }), next: { action: 'Open the link, review the agreement and press the selected action to sign with your wallet.' } }),
        async findPlace({ query, city, parcelSourceId, bbox, limit = 5 }) {
            if (isCid(query)) return { candidates: [await getDesign({ designCid: query })] };
            if (search.looksLikeParcelId(query)) {
                const result = await parcels({ city, parcelSourceId, parcelIds: [query] });
                return { candidates: result.features.map(feature => ({ kind: 'parcel', city, parcelIds: [String(feature.id ?? feature.properties.parcelId)],
                    parcelSourceId: result.parcelSourceId, bbox: turf.bbox(feature), previewUrl: mapUrl(city, turf.bbox(feature)) })) };
            }
            const designs = await listDesigns({ city, q: query, limit });
            const places = await request('https://photon.komoot.io/api/', { q: query, limit, ...(bbox ? { bbox: bbox.join(',') } : {}) }, undefined, true);
            return { candidates: [...(designs.designs || []).map(row => ({ kind: 'design', ...row, previewUrl: `${appOrigin}/designs/${row.cid}` })),
                ...(places.features || []).map(feature => ({ kind: 'place', city: city || null, point: feature.geometry.coordinates,
                    title: feature.properties?.name, description: feature.properties, bbox: feature.properties?.extent || null,
                    previewUrl: mapUrl(city, [...feature.geometry.coordinates, ...feature.geometry.coordinates]) }))].slice(0, limit) };
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
            const studies = await Promise.all((planning.sources || []).filter(s => s.parcelStudy).map(async source => ({ source: source.id,
                study: await request('/planning/study', { city: args.city, source: source.id, parcel: id }) })));
            return { parcel, parcelSourceId: result.parcelSourceId, areaM2: turf.area(parcel), designs, agreements, markets, buildings, history, planning, studies,
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
