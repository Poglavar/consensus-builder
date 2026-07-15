// Purpose: proxy viewport parcel inference through a configured model service and normalize provisional GeoJSON.
import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_BBOX_SPAN = 0.05;
const DEFAULT_MIN_ZOOM = 16;
const MAX_CACHE_ENTRIES = 100;

function parseFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBbox(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;
    const values = rawValue.split(',').map(Number);
    if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return null;
    const [west, south, east, north] = values;
    if (west < -180 || east > 180 || south < -85 || north > 85 || west >= east || south >= north) return null;
    return { west, south, east, north, values };
}

function isPolygonGeometry(geometry) {
    return geometry && (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') && Array.isArray(geometry.coordinates);
}

function walkCoordinates(value, visit) {
    if (!Array.isArray(value)) return false;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
        return visit(value[0], value[1]);
    }
    return value.every(child => walkCoordinates(child, visit));
}

function isValidWgs84Geometry(geometry) {
    return isPolygonGeometry(geometry) && walkCoordinates(
        geometry.coordinates,
        (lon, lat) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90
    );
}

function stableParcelId(geometry) {
    const digest = createHash('sha256').update(JSON.stringify(geometry)).digest('hex').slice(0, 16);
    return `AI-${digest}`;
}

function normalizeFeature(feature, metadata = {}) {
    if (!feature || feature.type !== 'Feature' || !isValidWgs84Geometry(feature.geometry)) return null;
    const original = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
    const parcelId = stableParcelId(feature.geometry);
    const confidence = Number(original.confidence);
    return {
        type: 'Feature',
        id: parcelId,
        properties: {
            ...original,
            parcelId,
            id: parcelId,
            BROJ_CESTICE: original.BROJ_CESTICE || parcelId,
            provenance: 'inferred',
            planningStatus: 'provisional',
            authoritative: false,
            ownershipType: original.ownershipType || 'unknown',
            confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
            model: original.model || metadata.model || null,
            modelVersion: original.modelVersion || metadata.modelVersion || null,
            promptVersion: original.promptVersion || metadata.promptVersion || null,
            imagery: original.imagery || metadata.imagery || null
        },
        geometry: feature.geometry
    };
}

function extractFeatureCollection(payload) {
    if (payload?.type === 'FeatureCollection') return payload;
    if (payload?.parcels?.type === 'FeatureCollection') return payload.parcels;
    if (payload?.result?.type === 'FeatureCollection') return payload.result;
    return null;
}

function cacheKey(bbox, zoom, model, adapter) {
    const rounded = bbox.values.map(value => value.toFixed(6)).join(',');
    return `${rounded}|${zoom}|${model || ''}|${adapter || ''}`;
}

export function setupParcelInferenceRoute(app, options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const cache = new Map();

    app.get('/parcels/inferred', async (req, res) => {
        const bbox = parseBbox(typeof req.query.bbox === 'string' ? req.query.bbox.trim() : '');
        if (!bbox) {
            return res.status(400).json({ error: 'Invalid bbox. Expected west,south,east,north in WGS84 (latitude limited to ±85).' });
        }

        const zoom = Number(req.query.zoom);
        const minZoom = parseFiniteNumber(env.PARCEL_INFERENCE_MIN_ZOOM, DEFAULT_MIN_ZOOM);
        if (!Number.isFinite(zoom) || zoom < minZoom || zoom > 22) {
            return res.status(400).json({ error: `Invalid zoom. Expected a value from ${minZoom} to 22.` });
        }

        const maxSpan = parseFiniteNumber(env.PARCEL_INFERENCE_MAX_BBOX_SPAN, DEFAULT_MAX_BBOX_SPAN);
        if ((bbox.east - bbox.west) > maxSpan || (bbox.north - bbox.south) > maxSpan) {
            return res.status(413).json({ error: `Viewport is too large for inference. Maximum bbox span is ${maxSpan} degrees.` });
        }

        const serviceUrl = (env.PARCEL_INFERENCE_URL || '').trim();
        if (!serviceUrl) {
            return res.status(503).json({
                error: 'Parcel inference is not configured.',
                supported: false,
                type: 'FeatureCollection',
                features: []
            });
        }

        const model = (env.PARCEL_INFERENCE_MODEL || '').trim() || null;
        const llmAdapter = (env.PARCEL_INFERENCE_LLM_ADAPTER || '').trim() || null;
        const key = cacheKey(bbox, zoom, model, llmAdapter);
        const now = Date.now();
        const cached = cache.get(key);
        if (cached && cached.expiresAt > now) {
            res.set('X-Parcel-Inference-Cache', 'HIT');
            return res.json(cached.body);
        }
        if (cached) cache.delete(key);

        const controller = new AbortController();
        const timeoutMs = parseFiniteNumber(env.PARCEL_INFERENCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
            if (env.PARCEL_INFERENCE_TOKEN) headers.Authorization = `Bearer ${env.PARCEL_INFERENCE_TOKEN}`;
            const upstream = await fetchImpl(serviceUrl, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    input: { type: 'viewport', bbox: bbox.values, crs: 'EPSG:4326', zoom },
                    output: { format: 'geojson', crs: 'EPSG:4326' },
                    model,
                    llmAdapter
                })
            });
            if (!upstream.ok) {
                throw new Error(`Inference service returned ${upstream.status}`);
            }
            const payload = await upstream.json();
            const collection = extractFeatureCollection(payload);
            if (!collection) throw new Error('Inference service did not return a GeoJSON FeatureCollection');
            const metadata = payload.metadata || collection.metadata || {};
            const features = (collection.features || []).map(feature => normalizeFeature(feature, metadata)).filter(Boolean);
            const body = {
                type: 'FeatureCollection',
                features,
                metadata: {
                    provenance: 'inferred',
                    planningStatus: 'provisional',
                    authoritative: false,
                    bbox: bbox.values,
                    zoom,
                    model: metadata.model || model,
                    modelVersion: metadata.modelVersion || null,
                    promptVersion: metadata.promptVersion || null,
                    imagery: metadata.imagery || null,
                    generatedAt: metadata.generatedAt || new Date().toISOString()
                }
            };

            const cacheTtlMs = parseFiniteNumber(env.PARCEL_INFERENCE_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
            if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
            cache.set(key, { expiresAt: now + cacheTtlMs, body });
            res.set('X-Parcel-Inference-Cache', 'MISS');
            return res.json(body);
        } catch (error) {
            const timedOut = error?.name === 'AbortError';
            console.error('Parcel inference failed:', error?.message || error);
            return res.status(502).json({
                error: timedOut ? 'Parcel inference timed out.' : 'Parcel inference service failed.',
                type: 'FeatureCollection',
                features: []
            });
        } finally {
            clearTimeout(timeout);
        }
    });
}

export const parcelInferenceInternals = {
    parseBbox,
    normalizeFeature,
    stableParcelId
};
