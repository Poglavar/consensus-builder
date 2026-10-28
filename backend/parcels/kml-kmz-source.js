// Read a bounded KMZ member, retaining only native parcel IDs and unchanged KML polygon rings.
import { SaxesParser } from 'saxes';
import { readBoundedZipMembers } from './shapefile-zip-reader.js';
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
import { concatBytes } from './byte-utils.js';
import { upstreamError, validateGeometry } from './source-contract.js';

const KML = 'http://www.opengis.net/kml/2.2';
const fail = message => { throw upstreamError(message); };
const HARD_CAP = 16 * 1024 * 1024;

export function parseParcelKml(bytes, descriptor, { geometryOnly = false } = {}) {
    const field = descriptor.idFields?.[0];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field || '') || descriptor.idFields.length !== 1
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== field) fail('KML requires one safe native ID field.');
    if (bytes.byteLength > Math.min(descriptor.maxDecompressedBytes, HARD_CAP)) fail('KML exceeds byte limit.');
    const features = [], seen = new Set(), stack = [];
    const spanIds = descriptor.kmlIdEncoding === 'geoserver-span-string';
    let parcel = null, polygon = null, boundary = null, coordinates = null, description = null, nodes = 0, validRoot = false;
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => fail('KML document types are unsupported.'));
    parser.on('opentag', tag => {
        if (++nodes > 500000 || stack.length > 64) fail('KML exceeds structural limits.');
        stack.push(tag);
        if (stack.length === 1) validRoot = tag.uri === KML && tag.local === 'kml';
        if (tag.uri !== KML) return;
        // Some live WMS services suppress all attributes with KMATTR:false. Their
        // single-record CQL request supplies identity; never parse a popup as data.
        if (geometryOnly && ['description', 'ExtendedData', 'NetworkLink', 'GroundOverlay'].includes(tag.local)) fail('Geometry-only KML exposed attributes or indirect geometry.');
        if (tag.local === 'Placemark') {
            if (parcel) fail('Nested KML parcels are unsupported.');
            parcel = { polygons: [], id: null };
        }
        if (!parcel) return;
        if (['Point', 'LineString', 'Model', 'Track'].includes(tag.local)
            && !(tag.local === 'Point' && descriptor.kmlAllowLabelPoints === true && stack.at(-2)?.local === 'MultiGeometry')) fail('KML parcel has unsupported non-polygon geometry.');
        if (tag.local === 'description') description = '';
        if (tag.local === 'Polygon') {
            if (polygon) fail('Nested KML polygons are unsupported.');
            polygon = { outer: [], inner: [] };
        }
        if (['outerBoundaryIs', 'innerBoundaryIs'].includes(tag.local)) {
            if (!polygon || boundary) fail('Invalid KML polygon boundary.');
            boundary = tag.local === 'outerBoundaryIs' ? 'outer' : 'inner';
        }
        if (tag.local === 'coordinates') {
            if (descriptor.kmlAllowLabelPoints === true && stack.at(-2)?.local === 'Point') return;
            if (!boundary || stack.at(-2)?.local !== 'LinearRing' || coordinates !== null) fail('Invalid KML coordinate context.');
            coordinates = '';
        }
    });
    const text = value => {
        if (coordinates !== null) coordinates += value;
        else if (description !== null) description += value;
    };
    parser.on('text', text); parser.on('cdata', text);
    parser.on('closetag', tag => {
        stack.pop();
        if (tag.uri !== KML || !parcel) return;
        if (tag.local === 'description') {
            // The publisher embeds an HTML attribute table. Match only this native ID cell;
            // owner/value/address cells never enter the parsed collection or any evidence.
            const pattern = spanIds
                ? new RegExp(`<span\\b[^>]*>\\s*${field}\\s*</span>\\s*:</strong>\\s*<span\\b[^>]*>\\s*([A-Za-z0-9_:-]{1,128})\\s*</span>`, 'g')
                : new RegExp(`<td\\b[^>]*>\\s*${field}\\s*</td>\\s*<td\\b[^>]*>\\s*(0|[1-9][0-9]*)\\s*</td>`, 'g');
            const ids = [...description.matchAll(pattern)];
            if (ids.length !== 1 || parcel.id !== null || (!spanIds && !Number.isSafeInteger(Number(ids[0][1])))) fail('Missing or ambiguous KML native parcel ID.');
            parcel.id = spanIds ? ids[0][1] : Number(ids[0][1]); description = null;
        }
        if (tag.local === 'coordinates') {
            if (descriptor.kmlAllowLabelPoints === true && coordinates === null) return;
            const ring = coordinates.trim().split(/\s+/).map(tuple => {
                const values = tuple.split(',');
                if (![2, 3].includes(values.length) || values.some(value => !value.trim() || !Number.isFinite(Number(value)))) fail('Invalid KML coordinate.');
                return values.map(Number);
            });
            polygon[boundary].push(ring); coordinates = null;
        }
        if (['outerBoundaryIs', 'innerBoundaryIs'].includes(tag.local)) boundary = null;
        if (tag.local === 'Polygon') {
            if (polygon.outer.length !== 1) fail('KML polygon must have exactly one exterior.');
            parcel.polygons.push([polygon.outer[0], ...polygon.inner]); polygon = null;
        }
        if (tag.local === 'Placemark') {
            if ((!geometryOnly && (parcel.id === null || seen.has(parcel.id))) || !parcel.polygons.length) fail('Missing or repeated KML native parcel identity.');
            const geometry = parcel.polygons.length === 1 ? { type: 'Polygon', coordinates: parcel.polygons[0] }
                : { type: 'MultiPolygon', coordinates: parcel.polygons };
            if (!validateGeometry(geometry)) fail('KML parcel has invalid polygon structure.');
            features.push({ type: 'Feature', properties: geometryOnly ? {} : { [field]: parcel.id }, geometry });
            if (features.length > descriptor.maxSnapshotFeatures) fail('KML exceeds feature limit.');
            seen.add(parcel.id); parcel = null;
        }
    });
    try { parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close(); }
    catch (error) { if (error.status) throw error; fail('Invalid parcel KML.'); }
    if (!validRoot || (!features.length && descriptor.kmlAllowEmpty !== true)) fail('KML contains no parcel polygons.');
    return { type: 'FeatureCollection', features };
}

export function createKmlKmzParcelSource(descriptor, { fetchImpl = fetch, now = Date.now } = {}) {
    if (descriptor.kmlMember !== 'doc.kml'
        || ![descriptor.maxSnapshotBytes, descriptor.maxDecompressedBytes, descriptor.maxSnapshotFeatures].every(value => Number.isSafeInteger(value) && value > 0)
        || descriptor.maxSnapshotBytes > HARD_CAP || descriptor.maxDecompressedBytes > HARD_CAP) throw new Error('Invalid bounded KMZ descriptor.');
    // Reuse production snapshot indexing, exact-ID absence, spatial filtering and caching.
    return createGeojsonSnapshotParcelSource(descriptor, { now, fetchImpl: async (url, init) => {
        const response = await fetchImpl(url, { ...init, redirect: 'follow', headers: { ...init.headers, Accept: 'application/vnd.google-earth.kmz, application/octet-stream' } });
        if (!response.ok) return response;
        if (response.url && new URL(response.url).protocol !== 'https:') fail('KMZ redirected outside HTTPS.');
        const reader = response.body?.getReader();
        if (!reader) fail('KMZ returned no readable body.');
        const chunks = []; let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > descriptor.maxSnapshotBytes) fail('KMZ exceeds streamed byte limit.');
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const members = readBoundedZipMembers(concatBytes(chunks, size), { ...descriptor, zipEncoding: 'utf-8' }, () => ({ kml: descriptor.kmlMember }));
        const collection = parseParcelKml(members.kml, descriptor);
        const headers = { 'Content-Type': 'application/geo+json' };
        if (response.headers.get('etag')) headers.ETag = response.headers.get('etag');
        return new Response(JSON.stringify(collection), { status: 200, headers });
    } });
}
