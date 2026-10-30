// A city model file at a public URL (CityJSON or CityGML) as a person's building source: the whole file
// read once and pinned by the SHA-256 of its bytes, its buildings as footprints with their height and storeys, read by
// the building editors' rule (city-model-reader.js footprintFeatures), and their own surfaces for the 3D
// view (`lod2`, the reader's mesh record: the view stands each building on the terrain by its lowest
// point, so the file's height datum does not matter). One module for discovery, the
// server's reader (custom-source-3d.js) and the browser's adapter worker (browser-building-cells.js).
// No Node imports. The pin is a hash, not an ETag: a browser reads no ETag the host does not expose.
// Named Turf functions only: the reader is handed just what it calls, so the worker bundle stays small.
import { area, bbox as extentOf, bboxPolygon, booleanIntersects, polygon, union } from '@turf/turf';
import proj4 from 'proj4';
import CityModelReader from '../../frontend/js/city-model-reader.js';
import { parseCityGml } from './citygml.js';
import { upstreamError, providerHttpError } from '../parcels/source-contract.js';

// A file URL that may hold a city model; the content decides.
export const looksLikeCityModelFile = url => /\.(?:json|gml|xml)$/i.test(new URL(url).pathname);

const unreadable = message => upstreamError(message, 422, 'no-available-adapter');

// The text of a city model → its buildings as footprint features ({ id, geometry, properties:
// { measured_height_m, levels, building, use?, lod2? } }) and their WGS84 extent; null when the text is
// no city model. lod2 is { z_min, z_max, faces } in metres.
export function cityModelFootprints(text, { idPrefix = '' } = {}) {
    const model = CityModelReader.readCityModel(text, { parseGml: parseCityGml });
    if (!model) return null;
    const transform = proj4(model.crs.definition, 'EPSG:4326');
    const toLngLat = (x, y) => transform.forward([x, y]);
    const { features } = CityModelReader.footprintFeatures(model, { toLngLat, turf: { polygon, union, area } });
    const surfaces = new Map(model.buildings.filter(building => building.id).map(building => [String(building.id), building]));
    const seen = new Set();
    const buildings = features.map((feature, index) => {
        let id = feature.id || `building-${index}`;
        if (seen.has(id)) id = `${id}-${index}`;
        seen.add(id);
        const source = feature.id ? surfaces.get(feature.id) : null;
        const mesh = source ? CityModelReader.buildingRecord(source, toLngLat, { zToMetres: model.crs.zToMetres }) : null;
        return { type: 'Feature', id: idPrefix + id, geometry: feature.geometry, properties: {
            measured_height_m: feature.properties.height > 0 ? feature.properties.height : null,
            levels: feature.properties.storeys || null, building: null,
            ...(feature.properties.use ? { use: feature.properties.use } : {}),
            ...(mesh ? { lod2: { z_min: mesh.record.z_min, z_max: mesh.record.z_max, faces: mesh.record.faces } } : {}) } };
    });
    return { format: model.format, features: buildings, bbox: buildings.length ? extentOf({ type: 'FeatureCollection', features: buildings }) : null };
}

const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

// The file at descriptor.endpoint, read once: refused when it is over the size limit, when its bytes are
// not the ones it was added with (descriptor.expectedSha256), or when it is no city model.
export async function readCityModelFile(descriptor, { fetchImpl, signal } = {}) {
    const response = await fetchImpl(descriptor.endpoint, { signal,
        headers: { Accept: 'application/city+json, application/json, application/gml+xml, application/xml, text/xml' } });
    if (!response?.ok || response.status !== 200) throw providerHttpError(response || 502);
    const limit = descriptor.maxSnapshotBytes;
    if (Number(response.headers?.get?.('content-length')) > limit) throw unreadable(`The city model file is over the ${limit / 1048576} MiB limit.`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > limit) throw unreadable(`The city model file is over the ${limit / 1048576} MiB limit.`);
    const sha256 = hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    if (descriptor.expectedSha256 && sha256 !== descriptor.expectedSha256) {
        throw upstreamError('The city model file has changed since it was added. Add the source again to read the new file.', 409, 'city-model-changed');
    }
    const read = cityModelFootprints(new TextDecoder().decode(bytes), { idPrefix: descriptor.idPrefix || '' });
    if (!read) throw upstreamError('The file is not a CityJSON or CityGML city model.', 422, 'not-city-model');
    if (read.features.length > descriptor.maxSnapshotFeatures) throw unreadable(`The city model holds more than ${descriptor.maxSnapshotFeatures} buildings.`);
    return { ...read, sha256 };
}

// The adapter: queryBounds answers every building touching the box, from the one read of the file.
export function createCityModelAdapter(descriptor, { fetchImpl }) {
    let loaded = null;
    const load = signal => {
        loaded ||= readCityModelFile(descriptor, { fetchImpl, signal }).catch(error => { loaded = null; throw error; });
        return loaded;
    };
    return {
        async queryBounds(bbox, { signal } = {}) {
            const { features } = await load(signal);
            const box = bboxPolygon(bbox);
            return { type: 'FeatureCollection', features: features.filter(feature => booleanIntersects(feature, box)), complete: true };
        }
    };
}
