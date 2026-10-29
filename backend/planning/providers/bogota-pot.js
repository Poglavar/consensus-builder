// Bogotá POT (Decreto 555/2021) treatment and front-yard polygons, read live from the official
// cartography's public ArcGIS Online copy (IDE Cundinamarca, CC BY 4.0). Records are treatment
// areas carrying metric constraints; a parcel's front yard is read under the lot (parcelRecords).
import * as turf from '@turf/turf';
import { createPublicSourceFetch } from '../../parcels/public-source-fetch.js';
import { validateGeometry } from '../../parcels/source-contract.js';
import { withSourceProposal, sourceRevision } from '../source-proposal.js';
import { interpretTreatment, antejardinConstraint, BOGOTA_RULES } from './bogota-pot-rules.js';

export const BOGOTA_POT_SERVICE = 'https://services7.arcgis.com/lsxbLWF2l19Rmhqj/arcgis/rest/services/POT_Bogota_Decreto_555_2021/FeatureServer';
export const BOGOTA_POT_LAYERS = Object.freeze({ treatment: 15, antejardin: 22 });
export const bogotaPotSource = Object.freeze({
    id: 'bogota-pot-555', city: 'bogota', label: 'POT Bogotá · Decreto 555/2021', edition: '2021-12-29', default: true,
    kind: 'regulation', coverage: 'zoning-areas', scope: 'city',
    url: 'https://www.arcgis.com/home/item.html?id=ee7fed3b93dd4d52b8d00bcc81ce0ea0',
    storage: 'arcgis-online-feature-service', service: BOGOTA_POT_SERVICE, layers: BOGOTA_POT_LAYERS,
    issuer: 'Secretaría Distrital de Planeación de Bogotá',
    attribution: 'SDP Bogotá, POT Decreto 555/2021 · copy published by IDE Cundinamarca (IDEC) · CC BY 4.0',
    capabilities: { volumes: false, areas: true, parcelEvidence: false, constraintEvaluation: false },
    parcelSourceId: 'co-bogota-uaecd-lote', parcelStudy: 'direct-dimensions.v1',
    scenarios: ['general'], scenario: 'general'
});

const publicFetch = createPublicSourceFetch({ maxBytes: 64 * 1024 * 1024, timeoutMs: 60000 });
const upstream = message => Object.assign(new Error(message), { status: 503, code: 'planning-source-unavailable' });
const TTL_MS = 15 * 60 * 1000, FEATURE_CAP = 8000, READ_CAP = 128, COVER_CAP = 64;
const contains = (outer, inner) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const featureBounds = new WeakMap();
const boundsOf = feature => { if (!featureBounds.has(feature)) featureBounds.set(feature, turf.bbox(feature)); return featureBounds.get(feature); };
const spatialReference = Object.freeze({ horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' });

export function createBogotaPotProvider(descriptor = bogotaPotSource, { fetchImpl = publicFetch, now = Date.now } = {}) {
    const service = descriptor.service || BOGOTA_POT_SERVICE, layers = descriptor.layers || BOGOTA_POT_LAYERS;
    const features = new Map(), reads = new Map(), covers = [];
    function remember(layer, feature) {
        if (features.size >= FEATURE_CAP) features.delete(features.keys().next().value);
        features.set(`${layer}:${feature.properties.OBJECTID}`, { feature, at: now() });
    }
    function recalled(layer, objectId) {
        const entry = features.get(`${layer}:${objectId}`);
        return entry && now() - entry.at < TTL_MS ? entry.feature : null;
    }
    // One guarded read of a layer query. Features without usable geometry stay counted, never drawn.
    async function fetchLayer(layer, params) {
        const url = new URL(`${service}/${layer}/query`);
        for (const [key, value] of Object.entries({ f: 'geojson', outSR: '4326', outFields: '*', ...params })) url.searchParams.set(key, String(value));
        let payload;
        try {
            const response = await fetchImpl(url.href);
            if (!response.ok) throw new Error('status');
            payload = await response.json();
        } catch (_) { throw upstream('Bogotá POT service could not be read.'); }
        if (!payload || payload.error || payload.type !== 'FeatureCollection' || !Array.isArray(payload.features) || payload.features.length > 2001) {
            throw upstream('Bogotá POT service returned an invalid collection.');
        }
        const kept = [];
        let omitted = 0;
        for (const feature of payload.features) {
            const id = feature?.properties?.OBJECTID;
            if (feature?.type !== 'Feature' || !Number.isSafeInteger(id) || id < 0) throw upstream('Bogotá POT feature has no identity.');
            if (!validateGeometry(feature.geometry)) { omitted++; continue; }
            remember(layer, feature);
            kept.push(feature);
        }
        return { features: kept, omitted, more: payload.properties?.exceededTransferLimit === true };
    }
    function readBounds(layer, bbox, { after = null, count = 200 } = {}) {
        const key = JSON.stringify([layer, bbox, after, count]);
        const cached = reads.get(key);
        if (cached && now() - cached.at < TTL_MS) return cached.promise;
        const promise = fetchLayer(layer, { geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects', orderByFields: 'OBJECTID', resultRecordCount: count,
            where: after === null ? '1=1' : `OBJECTID > ${after}` }).catch(error => { reads.delete(key); throw error; });
        if (reads.size >= READ_CAP) reads.delete(reads.keys().next().value);
        reads.set(key, { at: now(), promise });
        return promise;
    }
    // Front-yard polygons covering an area, kept so every parcel of one envelope load reads the
    // same page. A page the service cut short covers nothing.
    function antejardinUnder(bbox) {
        const fresh = covers.find(cover => now() - cover.at < TTL_MS && contains(cover.bbox, bbox));
        if (fresh) return fresh.promise;
        const cover = { bbox, at: now(), promise: readBounds(layers.antejardin, bbox, { count: 2000 }).then(page => {
            if (page.more) { covers.splice(covers.indexOf(cover), 1); throw upstream('Bogotá front-yard map returned an incomplete page.'); }
            return page.features;
        }).catch(error => { const index = covers.indexOf(cover); if (index >= 0) covers.splice(index, 1); throw error; }) };
        if (covers.length >= COVER_CAP) covers.shift();
        covers.push(cover);
        return cover.promise;
    }
    function record(feature, displayGeometry, city = descriptor.city, scenario = descriptor.scenario) {
        const p = feature.properties, reading = interpretTreatment(p), recordId = String(p.OBJECTID);
        const id = `${descriptor.id}:${recordId}`;
        const site = validateGeometry(displayGeometry) ? displayGeometry : null;
        return withSourceProposal({
            id, role: 'permitted', title: `${reading.treatmentLabel} · ${reading.heightLabel}`,
            site, areas: site ? [{ id: `${id}:area`, geometry: site }] : [], volumes: [], spatialReference,
            source: { ...descriptor, city: city || descriptor.city, scenario, recordId,
                version: sourceRevision({ id: recordId, geometry: feature.geometry, properties: p }),
                publishedAt: Number.isFinite(p.FECHA_CAPTURA) ? new Date(p.FECHA_CAPTURA).toISOString().slice(0, 10) : null },
            authority: { effect: 'obligatory', basis: 'source-summary', applicability: 'unresolved' },
            assessment: { meaning: 'zoning-area', status: reading.status, reason: reading.reason,
                geometry: 'source-area', constraints: 'not-evaluated', current: true },
            metrics: { floorAreaM2: null, heightM: null },
            constraints: reading.constraints.map(constraint => ({ ...constraint, scenario })),
            sourceEvidence: { layer: 'treatment', serviceLayer: layers.treatment, properties: p,
                interpretation: { treatment: reading.treatment, tipologia: reading.tipologia, altura: reading.altura,
                    storeys: reading.storeys, heightM: reading.heightM, status: reading.status, reason: reading.reason },
                ...(reading.uplift ? { uplift: reading.uplift } : {}),
                rules: { decree: BOGOTA_RULES.decree, clearHeightM: BOGOTA_RULES.clearHeightM, slabM: BOGOTA_RULES.slabM,
                    storeyHeightM: BOGOTA_RULES.storeyHeightM, citations: [BOGOTA_RULES.storeyHeightCitation,
                        BOGOTA_RULES.rearSetbackCitation, BOGOTA_RULES.sideSetbackCitation, BOGOTA_RULES.antejardinCitation] } }
        });
    }
    // The same treatment record, carrying the parcel's own front-yard reading. Identity and
    // revision stay the treatment polygon's; the front-yard polygon's revision is evidence.
    function refine(item, reading) {
        const { proposal, proposalId, ...base } = item;
        return withSourceProposal({ ...base,
            constraints: reading.constraint ? [...base.constraints, { ...reading.constraint, scenario: base.source.scenario }] : base.constraints,
            sourceEvidence: { ...base.sourceEvidence, antejardin: reading.evidence } });
    }
    return {
        descriptor,
        async query(_pool, { bbox, limit, after = null, scenario = descriptor.scenario, city }) {
            if (after !== null && !/^\d{1,10}$/.test(String(after))) throw Object.assign(new Error('Invalid source cursor'), { status: 400 });
            const page = await readBounds(layers.treatment, bbox, { after, count: limit + 1 });
            // Front yards for the same area are fetched alongside; a failure surfaces on the parcel read.
            antejardinUnder(bbox).catch(() => {});
            const visible = page.features.slice(0, limit);
            const items = visible.map(feature => record(feature, turf.bboxClip(feature, bbox).geometry, city, scenario));
            const statuses = {};
            for (const item of items) statuses[item.assessment.status] = (statuses[item.assessment.status] || 0) + 1;
            const more = page.more || page.features.length + page.omitted > limit;
            return { items, nextAfter: more && visible.length ? String(visible.at(-1).properties.OBJECTID) : null, omitted: page.omitted,
                summary: { sourceId: descriptor.id, cachedResults: visible.length + page.omitted, withGeometry: visible.length,
                    withoutGeometry: page.omitted, statuses } };
        },
        async record(_pool, { recordId, city, scenario }) {
            if (!/^\d{1,10}$/.test(String(recordId))) return [];
            const feature = recalled(layers.treatment, recordId)
                || (await fetchLayer(layers.treatment, { objectIds: recordId })).features.find(item => String(item.properties.OBJECTID) === String(recordId));
            return feature ? [record(feature, feature.geometry, city, scenario)] : [];
        },
        async parcelRecords(parcel, records) {
            const bounds = turf.bbox(parcel);
            const candidates = (await antejardinUnder(bounds)).filter(feature => intersects(boundsOf(feature), bounds));
            let best = null;
            const failed = [];
            for (const feature of candidates) {
                let overlap;
                try { overlap = turf.intersect(turf.feature(parcel.geometry), feature); }
                catch (_) { failed.push(feature.properties.OBJECTID); continue; }
                const areaM2 = overlap ? turf.area(overlap) : 0;
                if (areaM2 > 0.01 && (!best || areaM2 > best.areaM2)) best = { feature, areaM2 };
            }
            const overlap = best ? { overlapM2: best.areaM2, overlapShare: best.areaM2 / turf.area(parcel),
                revision: sourceRevision(best.feature), ...(failed.length ? { unreadable: failed } : {}) } : null;
            return records.map(item => refine(item, best
                ? antejardinConstraint(best.feature.properties, overlap, item.sourceEvidence?.interpretation?.treatment)
                : { constraint: null, evidence: { objectId: null, dimensionM: null, candidates: candidates.length,
                    ...(failed.length ? { unreadable: failed } : {}) } }));
        }
    };
}
