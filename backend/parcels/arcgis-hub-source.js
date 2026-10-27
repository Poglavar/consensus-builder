// Query public Hub exports by native ID or extent; never load an unfiltered city export.
import { bbox, bboxPolygon, booleanIntersects, feature } from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { canonicalParcelFeature, providerHttpError, upstreamError, validateBounds, validateGeometry } from './source-contract.js';
import { geoJsonResponseCrsMatches } from './response-crs.js';

const nativeId = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    || typeof value === 'string' && /^(0|[1-9][0-9]{0,14})$/.test(value) && Number.isSafeInteger(Number(value));

function hubPaths(descriptor) {
    const url = new URL(descriptor.endpoint);
    const match = /^\/api\/download\/v1\/items\/([a-f0-9]{32})\/geojson$/.exec(url.pathname);
    const layer = url.searchParams.get('layers');
    if (url.origin !== 'https://hub.arcgis.com' || !match || !/^(0|[1-9][0-9]*)$/.test(layer || '')) {
        throw new Error('Invalid ArcGIS Hub endpoint.');
    }
    return { url, downloadPath: `/api/v3/datasets/${match[1]}_${layer}/downloads/data`, layer };
}

// Permit only this item's export and its corresponding cached download, including redirects.
export function isArcgisHubParcelUrl(descriptor, input) {
    try {
        const { url, downloadPath, layer } = hubPaths(descriptor), target = new URL(input);
        if (target.origin !== url.origin || target.username || target.password || target.hash
            || ![url.pathname, downloadPath].includes(target.pathname)) return false;
        const allowed = target.pathname === downloadPath
            ? ['format', 'spatialRefId', 'where', 'geometry'] : ['redirect', 'layers', 'where', 'geometry', 'outFields'];
        if ([...target.searchParams.keys()].some(key => !allowed.includes(key)
            || target.searchParams.getAll(key).length !== 1)) return false;
        if (target.pathname === downloadPath) {
            if (target.searchParams.get('format') !== 'geojson' || target.searchParams.get('spatialRefId') !== '4326') return false;
        } else if (target.searchParams.get('layers') !== layer || target.searchParams.get('redirect') !== 'true'
            || target.searchParams.get('outFields') !== descriptor.outFields.join(',')) return false;
        const where = target.searchParams.get('where');
        if (where !== '1=1') {
            const escaped = descriptor.idField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (!new RegExp(`^${escaped} IN \\((?:0|[1-9][0-9]{0,14})(?:,(?:0|[1-9][0-9]{0,14})){0,79}\\)$`).test(where || '')) return false;
        }
        const geometry = target.searchParams.get('geometry');
        if (geometry) {
            const g = JSON.parse(geometry);
            if (g.type !== 'extent' || g.spatialReference?.wkid !== 4326
                || Object.keys(g).some(key => !['type', 'xmin', 'ymin', 'xmax', 'ymax', 'spatialReference'].includes(key))
                || Object.keys(g.spatialReference).some(key => key !== 'wkid')) return false;
            validateBounds([g.xmin, g.ymin, g.xmax, g.ymax], descriptor.maxBboxKm2 ?? 1);
        }
        return where !== '1=1' || Boolean(geometry);
    } catch { return false; }
}

export function createArcgisHubParcelSource(descriptor, { fetchImpl = globalThis.fetch,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const { url } = hubPaths(descriptor);
    const { id, idPrefix, idField, outFields } = descriptor;
    const maxBytes = descriptor.maxResponseBytes ?? 1024 * 1024;
    const maxFeatures = descriptor.maxFeatures ?? 2000;
    const timeoutMs = descriptor.timeoutMs ?? 45000;
    const exportTimeoutMs = descriptor.exportTimeoutMs ?? 120000;
    const exportGridSize = descriptor.exportGridSize ?? 0.005;
    if (!id || !idPrefix || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(idField || '')
        || !Array.isArray(outFields) || outFields.length !== 1 || outFields[0] !== idField
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 ** 2
        || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > 10000
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000
        || !Number.isSafeInteger(exportTimeoutMs) || exportTimeoutMs < timeoutMs || exportTimeoutMs > 120000
        || !Number.isFinite(exportGridSize) || exportGridSize < 0.001 || exportGridSize > 0.005) {
        throw new Error('Invalid ArcGIS Hub parcel descriptor.');
    }

    async function read(params) {
        const query = new URL(url);
        query.searchParams.set('outFields', outFields.join(','));
        for (const [key, value] of Object.entries(params)) query.searchParams.set(key, value);
        if (!isArcgisHubParcelUrl(descriptor, query)) throw upstreamError('Unbounded Hub parcel query.');
        const generationSignal = AbortSignal.timeout(exportTimeoutMs);
        let downloadedBytes = 0, gatewayRetries = 0;
        // Hub generates a filtered cache asynchronously. Pending/error bodies are bounded too.
        for (let attempt = 0; attempt < 30; attempt++) {
            generationSignal.throwIfAborted();
            const signal = AbortSignal.any([generationSignal, AbortSignal.timeout(timeoutMs)]);
            const response = await fetchImpl(query.href, { signal, redirect: 'follow',
                headers: { Accept: 'application/geo+json, application/json' } });
            if (![200, 202].includes(response.status)) {
                const error = providerHttpError(response);
                await response.body?.cancel();
                if ([502, 503, 504].includes(response.status) && gatewayRetries++ < 2) {
                    await sleep(1000); continue;
                }
                // Respect an explicit short rate-limit delay inside the overall generation budget.
                if (response.status === 429 && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 60) {
                    await sleep(error.retryAfterSeconds * 1000); continue;
                }
                throw error;
            }
            if (response.url && !isArcgisHubParcelUrl(descriptor, response.url)) {
                await response.body?.cancel(); throw upstreamError('Hub redirected outside the filtered source.');
            }
            const reader = response.body?.getReader();
            if (!reader) throw upstreamError('Hub returned no readable parcel body.');
            const chunks = [];
            let length = 0;
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    length += part.value.byteLength; downloadedBytes += part.value.byteLength;
                    if (length > maxBytes || downloadedBytes > maxBytes) throw upstreamError('Hub parcel read exceeds actual byte limit.');
                    chunks.push(part.value);
                }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            let collection;
            try { collection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
            catch { throw upstreamError('Hub returned malformed GeoJSON.'); }
            if (response.status === 202) {
                if (typeof collection.status !== 'string' || /fail|error|cancel/i.test(collection.status)) {
                    throw upstreamError('Hub export generation failed.');
                }
                // Generating a new spatial file can exceed a single HTTP request's deadline.
                // Pace polls so several viewport windows stay below the relay's request limit.
                await sleep(4000); continue;
            }
            if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)
                || collection.features.length > maxFeatures || collection.complete === false || collection.exceededTransferLimit === true
                || !geoJsonResponseCrsMatches(collection.crs, 4326, { required: true })) {
                throw upstreamError('Hub returned incomplete or non-WGS84 parcel data.');
            }
            const byId = new Map();
            for (const f of collection.features) {
                const key = f?.properties?.[idField];
                if (f?.type !== 'Feature' || !nativeId(key) || !validateGeometry(f.geometry)) {
                    throw upstreamError('Hub returned malformed parcel identity or polygon.');
                }
                // Hub ignores outFields on this export route. Discard all other properties.
                const clean = canonicalParcelFeature(descriptor, { geometry: f.geometry, properties: { [idField]: key } }, String(key));
                if (byId.has(clean.id)) throw upstreamError('Hub repeated a native parcel identity.');
                byId.set(clean.id, clean);
            }
            return { type: 'FeatureCollection', features: [...byId.values()], complete: true,
                sourceId: id, returnsWGS84: true, downloadedBytes };
        }
        throw upstreamError('Hub filtered export is still pending; retry later.', 504);
    }

    async function queryIds(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(value => typeof value !== 'string'
            || !value.startsWith(idPrefix) || !nativeId(value.slice(idPrefix.length)))) {
            throw new HttpError(400, 'Provide 1–80 native parcel IDs from this source.');
        }
        const unique = [...new Set(ids)], wanted = new Set(unique);
        const result = await read({ where: `${idField} IN (${unique.map(value => value.slice(idPrefix.length)).join(',')})` });
        if (result.features.some(f => !wanted.has(f.id))) throw upstreamError('Hub ignored the native parcel filter.');
        const found = new Set(result.features.map(f => f.id));
        return { ...result, absentIds: unique.filter(value => !found.has(value)) };
    }

    const windows = new Map();
    async function queryBounds(bounds) {
        validateBounds(bounds, descriptor.maxBboxKm2 ?? 1, descriptor);
        // Adjacent browser cells share a small, bounded export rather than generating a file each.
        const expanded = bounds.map((value, index) => Number(((index < 2 ? Math.floor : Math.ceil)(value / exportGridSize)
            * exportGridSize).toFixed(10)));
        validateBounds(expanded, descriptor.maxBboxKm2 ?? 1);
        const key = expanded.join(','), now = Date.now();
        if (windows.get(key)?.expires <= now) windows.delete(key);
        if (!windows.has(key)) {
            if (windows.size >= 16) windows.delete(windows.keys().next().value);
            const [xmin, ymin, xmax, ymax] = expanded;
            const promise = read({ where: '1=1', geometry: JSON.stringify({ type: 'extent', xmin, ymin, xmax, ymax,
                spatialReference: { wkid: 4326 } }) }).catch(error => { windows.delete(key); throw error; });
            windows.set(key, { promise, expires: now + 5 * 60 * 1000 });
        }
        const result = await windows.get(key).promise, target = bboxPolygon(bounds);
        // Hub's native-CRS extent search can over-return at the edge (observed in London).
        // The bounded export is a candidate set: apply the precise WGS84 intersection here,
        // without shifting, clipping or otherwise altering any returned parcel geometry.
        return { ...result, features: structuredClone(result.features.filter(f => booleanIntersects(f, target))) };
    }
    async function queryGeometry(geometry) {
        if (!validateGeometry(geometry)) throw new HttpError(400, 'Provide a WGS84 parcel polygon.');
        const result = await queryBounds(bbox(feature(geometry)));
        return { ...result, features: result.features.filter(f => booleanIntersects(f, feature(geometry))) };
    }
    return Object.freeze({ queryBounds, queryIds, queryGeometry });
}
