// Read-only parcel gateway: fixed source descriptors keep provider protocols out of app consumers.
import { parcelSourceCatalog as catalog, createParcelSource, runtimeParcelSource, resolveParcelSourceDescriptor, withSourceCooldown } from '../parcels/sources.js';
import { HttpError, queryString } from '../utils/helpers.js';
import rateLimit from 'express-rate-limit';
import { createPublicSourceFetch, validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { discoverCustomParcelSource } from '../parcels/custom-source-discovery.js';
import { decodeCustomSource, encodeCustomSource } from '../parcels/custom-source-config.js';
import { validateBounds } from '../parcels/source-contract.js';

export function setupParcelSourcesRoute(app, { sources = catalog.sources, fetchImpl, discover = discoverCustomParcelSource, publicFetch = createPublicSourceFetch() } = {}) {
    const adapters = new Map(sources.map(source => {
        return [source.id, fetchImpl ? withSourceCooldown(createParcelSource(source, { fetchImpl })) : runtimeParcelSource(source)];
    }));
    app.get('/parcel-sources', (_req, res) => res.json({ schemaVersion: catalog.schemaVersion, sources }));
    const fail = (res, error, sourceId) => {
        const status = error.status || (error.code === 'no-available-adapter' ? 422 : 502);
        res.set('Cache-Control', 'no-store');
        if (error.retryAfterSeconds !== undefined) res.set('Retry-After', String(Math.ceil(error.retryAfterSeconds)));
        return res.status(status).json({ error: error.message, code: error.code,
            sourceId, upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds, attempts: error.attempts });
    };
    app.post('/parcel-sources/discover', rateLimit({ windowMs: 60000, limit: 6, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Please wait before checking another source.', code: 'parcel-source-rate-limited', retryAfterSeconds: 60 } }), async (req, res) => {
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
            const lon = (bbox[0] + bbox[2]) / 2, lat = (bbox[1] + bbox[3]) / 2;
            const metricSrid = (lat >= 0 ? 32600 : 32700) + Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
            const boundedFetch = (url, options = {}) => publicFetch(url, { ...options,
                signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
            const result = await discover({ url, city, metricSrid, bbox }, { fetchImpl: boundedFetch });
            const source = decodeCustomSource(encodeCustomSource(result.descriptor));
            // Re-read using the final portable identity before offering it to the browser.
            const adapter = createParcelSource(source, { fetchImpl: boundedFetch });
            const probe = await adapter.queryBounds(bbox);
            if (probe.complete !== true) throw new HttpError(502, 'Source did not return complete parcel coverage.');
            res.set('Cache-Control', 'no-store').json({ source, attempts: result.attempts, parcelCount: probe.features.length });
        } catch (error) { if (!res.destroyed) fail(res, error); }
        finally { clearTimeout(timer); res.off('close', disconnect); }
    });
    app.get('/parcel-sources/:sourceId/info', (req, res) => {
        try {
            const source = sources.find(item => item.id === req.params.sourceId) || resolveParcelSourceDescriptor(req.params.sourceId);
            if (!source) throw new HttpError(404, 'Unknown parcel source.');
            res.set('Cache-Control', 'no-store').json({ source });
        } catch (error) { fail(res, error, req.params.sourceId); }
    });
    const handle = action => async (req, res) => {
        try {
            let adapter = adapters.get(req.params.sourceId);
            if (!adapter && req.params.sourceId.startsWith('custom.')) adapter = runtimeParcelSource(resolveParcelSourceDescriptor(req.params.sourceId));
            if (!adapter) throw new HttpError(404, 'Unknown parcel source.');
            const result = await action(adapter, req);
            res.set('Cache-Control', 'no-store').json(result);
        } catch (error) {
            const status = error.status || 502;
            if (status >= 500) console.error(`[${new Date().toISOString()}] [parcel-sources] ${req.params.sourceId}: ${error.message}`);
            fail(res, error, req.params.sourceId);
        }
    };
    app.get('/parcel-sources/:sourceId', handle((adapter, req) => {
        const bbox = queryString(req.query, 'bbox');
        const ids = queryString(req.query, 'ids');
        const point = queryString(req.query, 'point');
        if ([bbox, ids, point].filter(Boolean).length !== 1) throw new HttpError(400, 'Provide one of bbox, ids, or point.');
        if (point) {
            const coordinates = point.split(',');
            if (coordinates.length !== 2 || coordinates.some(value => !value.trim() || !Number.isFinite(Number(value)))
                || Math.abs(Number(coordinates[0])) > 180 || Math.abs(Number(coordinates[1])) > 90) throw new HttpError(400, 'Invalid WGS84 point.');
            if (typeof adapter.queryPoint !== 'function') throw new HttpError(422, 'This parcel source does not support point queries.');
            return adapter.queryPoint(coordinates.map(Number));
        }
        if (ids) return adapter.queryIds(ids.split(','));
        if (bbox.split(',').some(part => !part.trim())) throw new HttpError(400, 'Invalid bbox.');
        return adapter.queryBounds(bbox.split(',').map(Number));
    }));
    app.post('/parcel-sources/:sourceId/under', handle((adapter, req) => {
        if (req.body?.srid !== undefined && req.body.srid !== 4326) throw new HttpError(400, 'Parcel geometry must use WGS84 (srid 4326).');
        return adapter.queryGeometry(req.body?.geometry);
    }));
}
