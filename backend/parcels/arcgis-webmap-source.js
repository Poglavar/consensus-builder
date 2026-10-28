// Finite embedded FeatureCollections are snapshots, not FeatureServer query endpoints.
import proj4 from 'proj4';
import { booleanPointInPolygon, lineIntersect, lineString, point, polygon } from '@turf/turf';
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
import { upstreamError, validateGeometry } from './source-contract.js';

function referenceCode(reference) {
    const code = reference?.latestWkid ?? reference?.wkid;
    if (![4326, 3857, 102100, 102113].includes(code)
        || [reference?.wkid, reference?.latestWkid].some(value => value !== undefined
            && (code === 4326 ? value !== 4326 : ![3857, 102100, 102113].includes(value)))) {
        throw upstreamError('Unsupported embedded parcel spatial reference.');
    }
    return code === 4326 ? 4326 : 3857;
}

export function webmapParcelCollection(payload, descriptor) {
    const layers = (payload?.operationalLayers || []).flatMap(layer => layer.featureCollection?.layers || []);
    const matches = layers.filter(layer => layer.layerDefinition?.name === descriptor.webmapLayerName);
    if (payload?.error || matches.length !== 1) throw upstreamError('Embedded parcel layer is missing or ambiguous.');
    const { layerDefinition: definition, featureSet } = matches[0];
    if (definition.geometryType !== 'esriGeometryPolygon' || featureSet?.geometryType !== 'esriGeometryPolygon'
        || definition.objectIdField !== descriptor.objectIdField || definition.hasZ || definition.hasM
        || featureSet.exceededTransferLimit === true || !Array.isArray(featureSet.features)
        || featureSet.features.length > (descriptor.maxSnapshotFeatures ?? 5000)) {
        throw upstreamError('Invalid embedded parcel collection.');
    }
    const collectionReference = featureSet.spatialReference || definition.extent?.spatialReference;
    const idField = descriptor.idField || descriptor.objectIdField;
    const seen = new Set();
    return { type: 'FeatureCollection', features: featureSet.features.flatMap(feature => {
        const nativeId = feature?.attributes?.[idField];
        // Some authored collections contain an empty editor row. Only an explicitly
        // enabled, geometry-less row with a present but blank parcel ID is ignored.
        // Numeric editor defaults need not be blank. An identified parcel always fails.
        if (descriptor.skipBlankRecords === true && feature?.geometry == null
            && Object.hasOwn(feature?.attributes || {}, idField)
            && (nativeId == null || (typeof nativeId === 'string' && !nativeId.trim()))) return [];
        const validId = descriptor.idType === 'string'
            ? typeof nativeId === 'string' && nativeId.length > 0 && nativeId.length <= 256 && nativeId.trim() === nativeId
                && (!descriptor.idPattern || new RegExp(descriptor.idPattern).test(nativeId))
            : Number.isSafeInteger(nativeId) && nativeId >= 0;
        if (!validId || seen.has(nativeId)) {
            throw upstreamError('Invalid or repeated embedded parcel identity.');
        }
        seen.add(nativeId);
        const geometry = feature.geometry;
        if (!geometry || geometry.curveRings !== undefined || geometry.hasZ || geometry.hasM
            || !Array.isArray(geometry.rings) || !geometry.rings.length) {
            throw upstreamError('Unsupported embedded parcel geometry.');
        }
        const code = referenceCode(geometry.spatialReference || collectionReference);
        const shells = [], holes = [];
        for (const nativeRing of geometry.rings) {
            if (!Array.isArray(nativeRing) || nativeRing.length < 4
                || nativeRing.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))
                || nativeRing[0][0] !== nativeRing.at(-1)[0] || nativeRing[0][1] !== nativeRing.at(-1)[1]) {
                throw upstreamError('Invalid embedded parcel ring.');
            }
            const [x, y] = nativeRing[0];
            const signedArea = nativeRing.slice(1).reduce((sum, p, index) => sum
                + (nativeRing[index][0] - x) * (p[1] - y) - (p[0] - x) * (nativeRing[index][1] - y), 0);
            const ring = nativeRing.map(p => code === 4326 ? [...p] : proj4('EPSG:3857', 'EPSG:4326', p));
            if (!validateGeometry({ type: 'Polygon', coordinates: [ring] })) throw upstreamError('Invalid projected parcel ring.');
            // Esri clockwise shells and counterclockwise holes. Retain zero-area native
            // components separately, including repeated vertices; never repair or drop them.
            if (signedArea <= 0) shells.push({ ring, signedArea, holes: [] });
            else holes.push(ring);
        }
        if (!shells.length) throw upstreamError('Embedded parcel has no exterior ring.');
        for (const hole of holes) {
            const containers = shells.filter(shell => shell.signedArea < 0
                && hole.slice(0, -1).every(p => booleanPointInPolygon(point(p), polygon([shell.ring]), { ignoreBoundary: true }))
                && lineIntersect(lineString(hole), lineString(shell.ring)).features.length === 0);
            if (containers.length !== 1) throw upstreamError('Embedded parcel has an ambiguous hole.');
            containers[0].holes.push(hole);
        }
        const coordinates = shells.map(shell => [shell.ring, ...shell.holes]);
        return [{ type: 'Feature', properties: { [idField]: nativeId },
            geometry: coordinates.length === 1 ? { type: 'Polygon', coordinates: coordinates[0] }
                : { type: 'MultiPolygon', coordinates } }];
    }) };
}

export function createArcgisWebmapParcelSource(descriptor, { fetchImpl = fetch, now = Date.now } = {}) {
    const idField = descriptor.idField || descriptor.objectIdField;
    if (!descriptor.webmapLayerName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(descriptor.objectIdField || '')
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(idField || '')
        || ![undefined, 'number', 'string'].includes(descriptor.idType)
        || (descriptor.skipBlankRecords !== undefined && typeof descriptor.skipBlankRecords !== 'boolean')
        || descriptor.idFields?.length !== 1 || descriptor.idFields[0] !== idField
        || descriptor.outFields?.length !== 1 || descriptor.outFields[0] !== idField) {
        throw new Error('Invalid embedded Web Map parcel descriptor.');
    }
    const maxBytes = descriptor.maxSnapshotBytes ?? 3 * 1024 * 1024;
    // Reuse the snapshot adapter's indexing, canonical IDs, limits, cache and exact reads.
    return createGeojsonSnapshotParcelSource(descriptor, { now, fetchImpl: async (url, init) => {
        const response = await fetchImpl(url, init);
        if (!response.ok) return response;
        if (response.url && new URL(response.url).protocol !== 'https:') throw upstreamError('Web Map redirected outside HTTPS.');
        if (Number(response.headers.get('content-length')) > maxBytes) throw upstreamError('Web Map exceeds byte limit.');
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('Web Map has no readable body.');
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) throw upstreamError('Web Map exceeds byte limit.');
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw upstreamError('Invalid Web Map JSON.'); }
        const collection = webmapParcelCollection(payload, descriptor);
        const headers = { 'Content-Type': 'application/geo+json' };
        if (response.headers.get('etag')) headers.ETag = response.headers.get('etag');
        return new Response(JSON.stringify(collection), { status: 200, headers });
    } });
}
