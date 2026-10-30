// GET /building-sources/discover: checks a user-supplied building source URL the way
// /parcel-sources/discover checks a parcel one (same adapters, same public-URL guard, same limits),
// and answers a portable `building.<base64url>` id the browser keeps in its source list. The browser
// then reads the source itself (its adapter worker, never through us), so a service that does not let
// other websites read its answers (no CORS header for the browser's origin) is refused here. A
// CityJSON or CityGML file is read whole (buildings/city-model-url-source.js).
import rateLimit from 'express-rate-limit';
import * as turf from '@turf/turf';
import { HttpError } from '../utils/helpers.js';
import { createParcelSource } from '../parcels/sources.js';
import { createPublicSourceFetch, validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { discoverCustomBuildingSource } from '../parcels/custom-source-discovery.js';
import { decodeCustomBuildingSource, encodeCustomSource } from '../parcels/custom-source-config.js';
import { validateBounds, discoverQuery } from '../parcels/source-contract.js';
import { looksLikeOverpass, discoverOverpassSource, createOverpassFetch } from '../buildings/overpass-source.js';
import { looksLikeCityModelFile, readCityModelFile } from '../buildings/city-model-url-source.js';
import { BUILDING_SOURCE_LIMITS } from '../buildings/building-cell-read.js';

// The origin a browser reads from when the check arrives without one (a same-origin page, a script).
const DEFAULT_BROWSER_ORIGIN = 'https://urbangametheory.xyz';

// A fetch that sends the browser's Origin and remembers whether every answer let that origin read it.
// Simple GETs and form POSTs (all the adapters send) need no preflight, so the answer's own header decides.
function corsCheckedFetch(fetchImpl, origin) {
    let refused = false;
    const fetch = async (target, options = {}) => {
        const headers = new Headers(options.headers);
        headers.set('Origin', origin);
        const response = await fetchImpl(target, { ...options, headers });
        const allowed = response?.headers?.get?.('access-control-allow-origin');
        if (allowed !== '*' && allowed !== origin) refused = true;
        return response;
    };
    return { fetch, readable: () => !refused };
}
const refused = (message, code) => Object.assign(new HttpError(422, message), { code });

// A city model file: its buildings in the test area, and the source pinned to the bytes it was read
// with. null when the file is no city model (a GeoJSON file goes on to the adapters).
export async function discoverCityModelSource({ url, city, bbox }, { fetchImpl }) {
    let read;
    try { read = await readCityModelFile({ endpoint: url, ...BUILDING_SOURCE_LIMITS }, { fetchImpl }); }
    catch (error) {
        if (error.code === 'not-city-model') return null;
        if (error.code === 'unsupported-crs') throw refused(error.message, 'unsupported-crs');
        throw error;
    }
    if (!read.bbox) throw refused('The city model holds no building with a footprint.', 'empty-bounds');
    const box = turf.bboxPolygon(bbox);
    const buildingCount = read.features.filter(feature => turf.booleanIntersects(feature, box)).length;
    if (!buildingCount) throw refused('The city model has no buildings in the test area.', 'empty-bounds');
    const source = decodeCustomBuildingSource(encodeCustomSource({ adapter: 'city-model', endpoint: url, ...(city ? { cityIds: [city] } : {}),
        kind: 'building', format: read.format, bbox: read.bbox, expectedSha256: read.sha256 }));
    return { source, buildingCount };
}

const noCors = () => Object.assign(new HttpError(422, 'This source does not let other websites read it (no CORS header), so the browser cannot load it.'),
    { code: 'building-source-no-cors' });

export function setupBuildingSourcesRoute(app, { discover = discoverCustomBuildingSource, publicFetch = createPublicSourceFetch(),
    discoverOverpass = discoverOverpassSource, discoverCityModel = discoverCityModelSource } = {}) {
    const fail = (res, error) => {
        const status = error.status || (error.code === 'no-available-adapter' ? 422 : 502);
        res.set('Cache-Control', 'no-store');
        if (error.retryAfterSeconds !== undefined) res.set('Retry-After', String(Math.ceil(error.retryAfterSeconds)));
        return res.status(status).json({ error: error.message, code: error.code,
            upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds, attempts: error.attempts });
    };
    app.get('/building-sources/discover', rateLimit({ windowMs: 60000, limit: 6, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Please wait before checking another source.', code: 'building-source-rate-limited', retryAfterSeconds: 60 } }), async (req, res) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
            const input = discoverQuery(req.query);
            const url = validatePublicSourceUrl(input.url);
            if (url.href.length > 2000) throw Object.assign(new HttpError(400, 'Source URL is too long.'), { code: 'invalid-source-url' });
            const city = input.city;
            if (city !== undefined && (typeof city !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(city))) throw new HttpError(400, 'Invalid source label.');
            const bbox = validateBounds(input.bbox, 1);
            const requestOrigin = typeof req.get === 'function' ? req.get('origin') : undefined;
            const origin = typeof requestOrigin === 'string' && /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(requestOrigin)
                ? requestOrigin : DEFAULT_BROWSER_ORIGIN;
            // An OpenStreetMap (Overpass) mirror reads OSM's own tags, so there is nothing to discover.
            if (looksLikeOverpass(url.href)) {
                const cors = corsCheckedFetch(createOverpassFetch(), origin);
                const mirror = await discoverOverpass({ url: url.href, city, bbox }, { fetchImpl: cors.fetch });
                if (!cors.readable()) throw noCors();
                return res.set('Cache-Control', 'no-store').json({ source: mirror.source, attempts: [], buildingCount: mirror.buildingCount });
            }
            const boundedFetch = (target, options = {}) => publicFetch(target, { ...options,
                signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
            if (looksLikeCityModelFile(url.href)) {
                const cors = corsCheckedFetch(boundedFetch, origin);
                const model = await discoverCityModel({ url: url.href, city, bbox }, { fetchImpl: cors.fetch });
                if (model) {
                    if (!cors.readable()) throw noCors();
                    return res.set('Cache-Control', 'no-store').json({ source: model.source, attempts: [], buildingCount: model.buildingCount });
                }
            }
            const lon = (bbox[0] + bbox[2]) / 2, lat = (bbox[1] + bbox[3]) / 2;
            const metricSrid = (lat >= 0 ? 32600 : 32700) + Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
            const result = await discover({ url, city, metricSrid, bbox }, { fetchImpl: boundedFetch });
            // Field names rarely say their unit (NYC's HEIGHT_ROOF is feet), so the person may say it.
            const heightUnit = ['m', 'ft'].includes(input.heightUnit) && result.descriptor.heightField
                ? input.heightUnit : result.descriptor.heightUnit;
            const source = decodeCustomBuildingSource(encodeCustomSource({ ...result.descriptor, kind: 'building', heightUnit }));
            // Re-read using the final portable identity, as the browser will, before offering it.
            const cors = corsCheckedFetch(boundedFetch, origin);
            const probe = await createParcelSource(source, { fetchImpl: cors.fetch }).queryBounds(bbox);
            if (probe.complete !== true) throw new HttpError(502, 'Source did not return complete building coverage.');
            if (!cors.readable()) throw noCors();
            res.set('Cache-Control', 'no-store').json({ source, attempts: result.attempts, buildingCount: probe.features.length });
        } catch (error) { if (!res.destroyed) fail(res, error); }
        finally { clearTimeout(timer); res.off('close', disconnect); }
    });
}
