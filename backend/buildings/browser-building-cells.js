// The adapter worker's building cells: a URL building source (`building.<base64url>`) read straight
// from its public service in the browser, never through our server (docs/source-loading-plan.md, F3).
// A service that lets no other site read it (no CORS) cannot be read here; discovery refuses it.
import { browserParcelFactories } from '../parcels/browser-source-runtime.js';
import { withSourceControls } from '../parcels/source-controls.js';
import { areaLimitError, upstreamError } from '../parcels/source-contract.js';
import { buildOverpassQuery, overpassElementsToGeoJSON } from './osm-reference.js';
import { decodeBuildingSourceId, readBuildingCell } from './building-cell-read.js';

// An OpenStreetMap (Overpass) mirror read as an adapter: one query per box; an answer at the feature
// cap is over the box's limit, so the reader splits it.
function createOverpassAdapter(descriptor, { fetchImpl }) {
    return {
        async queryBounds(bbox, { signal } = {}) {
            const response = await fetchImpl(descriptor.endpoint, { method: 'POST', signal,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `data=${encodeURIComponent(buildOverpassQuery(bbox))}` });
            if (!response.ok) {
                const busy = response.status === 429 || response.status === 504;
                throw Object.assign(upstreamError(`OpenStreetMap mirror answered HTTP ${response.status}.`), busy ? { retryAfterSeconds: 60 } : {});
            }
            const collection = overpassElementsToGeoJSON((await response.json())?.elements);
            if (collection.truncated) throw areaLimitError('OpenStreetMap mirror answer reached its feature cap.');
            return { type: 'FeatureCollection', features: collection.features, complete: true };
        }
    };
}

// Direct reads only: a URL source is the person's own choice of public service, and no request for
// it reaches our server, not even as a relay.
const directFetch = fetchImpl => (url, options = {}) => fetchImpl(url, { ...options, credentials: 'omit' });

export function createBrowserBuildingCells({ fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    const adapters = new Map();
    async function adapter(descriptor) {
        if (adapters.has(descriptor.id)) return adapters.get(descriptor.id);
        const options = { fetchImpl: directFetch(fetchImpl) };
        const created = descriptor.adapter === 'overpass' ? createOverpassAdapter(descriptor, options)
            // The city-model reader (CityJSON, CityGML) loads only for a source that needs it.
            : descriptor.adapter === 'city-model' ? (await import('./city-model-url-source.js')).createCityModelAdapter(descriptor, options)
            : await browserParcelFactories[descriptor.adapter](descriptor, options);
        const controlled = withSourceControls(created, { maxConcurrentQueries: 2 });
        // A few sources at most; the oldest goes first.
        if (adapters.size >= 8) adapters.delete(adapters.keys().next().value);
        adapters.set(descriptor.id, controlled);
        return controlled;
    }
    return Object.freeze({
        // { kind: 'near' | 'footprints', bbox: [w, s, e, n] } → the answer POST /buildings/cell gives.
        async read(sourceId, { kind, bbox } = {}, { signal } = {}) {
            if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) || !(bbox[0] < bbox[2]) || !(bbox[1] < bbox[3])) {
                throw upstreamError('Invalid building cell bbox.', 400, 'invalid-building-cell');
            }
            const descriptor = decodeBuildingSourceId(sourceId);
            return readBuildingCell(await adapter(descriptor), descriptor, { kind, bbox }, { signal });
        }
    });
}
