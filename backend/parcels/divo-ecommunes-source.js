// Reads reviewed E-Commune parcel XML, retaining only Feature/@ID and full polygon coordinates.
import { SaxesParser } from 'saxes';
import proj4 from 'proj4';
import { bbox as geometryBbox, bboxPolygon, booleanIntersects, feature as geoFeature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { parseKeralaWktPolygon } from './kerala-wkt.js';

const ENDPOINT = 'https://divo.ecommunes.ci/MapServer/AgentLot.aspx/Query';
const PREFIX = 'ci-divo-ecommunes/Parcellaire/feature-id/';
const ABENGOUROU = Object.freeze({
    id: 'ci-abengourou-ecommunes-parcellaire',
    endpoint: 'https://abengourou.ecommunes.ci/MapServer/AgentLot.aspx/Query',
    layer: 'Parcellaire_DIOULAKRO_2_(2A)',
    prefix: 'ci-abengourou-ecommunes/Parcellaire_DIOULAKRO_2_(2A)/feature-id/'
});
const DANANE = Object.freeze({
    id: 'ci-danane-ecommunes-parcellaire',
    endpoint: 'https://danane.ecommunes.ci/MapServer/AgentLot.aspx/Query',
    prefix: 'ci-danane-ecommunes/feature-id/',
    layers: ['PARCELLAIRE_PETIT_DANANE', 'PARCELLAIRE_BLESSALEU', 'PARCELLAIRE_COMMERCE',
        'PARCELLAIRE_AIR_FRANCE', 'PARCELLAIRE_CYNTHIAPLEU', 'PARCELLAIRE_HOUPHOUETVILLE',
        'PARCELLAIRE_STADE', 'PARCELLAIRE_TP', 'PARCELLAIRE_WOUANVILLE']
});
const GUID = /^[A-F0-9]{32}$/;

export function parseDivoPolygon(wkt, { preserveZ = false } = {}) {
    // This service writes POLYGONZM without a separating space. Preserve every
    // XY vertex and ring order; Danané also publishes a meaningful source Z.
    if (typeof wkt !== 'string' || wkt.length > 1000000) throw upstreamError('Divo polygon text is missing or too large.');
    try {
        const header = /^\s*((?:MULTI)?POLYGON)\s*(ZM|Z|M)?\s*(?=\()/i.exec(wkt);
        if (!header) throw new Error('Unsupported WKT type.');
        const dimensions = header[2]?.toUpperCase() === 'ZM' ? 4 : header[2] ? 3 : 2;
        const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
        // Validate the complete tuple lexically, but parse only XY as finite numbers.
        // The published M sentinel exceeds IEEE double's finite range; it is not XY.
        const elevations = [];
        const hasZ = /Z/i.test(header[2] || '');
        const xy = wkt.slice(header[0].length).replace(/[^(),]+/g, tuple => {
            if (!tuple.trim()) return tuple;
            const ordinates = tuple.trim().split(/\s+/);
            if (ordinates.length !== dimensions || ordinates.some(value => !numeric.test(value))) throw new Error('Malformed tuple.');
            if (preserveZ && hasZ) {
                const z = Number(ordinates[2]);
                if (!Number.isFinite(z)) throw new Error('Non-finite elevation.');
                elevations.push(z);
            }
            return ordinates.slice(0, 2).join(' ');
        });
        const geometry = parseKeralaWktPolygon(`${header[1]} ${xy}`);
        if (preserveZ && hasZ) {
            let index = 0;
            const attach = values => typeof values[0] === 'number' ? [...values, elevations[index++]] : values.map(attach);
            geometry.coordinates = attach(geometry.coordinates);
        }
        return geometry;
    }
    catch { throw upstreamError('Divo returned malformed or unsupported polygon geometry.'); }
}

export function createDivoEcommunesSource(descriptor, { fetchImpl = globalThis.fetch } = {}) {
    const binding = descriptor.id === DANANE.id ? DANANE : descriptor.id === ABENGOUROU.id ? ABENGOUROU
        : { id: 'ci-divo-ecommunes-parcellaire', endpoint: ENDPOINT, layer: 'Parcellaire', prefix: PREFIX };
    const prefix = binding.prefix;
    const layers = binding === DANANE ? descriptor.layers : [binding.layer];
    const validKey = key => binding === DANANE
        ? typeof key === 'string' && layers.includes(key.split(':')[0]) && key.split(':').length === 2 && GUID.test(key.split(':')[1])
        : GUID.test(key || '');
    const nativeKey = (layer, id) => binding === DANANE ? `${layer}:${id}` : id;
    const maxFeatures = descriptor.maxFeatures ?? 10000;
    const maxBytes = descriptor.maxResponseBytes ?? 16 * 1024 * 1024;
    const tileSize = descriptor.nativeTileSizeM ?? 500;
    const maxQueries = descriptor.maxNativeQueries ?? 64;
    const timeoutMs = descriptor.timeoutMs ?? 45000;
    // Grid cells and adjacent viewports overlap. Share bounded, partition-checked
    // native tiles briefly; exact-ID reads deliberately bypass this tile cache.
    const tileCache = new Map();
    const cacheMs = binding === DANANE ? 30000 : 0;
    const extent = descriptor.nativeExtent;
    const validNativeBounds = box => Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
        && box[0] >= 100000 && box[2] <= 900000 && box[1] >= 0 && box[3] <= 10000000
        && box[0] < box[2] && box[1] < box[3];
    const locators = new Map(Object.entries(descriptor.idLookupBoundsNative || {}));
    if (descriptor.endpoint !== binding.endpoint || descriptor.id !== binding.id
        || descriptor.idPrefix !== prefix
        || !Array.isArray(layers) || !layers.length || new Set(layers).size !== layers.length
        || (binding === DANANE ? layers.some(layer => !DANANE.layers.includes(layer)) : descriptor.layer !== binding.layer)
        || descriptor.sourceCrs !== (binding === DANANE ? 'EPSG:32629' : 'EPSG:32630') || !validNativeBounds(extent)
        || descriptor.outFields?.length !== 0 || typeof fetchImpl !== 'function'
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32 * 1024 * 1024
        || !Number.isFinite(tileSize) || tileSize < 50 || tileSize > 1000
        || !Number.isSafeInteger(maxQueries) || maxQueries < 1 || maxQueries > 300
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || locators.size > 10000 || [...locators].some(([id, box]) => !validKey(id) || !validNativeBounds(box))) {
        throw new Error('Invalid Divo municipal parcel descriptor.');
    }
    const safeDescriptor = { ...descriptor, outFields: [], parcelNumberField: undefined };
    const projection = proj4(`+proj=utm +zone=${binding === DANANE ? 29 : 30} +datum=WGS84 +units=m +no_defs`, 'EPSG:4326');
    const signalFor = options => options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

    function canonical(nativeId, wkt) {
        const native = parseDivoPolygon(wkt, { preserveZ: binding === DANANE });
        const convert = values => typeof values[0] === 'number' ? [...projection.forward(values.slice(0, 2)), ...values.slice(2)] : values.map(convert);
        const geometry = { type: native.type, coordinates: convert(native.coordinates) };
        if (!validateGeometry(geometry)) throw upstreamError('Divo returned an unusable polygon; no repair was applied.');
        return canonicalParcelFeature(safeDescriptor, { geometry }, nativeId);
    }

    async function readNative(box, signal, layer = binding.layer) {
        if (!validNativeBounds(box) || box[2] - box[0] > 1000 || box[3] - box[1] > 1000) {
            throw new HttpError(400, 'Divo requires bounded native windows of at most 1000 metres per side.');
        }
        const [w, s, e, n] = box;
        const url = new URL(binding.endpoint);
        url.search = new URLSearchParams({ layer, geom: `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))` });
        let response;
        // The municipal service can return a transient 500 for an otherwise valid
        // window. Retry one read, without widening it or retrying access failures.
        for (let attempt = 0; attempt < 2; attempt++) {
            response = await fetchImpl(url.href, { signal, redirect: 'error', cache: 'no-store', headers: { Accept: 'application/xml' } });
            if (attempt || ![500, 502, 503, 504].includes(response.status)) break;
            await response.body?.cancel();
        }
        if (!response.ok || response.status !== 200) throw providerHttpError(response);
        if (Number(response.headers.get('content-length')) > maxBytes || !response.body?.getReader) {
            throw upstreamError('Divo response exceeds the byte limit or has no readable body.');
        }
        const parser = new SaxesParser();
        const stack = [], rows = new Map();
        let current = null, rootSeen = false, byteCount = 0;
        parser.on('doctype', () => { throw upstreamError('Divo XML document types are unsupported.'); });
        parser.on('error', () => { throw upstreamError('Divo returned malformed XML.'); });
        parser.on('opentag', tag => {
            if (!stack.length) {
                if (rootSeen || tag.name !== 'result') throw upstreamError('Divo returned an unexpected XML root.');
                rootSeen = true;
            } else if (stack.length === 1) {
                if (tag.name !== 'Feature' || !GUID.test(tag.attributes.ID || '')) throw upstreamError('Divo returned an invalid feature ID or service error.');
                current = { id: nativeKey(layer, tag.attributes.ID), wkt: '', geometries: 0 };
            } else if (stack.length === 2 && tag.name === 'Geometry') current.geometries++;
            stack.push(tag.name);
        });
        const text = value => {
            // Never retain, log, or interpret any Values attributes or personal data.
            if (stack.length === 3 && stack.at(-1) === 'Geometry') {
                current.wkt += value;
                if (current.wkt.length > 1000000) throw upstreamError('Divo polygon exceeds the geometry limit.');
            }
        };
        parser.on('text', text);
        parser.on('cdata', text);
        parser.on('closetag', tag => {
            if (tag.name === 'Feature' && stack.length === 2) {
                if (current.geometries !== 1 || rows.has(current.id)) throw upstreamError('Divo repeated an ID or omitted polygon geometry.');
                rows.set(current.id, canonical(current.id, current.wkt));
                if (rows.size > maxFeatures) throw upstreamError('Divo response exceeds the feature limit.');
                current = null;
            }
            stack.pop();
        });
        const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                byteCount += value.byteLength;
                if (byteCount > maxBytes) throw upstreamError('Divo response exceeds the byte limit.');
                parser.write(decoder.decode(value, { stream: true }));
            }
            parser.write(decoder.decode()).close();
            if (!rootSeen) throw upstreamError('Divo returned no XML result.');
        } catch (error) {
            try { await reader.cancel(); } catch { /* The response may already be closed. */ }
            if (error.status) throw error;
            throw upstreamError('Divo XML response was interrupted or invalid.');
        } finally { reader.releaseLock(); }
        for (const id of rows.keys()) {
            if (locators.size >= maxFeatures && !locators.has(id)) locators.delete(locators.keys().next().value);
            locators.set(id, box);
        }
        return [...rows.values()];
    }

    function merge(found, features) {
        for (const row of features) {
            const previous = found.get(row.id);
            if (previous && JSON.stringify(previous.geometry) !== JSON.stringify(row.geometry)) throw upstreamError('Divo changed geometry for one feature ID.');
            found.set(row.id, row);
        }
        if (found.size > maxFeatures) throw upstreamError('Divo query exceeds the feature limit.');
    }
    function tiles(box) {
        const [w, s, e, n] = box;
        const result = [];
        const startX = binding === DANANE ? Math.floor(w / tileSize) * tileSize : w;
        const startY = binding === DANANE ? Math.floor(s / tileSize) * tileSize : s;
        for (let x = startX; x < e; x += tileSize) for (let y = startY; y < n; y += tileSize) {
            if (result.length >= maxQueries) throw new HttpError(400, 'Divo query exceeds the native tile budget.');
            result.push(binding === DANANE
                ? [Math.max(extent[0], x), Math.max(extent[1], y), Math.min(extent[2], x + tileSize), Math.min(extent[3], y + tileSize)]
                : [x, y, Math.min(e, x + tileSize), Math.min(n, y + tileSize)]);
        }
        return result;
    }
    const result = (features, extra = {}) => ({ type: 'FeatureCollection', sourceId: descriptor.id, returnsWGS84: true,
        features, complete: false, areaComplete: false, authoritativeAbsence: false, ...extra });

    async function queryBounds(bounds, options = {}) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 4);
        const [w, s, e, n] = bounds;
        const corners = [[w,s], [w,n], [e,s], [e,n]].map(point => projection.inverse(point));
        const nativeBox = [Math.max(extent[0], Math.min(...corners.map(p => p[0]))), Math.max(extent[1], Math.min(...corners.map(p => p[1]))),
            Math.min(extent[2], Math.max(...corners.map(p => p[0]))), Math.min(extent[3], Math.max(...corners.map(p => p[1])))];
        const found = new Map(), signal = signalFor(options);
        let nativeQueries = 0, consistent = true;
        const read = async (box, layer) => {
            if (++nativeQueries > maxQueries) throw new HttpError(400, 'Divo query exceeds the native tile budget.');
            return readNative(box, signal, layer);
        };
        if (nativeBox[0] < nativeBox[2] && nativeBox[1] < nativeBox[3]) {
            for (const layer of layers) for (const box of tiles(nativeBox)) {
                const key = `${layer}|${box.join(',')}`;
                let entry = tileCache.get(key);
                if (!entry || entry.expires <= Date.now()) {
                    const promise = (async () => {
                        const parent = new Map(), children = new Map();
                        merge(parent, await read(box, layer));
                        const axis = box[2] - box[0] >= box[3] - box[1] ? 0 : 1;
                        const middle = (box[axis] + box[axis + 2]) / 2;
                        const left = [...box], right = [...box];
                        left[axis + 2] = middle; right[axis] = middle;
                        for (const part of [left, right]) merge(children, await read(part, layer));
                        // Agreement is bounded transfer evidence, never a census.
                        const complete = parent.size < maxFeatures && children.size < maxFeatures
                            && parent.size === children.size && [...parent.keys()].every(id => children.has(id));
                        merge(parent, [...children.values()]);
                        return { features: [...parent.values()], complete };
                    })();
                    entry = { promise, expires: Date.now() + cacheMs };
                    if (cacheMs) {
                        if (tileCache.size >= 18) tileCache.delete(tileCache.keys().next().value);
                        tileCache.set(key, entry);
                    }
                }
                let tile;
                try { tile = await entry.promise; }
                catch (error) { if (tileCache.get(key) === entry) tileCache.delete(key); throw error; }
                if (!tile.complete) {
                    consistent = false;
                    if (tileCache.get(key) === entry) tileCache.delete(key);
                }
                merge(found, tile.features);
            }
        }
        // Abengourou selects by feature envelope. Test the full, unchanged shape:
        // disconnected MultiPolygon parts can both lie outside the query window.
        const window = bboxPolygon(bounds);
        const features = [...found.values()].filter(row => (binding !== ABENGOUROU && binding !== DANANE) || booleanIntersects(row, window));
        return result(features, { complete: consistent, nativeQueries,
            transferCheck: 'native-window-versus-two-partition-id-and-geometry-agreement',
            reason: consistent ? 'Bounded XML transfers agree across spatial partitions; provider totals, city coverage and absence remain unverified.'
                : 'Spatial partitions disagree or reach the feature budget; bounded transfer remains incomplete.' });
    }

    async function queryIds(ids, options = {}) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== 'string' || !id.startsWith(prefix) || !validKey(id.slice(prefix.length)))) {
            throw new HttpError(400, 'Provide 1–80 unique Divo feature IDs.');
        }
        const found = new Map(), windows = new Map(), wanted = new Set(ids), signal = signalFor(options);
        for (const id of ids) {
            const box = locators.get(id.slice(prefix.length));
            if (box) {
                const layer = binding === DANANE ? id.slice(prefix.length).split(':')[0] : binding.layer;
                windows.set(`${layer}|${box.join(',')}`, { box, layer });
            }
        }
        // Locator windows contain no cached output geometry: every exact read hits
        // the source again and matches its current Feature/@ID, including on restart.
        for (const { box, layer } of windows.values()) {
            merge(found, (await readNative(box, signal, layer)).filter(row => wanted.has(row.id)));
        }
        const unresolvedIds = ids.filter(id => !found.has(id));
        return result(ids.filter(id => found.has(id)).map(id => found.get(id)), {
            complete: unresolvedIds.length === 0, absentIds: [], unresolvedIds,
            exactReadMethod: 'fresh-native-spatial-query-and-feature-id-match',
            ...(unresolvedIds.length ? { reason: 'No matching feature in known locator windows; absence is unproven.' } : {})
        });
    }

    async function queryGeometry(geometry, options = {}) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Expected WGS84 polygon geometry.');
        const response = await queryBounds(geometryBbox(geoFeature(geometry)), options);
        return { ...response, features: response.features.filter(row => booleanIntersects(row, geoFeature(geometry))) };
    }
    return { queryBounds, queryIds, queryGeometry };
}
