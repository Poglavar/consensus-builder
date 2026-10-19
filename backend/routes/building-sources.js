// POST /building-sources/discover: checks a user-supplied building source URL the way
// /parcel-sources/discover checks a parcel one (same adapters, same public-URL guard, same limits),
// and answers a portable `building.<base64url>` id the browser keeps in local storage and sends with
// its /buildings/* requests as `source`. The browser never fetches the URL itself.
import rateLimit from 'express-rate-limit';
import { HttpError } from '../utils/helpers.js';
import { createParcelSource } from '../parcels/sources.js';
import { createPublicSourceFetch, validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { discoverCustomBuildingSource } from '../parcels/custom-source-discovery.js';
import { decodeCustomBuildingSource, encodeCustomSource } from '../parcels/custom-source-config.js';
import { validateBounds } from '../parcels/source-contract.js';
import { looksLikeOverpass, discoverOverpassSource } from '../buildings/overpass-source.js';

export function setupBuildingSourcesRoute(app, { discover = discoverCustomBuildingSource, publicFetch = createPublicSourceFetch(),
    discoverOverpass = discoverOverpassSource } = {}) {
    const fail = (res, error) => {
        const status = error.status || (error.code === 'no-available-adapter' ? 422 : 502);
        res.set('Cache-Control', 'no-store');
        if (error.retryAfterSeconds !== undefined) res.set('Retry-After', String(Math.ceil(error.retryAfterSeconds)));
        return res.status(status).json({ error: error.message, code: error.code,
            upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds, attempts: error.attempts });
    };
    app.post('/building-sources/discover', rateLimit({ windowMs: 60000, limit: 6, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Please wait before checking another source.', code: 'building-source-rate-limited', retryAfterSeconds: 60 } }), async (req, res) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
            const url = validatePublicSourceUrl(req.body?.url);
            if (url.href.length > 2000) throw Object.assign(new HttpError(400, 'Source URL is too long.'), { code: 'invalid-source-url' });
            const city = req.body?.city;
            if (typeof city !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(city)) throw new HttpError(400, 'Choose a city before adding a source.');
            const bbox = validateBounds(req.body?.bbox, 1);
            // An OpenStreetMap (Overpass) mirror reads OSM's own tags, so there is nothing to discover.
            if (looksLikeOverpass(url.href)) {
                const mirror = await discoverOverpass({ url: url.href, city, bbox });
                return res.set('Cache-Control', 'no-store').json({ source: mirror.source, attempts: [], buildingCount: mirror.buildingCount });
            }
            const lon = (bbox[0] + bbox[2]) / 2, lat = (bbox[1] + bbox[3]) / 2;
            const metricSrid = (lat >= 0 ? 32600 : 32700) + Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
            const boundedFetch = (target, options = {}) => publicFetch(target, { ...options,
                signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
            const result = await discover({ url, city, metricSrid, bbox }, { fetchImpl: boundedFetch });
            // Field names rarely say their unit (NYC's HEIGHT_ROOF is feet), so the person may say it.
            const heightUnit = ['m', 'ft'].includes(req.body?.heightUnit) && result.descriptor.heightField
                ? req.body.heightUnit : result.descriptor.heightUnit;
            const source = decodeCustomBuildingSource(encodeCustomSource({ ...result.descriptor, kind: 'building', heightUnit }));
            // Re-read using the final portable identity before offering it to the browser.
            const probe = await createParcelSource(source, { fetchImpl: boundedFetch }).queryBounds(bbox);
            if (probe.complete !== true) throw new HttpError(502, 'Source did not return complete building coverage.');
            res.set('Cache-Control', 'no-store').json({ source, attempts: result.attempts, buildingCount: probe.features.length });
        } catch (error) { if (!res.destroyed) fail(res, error); }
        finally { clearTimeout(timer); res.off('close', disconnect); }
    });
}
