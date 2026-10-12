// Agenzia delle Entrate (Italy) national INSPIRE CP WFS reader: MapServer GML 3.2 in EPSG:6706 lat,lon order.
// Only the validated national cadastral reference, its ID parts and published geometry leave this module.
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { SaxesParser } from 'saxes';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';

const ENDPOINT = 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php';
const TYPE_NAME = 'CP:CadastralParcel';
const FEATURE_NS = 'http://mapserver.gis.umn.edu/mapserver';
const WFS_NS = 'http://www.opengis.net/wfs/2.0';
const GML_NS = 'http://www.opengis.net/gml/3.2';
const FES_NS = 'http://www.opengis.net/fes/2.0';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const CRS_URN = 'urn:ogc:def:crs:EPSG::6706';
const INSPIRE_NAMESPACE = 'IT.AGE.PLA.';
const GML_ID_PREFIX = 'CadastralParcel.';
const ID_FIELD = 'NATIONALCADASTRALREFERENCE';
const ID_PREFIX = 'IT-AE-';
// Comune (Belfiore code) + sezione ('_' when none) + foglio + allegato + sviluppo, then the parcel label.
// Observed: H501A048700.1 (Rome), F205_039000.STRADA002 (Milan), F839_008600.116 (Naples).
const REFERENCE = /^([A-Z][0-9]{3})[A-Z_][0-9]{4}[0-9A-Z]{2}\.([0-9A-Z]{1,16})$/;
const FIELDS = ['INSPIREID_LOCALID', 'INSPIREID_NAMESPACE', 'LABEL', ID_FIELD, 'ADMINISTRATIVEUNIT'];
const OUT_FIELDS = [ID_FIELD, 'ADMINISTRATIVEUNIT', 'LABEL'];
const GEOMETRY_CHILDREN = Object.freeze({
    msGeometry: ['Polygon', 'MultiSurface'], MultiSurface: ['surfaceMember'], surfaceMember: ['Polygon'],
    Polygon: ['exterior', 'interior'], exterior: ['LinearRing'], interior: ['LinearRing'], LinearRing: ['posList'], posList: []
});
const SINGLE_CHILD = new Set(['msGeometry', 'surfaceMember', 'exterior', 'interior', 'LinearRing']);
// Generous national envelope (Lampedusa to Vetta d'Italia, Alps to Otranto). A swapped
// lon,lat pair falls outside it, so an axis-order change cannot pass silently.
const LAT_RANGE = [35, 47.5], LON_RANGE = [6, 19];
const MAX_OPERATION_MS = 60000;
const MAX_OPERATION_REQUESTS = 32;

function fail(message, status = 502) { throw upstreamError(message, status); }
const attribute = (tag, name, uri = '') => Object.values(tag.attributes).find(item => item.local === name && (item.uri || '') === uri)?.value;
const nativeOf = id => typeof id === 'string' && id.startsWith(ID_PREFIX) && REFERENCE.test(id.slice(ID_PREFIX.length)) ? id.slice(ID_PREFIX.length) : null;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function validDescriptor(d) {
    const int = (value, min, max) => value === undefined || (Number.isSafeInteger(value) && value >= min && value <= max);
    return d && d.adapter === 'it-agenzia-entrate-wfs' && typeof d.id === 'string' && d.id.length > 0
        && d.endpoint === ENDPOINT && d.featureType === TYPE_NAME && d.responseCrs === 'EPSG:6706'
        && d.idField === ID_FIELD && d.idPrefix === ID_PREFIX && d.idType === 'string' && d.parcelNumberField === 'LABEL'
        && Array.isArray(d.outFields) && d.outFields.length === OUT_FIELDS.length && OUT_FIELDS.every((field, i) => d.outFields[i] === field)
        && (d.maxBboxKm2 === undefined || (Number.isFinite(d.maxBboxKm2) && d.maxBboxKm2 > 0 && d.maxBboxKm2 <= 1))
        && int(d.maxFeatures, 1, 5000) && int(d.idBatchSize, 1, 8) && int(d.paceMs, 1000, 10000)
        && int(d.maxResponseBytes, 1, 16 * 1024 * 1024) && int(d.maxTotalResponseBytes, 1, 32 * 1024 * 1024)
        && int(d.timeoutMs, 100, 30000);
}

// Parse one WFS 2.0 reply strictly. Service exceptions, truncation markers, unknown feature
// content, referenced or nil geometry and identity disagreements make the reply unavailable.
export function parseAgenziaEntrateCollection(xml) {
    const parser = new SaxesParser({ xmlns: true });
    const stack = [];
    const features = [], seen = new Set();
    let root = null, closed = false, numberMatched, numberMatchedUnknown = false, numberReturned, timeStamp;
    let current = null, polygon = null, ring = null, geometryCrs = null;
    parser.on('doctype', () => fail('Agenzia WFS document types are forbidden.'));
    parser.on('processinginstruction', () => fail('Agenzia WFS processing instructions are unsupported.'));
    parser.on('cdata', () => fail('Agenzia WFS CDATA is unsupported.'));
    parser.on('error', () => fail('Agenzia WFS returned malformed XML.'));
    parser.on('opentag', tag => {
        const parent = stack.at(-1);
        const frame = { tag, text: '', children: 0 };
        if (parent) parent.children++;
        stack.push(frame);
        if (attribute(tag, 'href', XLINK_NS) !== undefined) fail('Agenzia WFS referenced content is unsupported.');
        const nil = attribute(tag, 'nil', XSI_NS);
        if (nil !== undefined && !['false', '0'].includes(nil)) fail('Agenzia WFS nil content is unsupported.');
        if (!parent) {
            if (tag.local === 'ExceptionReport' || tag.local === 'ServiceExceptionReport') fail('Agenzia WFS returned a service exception.');
            if (tag.uri !== WFS_NS || tag.local !== 'FeatureCollection') fail('Agenzia WFS reply is not a WFS 2.0 FeatureCollection.');
            root = tag;
            const matched = attribute(tag, 'numberMatched'), returned = attribute(tag, 'numberReturned');
            numberMatchedUnknown = matched === 'unknown';
            if (!numberMatchedUnknown) {
                if (!/^(?:0|[1-9][0-9]{0,8})$/.test(matched || '')) fail('Agenzia WFS reply has no valid numberMatched.');
                numberMatched = Number(matched);
            }
            if (!/^(?:0|[1-9][0-9]{0,8})$/.test(returned || '')) fail('Agenzia WFS reply has no valid numberReturned.');
            numberReturned = Number(returned);
            timeStamp = attribute(tag, 'timeStamp');
            return;
        }
        const depth = stack.length;
        if (depth === 2) {
            // wfs:truncatedResponse, additionalObjects or anything else is never a complete parcel set.
            if (tag.uri !== WFS_NS || !['boundedBy', 'member'].includes(tag.local)) fail('Agenzia WFS reply has unexpected collection content.');
            return;
        }
        if (stack[1].tag.local === 'boundedBy') return;
        if (depth === 3) {
            if (tag.uri !== FEATURE_NS || tag.local !== 'CadastralParcel' || parent.children !== 1) fail('Agenzia WFS member is not one CP:CadastralParcel.');
            current = { gmlId: attribute(tag, 'id', GML_NS), fields: {}, polygons: [], geometrySeen: false };
            return;
        }
        if (depth === 4) {
            if (tag.uri === GML_NS && tag.local === 'boundedBy') return;
            if (tag.uri !== FEATURE_NS || !(FIELDS.includes(tag.local) || tag.local === 'msGeometry')) fail('Agenzia WFS parcel has an unexpected field.');
            if (tag.local === 'msGeometry') {
                if (current.geometrySeen) fail('Agenzia WFS parcel repeats its geometry.');
                current.geometrySeen = true;
                frame.geometry = true;
                geometryCrs = null;
            } else if (Object.hasOwn(current.fields, tag.local)) fail('Agenzia WFS parcel repeats an identity field.');
            else current.fields[tag.local] = null;
            return;
        }
        const field = stack[3].tag;
        if (field.uri === GML_NS && field.local === 'boundedBy') return;
        if (field.local !== 'msGeometry') fail('Agenzia WFS identity fields must be simple text.');
        if (tag.uri !== GML_NS || !GEOMETRY_CHILDREN[parent.tag.local]?.includes(tag.local)) fail('Agenzia WFS parcel geometry has an unsupported structure.');
        if (SINGLE_CHILD.has(parent.tag.local) && parent.children > 1) fail('Agenzia WFS parcel geometry repeats a single component.');
        if (tag.local === 'exterior' && parent.children !== 1) fail('Agenzia WFS polygon exterior must be its first and only exterior ring.');
        if (tag.local === 'interior' && !polygon?.exterior) fail('Agenzia WFS polygon interior precedes its exterior.');
        const srs = attribute(tag, 'srsName');
        if (depth === 5) {
            if (srs !== CRS_URN) fail('Agenzia WFS parcel geometry is not declared in EPSG:6706.');
            geometryCrs = srs;
        } else if (srs !== undefined && srs !== geometryCrs) fail('Agenzia WFS parcel geometry mixes coordinate systems.');
        const dimension = attribute(tag, 'srsDimension');
        if (dimension !== undefined && dimension !== '2') fail('Agenzia WFS parcel geometry must be two-dimensional.');
        if (tag.local === 'Polygon') polygon = { exterior: null, interiors: [] };
        if (tag.local === 'exterior' || tag.local === 'interior') ring = tag.local;
    });
    parser.on('text', text => {
        const frame = stack.at(-1);
        if (!frame) { if (text.trim()) fail('Agenzia WFS reply has text outside its collection.'); return; }
        const inBoundedBy = stack[1]?.tag.local === 'boundedBy' || (stack[3]?.tag.uri === GML_NS && stack[3]?.tag.local === 'boundedBy');
        if (inBoundedBy) return;
        if ((stack.length === 4 && FIELDS.includes(frame.tag.local)) || frame.tag.local === 'posList') {
            frame.text += text;
            if (frame.text.length > 4 * 1024 * 1024) fail('Agenzia WFS text exceeds its limit.');
        } else if (text.trim()) fail('Agenzia WFS reply has unexpected text.');
    });
    parser.on('closetag', tag => {
        const frame = stack.pop();
        const depth = stack.length + 1;
        if (depth === 1) { closed = true; return; }
        if (depth === 2 && tag.local === 'member' && frame.children !== 1) fail('Agenzia WFS member is not one CP:CadastralParcel.');
        if (!current) return;
        if (depth === 4 && FIELDS.includes(tag.local) && tag.uri === FEATURE_NS) {
            const value = frame.text.trim();
            if (!value || value.length > 64 || /[^\x21-\x7e]/.test(value)) fail('Agenzia WFS parcel has an invalid identity field.');
            current.fields[tag.local] = value;
            return;
        }
        if (tag.uri === GML_NS && stack.length >= 4 && stack[3].tag.local === 'msGeometry') {
            if (tag.local === 'posList') {
                const tokens = frame.text.trim().split(/\s+/);
                if (tokens.length < 8 || tokens.length % 2) fail('Agenzia WFS ring has an invalid coordinate list.');
                if (Number(tokens[0]) !== Number(tokens.at(-2)) || Number(tokens[1]) !== Number(tokens.at(-1))) fail('Agenzia WFS ring is not closed as published.');
                const points = [];
                for (let i = 0; i < tokens.length; i += 2) {
                    if (!/^-?\d+(?:\.\d+)?$/.test(tokens[i]) || !/^-?\d+(?:\.\d+)?$/.test(tokens[i + 1])) fail('Agenzia WFS ring has non-numeric coordinates.');
                    const lat = Number(tokens[i]), lon = Number(tokens[i + 1]);
                    if (lat < LAT_RANGE[0] || lat > LAT_RANGE[1] || lon < LON_RANGE[0] || lon > LON_RANGE[1]) fail('Agenzia WFS coordinates fall outside Italy (axis order changed?).');
                    // EPSG:6706 (RDN2008/ETRF2000) is served as WGS84 without a datum shift, like other ETRS89 sources.
                    points.push([lon, lat]);
                }
                if (ring === 'exterior') polygon.exterior = points; else polygon.interiors.push(points);
            } else if (tag.local === 'exterior' || tag.local === 'interior') {
                if (frame.children !== 1) fail('Agenzia WFS ring element is empty.');
                ring = null;
            } else if (tag.local === 'LinearRing') {
                if (frame.children !== 1) fail('Agenzia WFS ring has no coordinate list.');
            } else if (tag.local === 'Polygon') {
                if (!polygon?.exterior) fail('Agenzia WFS polygon has no exterior ring.');
                current.polygons.push([polygon.exterior, ...polygon.interiors]);
                polygon = null;
            } else if (frame.children === 0) fail('Agenzia WFS parcel geometry has an empty component.');
            return;
        }
        if (depth === 4 && tag.local === 'msGeometry' && frame.children !== 1) fail('Agenzia WFS parcel geometry is empty.');
        if (depth === 3) {
            const { gmlId, fields, polygons, geometrySeen } = current;
            const reference = fields[ID_FIELD];
            const match = REFERENCE.exec(reference || '');
            if (!geometrySeen || !polygons.length || FIELDS.some(field => typeof fields[field] !== 'string') || !match
                || fields.ADMINISTRATIVEUNIT !== match[1] || fields.LABEL !== match[2]
                || fields.INSPIREID_NAMESPACE !== INSPIRE_NAMESPACE || fields.INSPIREID_LOCALID !== INSPIRE_NAMESPACE + reference
                || gmlId !== GML_ID_PREFIX + fields.INSPIREID_LOCALID) {
                fail('Agenzia WFS parcel identities or geometry do not agree.');
            }
            if (seen.has(reference)) fail('Agenzia WFS reply repeats a national cadastral reference.');
            seen.add(reference);
            const geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
            if (!validateGeometry(geometry)) fail('Agenzia WFS parcel geometry is invalid.');
            features.push({ type: 'Feature', id: reference, geometry,
                properties: { [ID_FIELD]: reference, ADMINISTRATIVEUNIT: fields.ADMINISTRATIVEUNIT, LABEL: fields.LABEL } });
            current = null;
        }
    });
    try { parser.write(xml).close(); }
    catch (error) { if (error.status) throw error; fail('Agenzia WFS returned malformed XML.'); }
    if (!root || !closed || current) fail('Agenzia WFS reply is incomplete.');
    if (numberReturned !== features.length) fail('Agenzia WFS numberReturned does not match its members.');
    return { features, numberMatched, numberMatchedUnknown, numberReturned, timeStamp };
}

export function createAgenziaEntrateWfsParcelSource(descriptor, { fetchImpl = globalThis.fetch, waitImpl = delay, now = Date.now } = {}) {
    if (!validDescriptor(descriptor) || typeof fetchImpl !== 'function' || typeof waitImpl !== 'function') {
        throw new Error('Invalid Agenzia delle Entrate WFS descriptor.');
    }
    const maxFeatures = descriptor.maxFeatures ?? 2000;
    const idBatchSize = descriptor.idBatchSize ?? 8;
    const paceMs = descriptor.paceMs ?? 1000;
    const maxResponseBytes = descriptor.maxResponseBytes ?? 8 * 1024 * 1024;
    const maxTotalResponseBytes = descriptor.maxTotalResponseBytes ?? 16 * 1024 * 1024;
    const timeoutMs = descriptor.timeoutMs ?? 20000;
    // One slot per adapter instance: request starts are at least paceMs apart, even for concurrent callers.
    let nextSlot = 0;

    async function readBody(response, budget) {
        const declared = response.headers.get('content-length');
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxResponseBytes)) fail('Agenzia WFS reply exceeds the byte limit; use a smaller area.');
        const reader = response.body?.getReader();
        if (!reader) fail('Agenzia WFS returned no readable reply.');
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const item = await reader.read();
                if (item.done) break;
                size += item.value.byteLength;
                if (size > maxResponseBytes || budget.bytes + size > maxTotalResponseBytes) {
                    try { await reader.cancel(); } catch { /* Stream may already be closed. */ }
                    fail('Agenzia WFS reply exceeds the byte limit; use a smaller area.');
                }
                chunks.push(item.value);
            }
        } finally { reader.releaseLock(); }
        if (declared && !response.headers.get('content-encoding') && Number(declared) !== size) fail('Agenzia WFS reply body is incomplete.');
        budget.bytes += size;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { return fail('Agenzia WFS reply is not valid UTF-8.'); }
    }

    async function request(spec, budget) {
        if (++budget.requests > MAX_OPERATION_REQUESTS) fail('Agenzia WFS operation exceeds the request limit.');
        const slot = Math.max(now(), nextSlot);
        nextSlot = slot + paceMs;
        if (slot >= budget.deadline) fail('Agenzia WFS operation timed out.', 504);
        if (slot > now()) await waitImpl(slot - now());
        const remaining = budget.deadline - now();
        if (remaining <= 0) fail('Agenzia WFS operation timed out.', 504);
        const params = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature',
            typeNames: TYPE_NAME, srsName: CRS_URN, ...spec });
        const signal = AbortSignal.timeout(Math.min(timeoutMs, remaining));
        try {
            const response = await fetchImpl(`${ENDPOINT}?${params}`, { signal, redirect: 'error',
                headers: { Accept: 'application/gml+xml; version=3.2, application/xml, text/xml' } });
            if (!response.ok) {
                try { await response.body?.cancel(); } catch { /* Body may already be closed. */ }
                throw providerHttpError(response);
            }
            const contentType = response.headers.get('content-type') || '';
            if (!/(?:xml|gml)/i.test(contentType)) fail('Agenzia WFS returned a non-XML reply.');
            return parseAgenziaEntrateCollection(await readBody(response, budget));
        } catch (error) {
            if (error.status) throw error;
            if (signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name)) fail('Agenzia WFS request timed out.', 504);
            return fail('Agenzia WFS is unavailable.');
        }
    }

    // A hits count, then one data page sized one larger than that count. The page must
    // return exactly the counted set: a server cap, truncation or a concurrent change
    // (more or fewer rows) leaves the area unavailable instead of silently partial.
    async function readComplete(spec, budget, expectedIds = null) {
        const hits = await request({ ...spec, resultType: 'hits' }, budget);
        if (hits.numberMatched === undefined || hits.numberReturned !== 0 || hits.features.length) fail('Agenzia WFS did not provide a complete hit count.');
        const matched = hits.numberMatched;
        if (matched > maxFeatures) fail('Agenzia WFS query exceeds the configured parcel limit; use a smaller area.');
        const page = await request({ ...spec, count: String(matched + 1) }, budget);
        if (page.numberReturned !== matched || page.features.length !== matched
            || (!page.numberMatchedUnknown && page.numberMatched !== matched)) {
            fail('Agenzia WFS did not return its complete matched set.');
        }
        if (expectedIds && page.features.some(feature => !expectedIds.has(feature.id))) fail('Agenzia WFS returned an unexpected native parcel.');
        return { features: page.features.map(feature => canonicalParcelFeature(descriptor, feature, feature.id)),
            evidence: { numberMatched: matched, numberReturned: page.numberReturned, dataNumberMatched: page.numberMatchedUnknown ? 'unknown' : page.numberMatched } };
    }

    const budget = () => ({ deadline: now() + MAX_OPERATION_MS, requests: 0, bytes: 0 });
    const result = (features, extra) => ({ type: 'FeatureCollection', features, complete: true,
        sourceId: descriptor.id, returnsWGS84: true, ...extra });

    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 0.25, descriptor);
        const [west, south, east, north] = bounds;
        const read = await readComplete({ bbox: `${south},${west},${north},${east},${CRS_URN}` }, budget());
        const shape = bboxPolygon(bounds);
        return result(read.features.filter(feature => booleanIntersects(feature, shape)),
            { numberMatched: read.evidence.numberMatched, completenessEvidence: read.evidence });
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80) throw new HttpError(400, 'Provide between 1 and 80 parcel IDs.');
        const unique = [...new Set(ids)];
        if (unique.some(id => nativeOf(id) === null)) throw new HttpError(400, 'Invalid Italian cadastral parcel ID or different source.');
        const operation = budget();
        const features = [], absentIds = [], completenessEvidence = [];
        for (let offset = 0; offset < unique.length; offset += idBatchSize) {
            const batch = unique.slice(offset, offset + idBatchSize);
            const natives = batch.map(nativeOf);
            const comparisons = natives.map(native => `<fes:PropertyIsEqualTo matchCase="true"><fes:ValueReference>CP:${ID_FIELD}</fes:ValueReference><fes:Literal>${native}</fes:Literal></fes:PropertyIsEqualTo>`);
            const filter = `<fes:Filter xmlns:fes="${FES_NS}" xmlns:CP="${FEATURE_NS}">${comparisons.length === 1 ? comparisons[0] : `<fes:Or>${comparisons.join('')}</fes:Or>`}</fes:Filter>`;
            const read = await readComplete({ filter }, operation, new Set(natives));
            const found = new Set(read.features.map(feature => feature.properties.sourceParcelId));
            features.push(...read.features);
            // Absence is only what a counted, complete exact reply left out.
            absentIds.push(...batch.filter(id => !found.has(nativeOf(id))));
            completenessEvidence.push(read.evidence);
        }
        return result(features, { absentIds, completenessEvidence });
    }

    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a valid WGS84 Polygon or MultiPolygon.');
        const footprint = geoFeature(geometry);
        const bounds = await queryBounds(geometryBbox(footprint));
        return { ...bounds, features: bounds.features.filter(parcel => booleanIntersects(parcel, footprint)) };
    }

    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
