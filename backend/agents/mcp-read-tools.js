// Public MCP reads use the app's parcel gateway and search providers, with bounded upstream waits.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appTurf as turf } from './mcp-geometry.js';
import { trustedMetadata } from './mcp-results.js';
import { cidOfObject, isCid } from '../cid.js';
import { cityMoney } from '../scripts/lib/frontend-city-money.mjs';

const require = createRequire(import.meta.url);
const approvalLink = require('../../frontend/js/approval-link.js');
const footprintParts = require('../../frontend/js/proposals/footprint-parts.js');
const search = require('../../frontend/js/ui/search-model.js');
const { locationOf } = require('../../frontend/js/economic-sources.js');
const { featureArea } = require('../../frontend/js/ui/parcel-menu-model.js');
const { buildParcelPriceEstimate } = require('../../frontend/js/financials.js');
const { cadastralPartOf, cadastralParts } = require('../../frontend/js/parcels/live-fabric.js');
const catalog = JSON.parse(readFileSync(new URL('../../frontend/data/source-catalog.json', import.meta.url), 'utf8'));
const databaseSources = catalog.databaseSources;
// Parcels are read by id in batches, as the map reads them (frontend/js/parcels/fetch.js): at most
// ID_BATCH_SIZE ids a request, fewer where the source's catalog entry declares a smaller
// idBatchSize. Most sources refuse more than 80 ids at once, and a long id list outgrows a URL.
export const ID_BATCH_SIZE = 40;

// The city's selected rates per m², as Settings → Valuation & costs shows them: sale and construction
// per m² of floor, land and road land per m² of land, each with its basis, date and source
// (frontend/js/economic-sources.js), at `at`, [lng, lat]: rates published per area (an English
// authority's land value, a London value band) are that place's, as the app's panels take them. A
// city the app does not configure has none, and says why.
export function cityEconomics(city, at = null) {
    try {
        const money = cityMoney(city);
        return { currency: money.currentCurrency(), rates: money.currentEconomicRates(at) };
    } catch (error) {
        return { currency: null, rates: {}, unavailable: true, reason: error.message };
    }
}
// The parcel panel's estimate (Info tab): the parcel's area, the record's else its measured geometry's
// (ParcelMenuModel.featureArea), × the city's land rate where it lies, with that rate's source; a
// source's own price estimate where the record carries one. Null amount when either is missing.
export function landEstimateOf(city, parcel) {
    const areaM2 = featureArea(parcel, turf);
    const { currency, rates } = cityEconomics(city, locationOf(parcel));
    return { areaM2, ...buildParcelPriceEstimate(parcel?.properties || {}, areaM2 ?? 0,
        { areaPricePerSqm: rates.land?.amount, currency, economicSource: rates.land || null }) };
}
const idBatchSizes = new Map(catalog.sources.filter(source => Number.isSafeInteger(source.idBatchSize) && source.idBatchSize > 0)
    .map(source => [source.id, Math.min(source.idBatchSize, ID_BATCH_SIZE)]));
const batchesOf = (ids, size) => Array.from({ length: Math.ceil(ids.length / size) }, (_, index) => ids.slice(index * size, (index + 1) * size));
const vocabulary = () => readFileSync(new URL('../../docs/vocabulary.md', import.meta.url), 'utf8');
const failure = (code, message, next) => Object.assign(new Error(message), { code, next });
// Indexed designs retain the source on their binding. The Croatian PostGIS binding names its
// cadastral namespace; the public read/binding gateway for that same stock is oss-wfs.
export const parcelSourceIdOf = value => value?.parcelSourceId
    || (value?.binding?.parcelSource?.sourceId === 'hr-cadastre' ? 'oss-wfs' : value?.binding?.parcelSource?.sourceId);

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
        const metadata = { status: response.status, source: url.origin,
            retryable: response.status === 429 || response.status >= 500 };
        const retryAfter = response.headers?.get('retry-after');
        // Only a numeric delay or a valid HTTP date is operational metadata; never copy prose.
        if (/^\d+$/.test(retryAfter || '') && Number.isSafeInteger(Number(retryAfter))) metadata.retryAfter = Number(retryAfter);
        else if (retryAfter && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter))) {
            metadata.retryAfter = Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000));
        }
        try { data = JSON.parse(text); } catch {
            throw Object.assign(failure('invalid-upstream-response', `Source returned non-JSON (HTTP ${response.status})`, { action: 'Retry the source later.' }), metadata, { upstream: { message: text } });
        }
        if (!response.ok) throw Object.assign(failure(`http-${response.status}`, `Source returned HTTP ${response.status}`,
            { action: response.status === 429 ? 'Wait for the source rate limit, then retry.'
                : response.status >= 500 ? 'Retry the unavailable source later.' : 'Check the city, source and parcel using ugt_find_place.' }),
            metadata, { upstream: data });
        return data;
    }
    const mapUrl = (city, bbox) => {
        const url = new URL('/', appOrigin);
        if (city) url.searchParams.set('city', city);
        if (bbox) url.searchParams.set('at', `${(bbox[1] + bbox[3]) / 2},${(bbox[0] + bbox[2]) / 2},17`);
        return url.toString();
    };
    function coordinateQuery(value) {
        const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(value || ''));
        if (!match) return null;
        const point = [Number(match[1]), Number(match[2])]; // lng, lat
        if (point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) throw failure('invalid-place-coordinate', 'Coordinate search must be longitude, latitude in WGS84.', { action: 'Supply longitude,latitude within the WGS84 range.' });
        return point;
    }
    async function parcels({ city, parcelSourceId, parcelIds, point, geometry }) {
        if (!geometry && (Boolean(parcelIds) === Boolean(point))) throw Object.assign(failure('invalid-parcel-query', 'Provide exactly one of parcel ids or point.', { action: 'Supply parcelId or point.' }), { field: ['parcelIds', 'point'], constraints: { exactlyOne: ['parcelIds', 'point'] } });
        let source = parcelSourceId;
        if (!source) throw Object.assign(failure('parcel-source-required', 'Supply an explicit parcelSourceId.', {
            tool: 'ugt_list_sources', arguments: { ...(city ? { city } : {}), abstraction: 'parcels' },
            action: 'Choose a source with the required parcel lookup capability and pass its id as parcelSourceId.'
        }), { field: 'parcelSourceId', constraints: { required: true, abstraction: 'parcels' } });
        const requestedIds = parcelIds;
        if (parcelIds) parcelIds = [...new Set(parcelIds.map(id => cadastralPartOf(id)?.cadastreId || id))];
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
                const groups = source === 'oss-wfs' ? batchesOf(parcelIds, ID_BATCH_SIZE) : parcelIds.map(id => [id]);
                for (const group of groups) {
                    const answer = await request(path, { [source === 'parcel-ba' ? 'smp' : 'parcel_id']: group.join(',') });
                    if (answer.truncated) throw failure('parcel-coverage-incomplete', 'Database parcel query was truncated.', { action: 'Choose fewer parcel ids.' });
                    features.push(...answer.features.map(normalize));
                }
            } else if (source === 'oss-wfs') {
                const answer = geometry ? await request('/parcels/under', {}, { geometry, srid: 4326 })
                    : await request(path, { coordinates: point.join(',') });
                features = answer.features.map(normalize);
            } else {
                const bounds = geometry ? turf.bbox(turf.feature(geometry)) : [point[0] - 0.00001, point[1] - 0.00001, point[0] + 0.00001, point[1] + 0.00001];
                const answer = await request(path, { bbox: bounds.join(',') });
                if (answer.truncated) throw failure('parcel-coverage-incomplete', 'Database parcel query was truncated.', { action: 'Choose a smaller outline.' });
                features = answer.features.map(normalize).filter(f => geometry ? turf.booleanIntersects(f, turf.feature(geometry)) : turf.booleanPointInPolygon(turf.point(point), f));
            }
            result = { complete: true, features };
        } else if (geometry) result = await request(`/parcel-sources/${encodeURIComponent(source)}/under`, {}, { geometry });
        else if (!parcelIds) result = await request(`/parcel-sources/${encodeURIComponent(source)}`, { point: point.join(',') });
        else {
            const answers = [];
            for (const batch of batchesOf(parcelIds, idBatchSizes.get(source) ?? ID_BATCH_SIZE)) {
                answers.push(await request(`/parcel-sources/${encodeURIComponent(source)}`, { ids: batch.join(',') }));
            }
            result = { ...answers[0], complete: answers.every(answer => answer.complete === true),
                features: answers.flatMap(answer => answer.features || []),
                ...(answers.some(answer => Array.isArray(answer.absentIds)) ? { absentIds: answers.flatMap(answer => answer.absentIds || []) } : {}) };
        }
        if (result.complete !== true) throw failure('parcel-coverage-incomplete', 'The parcel source did not return complete coverage.', { action: 'Retry when the parcel source is available; do not draft from partial ground.' });
        const found = new Set(result.features.map(f => String(f.id ?? f.properties?.parcelId)));
        if (parcelIds && parcelIds.some(id => !found.has(id))) {
            throw failure('parcel-missing', 'One or more requested parcels are absent.', { action: 'Correct the parcel ids using ugt_find_place.' });
        }
        if (requestedIds?.some(id => cadastralPartOf(id))) {
            const originals = new Map(result.features.map(f => [String(f.id ?? f.properties?.parcelId), f]));
            const parts = new Map(result.features.flatMap(cadastralParts).map(f => [String(f.id ?? f.properties?.parcelId), f]));
            const features = requestedIds.map(id => cadastralPartOf(id) ? parts.get(id) : originals.get(id));
            if (features.some(feature => !feature)) throw failure('parcel-missing', 'That cadastral map piece does not exist in the current source geometry.', { action: 'Refresh the map and choose an exact current parcel piece.' });
            result = { ...result, features };
        }
        return { ...result, parcelSourceId: source };
    }
    // parcelIds and goals go to the index as its comma-separated parcel and goal filters.
    const listDesigns = async ({ parcelIds, goals, ...query } = {}) => {
        const answer = await request('/designs', { ...query, bbox: query.bbox?.join(','),
            parcel: parcelIds?.length ? parcelIds.join(',') : undefined, goal: goals?.length ? goals.join(',') : undefined });
        return { ...answer, designs: (answer.designs || []).map(row => ({ ...row, previewUrl: `${appOrigin}/designs/${row.cid}` })) };
    };
    async function getDesign({ designCid }) {
        const row = await request(`/designs/${encodeURIComponent(designCid)}`);
        if (row.cid !== designCid || !row.content || cidOfObject(row.content) !== designCid) throw failure('cid-mismatch', 'The index returned a different design.', { action: 'Retry from a trusted index.' });
        return { ...row, parcelSourceId: parcelSourceIdOf(row), previewUrl: `${appOrigin}/designs/${designCid}` };
    }
    async function getAgreement({ agreementCid, includeAvailability = false }) {
        const row = await request(`/agreements/${encodeURIComponent(agreementCid)}`, includeAvailability ? { inventory: '1' } : {});
        if (row.cid !== agreementCid || !row.content || cidOfObject(row.content) !== agreementCid) throw failure('cid-mismatch', 'The index returned a different agreement.', { action: 'Retry from a trusted index.' });
        return { ...row, previewUrl: `${appOrigin}/agreements/${agreementCid}` };
    }
    async function apartmentOffers({ city, xrayBuilding, unit }) {
        const { offers } = await request('/agreements/apartment-offers', { city, xrayBuilding, unit });
        return { offers: offers.map(({ cid, city, unitId, title, label }) => ({ cid, city, unitId, untrusted: { title, label } })) };
    }
    return {
        request, parcels, mapUrl, listDesigns, getDesign, getAgreement, apartmentOffers,
        chatCost: args => request('/chat/cost', args),
        siteOfDesign(content) {
            if (content.site) return content.site;
            const parts = footprintParts.footprintParts(content);
            if (parts.invalid || parts.approximate || !parts.polygons.length) throw failure('design-site-unavailable', 'This design has no exact polygon site to bind.', { action: 'Review the design in the app.' });
            return parts.polygons.reduce((out, shape) => out ? turf.union(out, turf.feature(shape)) : turf.feature(shape), null).geometry;
        },
        cities: async () => ({ sources: [...databaseSources, ...(await request('/parcel-sources')).sources] }),
        approvalLink: args => ({ approvalUrl: approvalLink.build({ origin: appOrigin, ...args }), next: trustedMetadata({ action: 'Open the link, review the agreement and press the selected action to sign with your wallet.' }) }),
        async findPlace({ query, city, parcelSourceId, bbox, limit = 5, street, houseNumber, streetA, streetB }) {
            query = typeof query === 'string' ? query.trim() : '';
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
            const coordinate = coordinateQuery(query);
            if (coordinate) return { candidates: [{ kind: 'place', city: city || null, title: query, point: coordinate,
                previewUrl: mapUrl(city, [coordinate[0], coordinate[1], coordinate[0], coordinate[1]]) }], partial: false, truncated: false, noMatch: false };
            const hasAddress = Boolean(street || houseNumber), hasIntersection = Boolean(streetA || streetB);
            if ((hasAddress && (!street || !houseNumber)) || (hasIntersection && (!streetA || !streetB)) ||
                (Number(hasAddress) + Number(hasIntersection) + Number(Boolean(query)) !== 1)) {
                throw failure('place-query-required', 'Provide one place name, complete address, street intersection, coordinate or CID.', { action: 'Supply one complete place search.' });
            }
            const [designs, agreements] = query ? await Promise.all([listDesigns({ city, q: query, limit }), request('/agreements', { city, limit: 100 })]) : [{ designs: [] }, { agreements: [], count: 0 }];
            let places = { candidates: [], partial: false, truncated: false };
            if (bbox) places = await request('/places', { bbox: bbox.join(','), ...(query ? { q: query } : {}), street, houseNumber, streetA, streetB, limit });
            const candidates = [...(designs.designs || []).map(row => ({ kind: 'design', ...row, previewUrl: `${appOrigin}/designs/${row.cid}` })),
                ...(agreements.agreements || []).filter(row => search.matchRank(row.title || row.content?.title, query) !== null).map(row => ({ kind: 'agreement', ...row, previewUrl: `${appOrigin}/agreements/${row.cid}` })),
                ...(places.candidates || []).map(place => ({ ...place, city: city || null, requestedCity: city || null,
                    previewUrl: mapUrl(city, [place.point[0], place.point[1], place.point[0], place.point[1]]) }))];
            const truncated = places.truncated === true || agreements.count >= 100 || candidates.length > limit;
            const warnings = [];
            if (agreements.count >= 100) warnings.push('Agreement title search covers the latest 100 agreements.');
            if (!bbox) warnings.push('OSM place candidates require a WGS84 bbox no larger than 0.5 degrees.');
            if (places.partial) warnings.push('OSM place coverage is partial; this result may omit matches.');
            return { candidates: candidates.slice(0, limit), partial: places.partial === true, truncated,
                noMatch: candidates.length === 0 && places.partial !== true, warnings };
        },
        async parcelContext(args) {
            const result = await parcels({ ...args, parcelIds: args.parcelId ? [args.parcelId] : undefined });
            if (result.features.length !== 1) throw failure('parcel-ambiguous', 'The point must identify exactly one parcel.', { action: 'Choose a parcelId from ugt_find_place.' });
            const parcel = result.features[0], id = String(parcel.id ?? parcel.properties.parcelId), bbox = turf.bbox(parcel);
            const [designs, agreements, markets, buildings, history, planning] = await Promise.all([
                listDesigns({ city: args.city, parcelIds: [id], limit: 100 }), request('/agreements', { parcel: id, limit: 100 }), request('/markets', { city: args.city }),
                args.buildingSourceId ? request('/buildings/under', {}, { source: args.buildingSourceId, regions: [{ key: id, geometry: parcel.geometry }] })
                    : { supported: false, unavailable: true, reason: 'building-source-required' },
                request(`/parcels/${encodeURIComponent(id)}/history`), request('/planning/sources', { city: args.city, bbox: bbox.join(',') })
            ]);
            const urbanRules = result.parcelSourceId === 'oss-wfs'
                ? await request('/urban-rules', { coordinates: turf.pointOnFeature(parcel).geometry.coordinates.join(',') }) : null;
            const studies = await Promise.all((planning.sources || []).filter(s => s.parcelStudy && args.planningSourceIds?.includes(s.id)).map(async source => ({ source: source.id,
                study: await request('/planning/study', { city: args.city, source: source.id, parcel: id }) })));
            return { parcel, parcelSourceId: result.parcelSourceId, areaM2: turf.area(parcel), designs, agreements, markets, buildings, history, planning, studies, urbanRules,
                economics: cityEconomics(args.city, locationOf(parcel)), landEstimate: landEstimateOf(args.city, parcel), previewUrl: mapUrl(args.city, bbox) };
        },
        async planningAreas({ city, point, source }) {
            if (!source || !Array.isArray(point) || point.length !== 2) throw failure('planning-area-query-required', 'Provide a planning source and WGS84 point.');
            return request('/planning/areas', { city, lon: point[0], lat: point[1], source });
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
