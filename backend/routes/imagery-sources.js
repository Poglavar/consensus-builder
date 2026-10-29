// Read-only gateway for verified public imagery. The browser retains only the portable source id;
// each image request decodes it and uses the same DNS/redirect guard as parcel source discovery.
import rateLimit from 'express-rate-limit';
import { HttpError } from '../utils/helpers.js';
import { validateBounds, discoverQuery } from '../parcels/source-contract.js';
import { createPublicSourceFetch, validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { decodeImagerySource, encodeImagerySource } from '../imagery/custom-source.js';
import { discoverImagerySource, xyzTileBounds } from '../imagery/discovery.js';
import { imageryReader } from '../imagery/sources.js';

const invalid = message => Object.assign(new HttpError(400, message), { code: 'invalid-imagery-request' });
const replyError = (res, error) => {
    if (res.destroyed) return;
    const status = error.status || 502;
    if (status >= 500) console.error(`[${new Date().toISOString()}] [imagery-sources] ${error.code || 'unavailable'}: ${error.message}`);
    res.set('Cache-Control', 'no-store');
    res.status(status).json({ error: error.message, code: error.code || 'imagery-source-unavailable',
        upstreamStatus: error.upstreamStatus, retryAfterSeconds: error.retryAfterSeconds });
};
const parseBbox = raw => {
    if (typeof raw !== 'string' || raw.length > 160 || raw.split(',').length !== 4
        || raw.split(',').some(part => !part.trim())) throw invalid('Expected WGS84 bbox west,south,east,north.');
    return validateBounds(raw.split(',').map(Number), 1e7);
};
const dimension = raw => {
    const n = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isInteger(n) || n < 1 || n > 512) throw invalid('Map dimensions must be 1–512 pixels.');
    return n;
};

export function setupImagerySourcesRoute(app, { publicFetch = createPublicSourceFetch({ maxBytes: 4 * 1024 * 1024 }),
    discover = discoverImagerySource } = {}) {
    const discoverLimit = rateLimit({ windowMs: 60000, limit: 6, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Please wait before checking another imagery source.', code: 'imagery-source-rate-limited' } });
    const tileLimit = rateLimit({ windowMs: 60000, limit: 900, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Imagery request limit reached.', code: 'imagery-source-rate-limited' } });
    app.get('/imagery-sources/discover', discoverLimit, async (req, res) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
            const input = discoverQuery(req.query);
            const url = validatePublicSourceUrl(input.url);
            if (url.href.length > 2000) throw invalid('Imagery URL is too long.');
            const city = input.city;
            if (city !== undefined && (typeof city !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(city))) throw invalid('Invalid source label.');
            const bbox = validateBounds(input.bbox, 25);
            const layers = input.layers;
            if (layers !== undefined && (!Array.isArray(layers) || !layers.length || layers.length > 8
                || layers.some(layer => typeof layer !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(layer))))
                throw invalid('Choose up to eight named WMS layers.');
            const boundedFetch = (target, options = {}) => publicFetch(target, { ...options,
                signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal });
            const result = await discover({ url, city, bbox, layers }, { fetchImpl: boundedFetch });
            if (result.selectionRequired) {
                return res.set('Cache-Control', 'no-store').json({ selectionRequired: true,
                    layers: result.layers, attempts: result.attempts });
            }
            const source = decodeImagerySource(encodeImagerySource(result.descriptor));
            res.set('Cache-Control', 'no-store').json({ source, attempts: result.attempts });
        } catch (error) { replyError(res, error); }
        finally { clearTimeout(timer); res.off('close', disconnect); }
    });
    const sendImage = async (req, res, buildRequest) => {
        try {
            const source = decodeImagerySource(req.params.sourceId);
            const reader = imageryReader(source, publicFetch);
            const spec = buildRequest(source, reader);
            const image = await reader.image(spec);
            res.set({ 'Content-Type': image.contentType, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
            res.send(image.bytes);
        } catch (error) { replyError(res, error); }
    };
    app.get('/imagery-sources/:sourceId/tiles/:z/:x/:y', tileLimit, (req, res) => sendImage(req, res, (source, reader) => {
        const coords = ['z', 'x', 'y'].map(key => req.params[key]);
        if (coords.some(raw => !/^\d+$/.test(raw))) throw invalid('Invalid XYZ tile coordinates.');
        const [z, x, y] = coords.map(Number);
        if (z > 22 || z < (source.minZoom ?? 0) || z > (source.maxZoom ?? 22) || x >= 2 ** z || y >= 2 ** z)
            throw invalid('XYZ tile is outside this source.');
        if (source.adapter === 'xyz') return reader.tileRequest(z, x, y);
        const bounds = xyzTileBounds(z, x, y);
        if (source.bounds && (bounds[0] >= source.bounds[2] || source.bounds[0] >= bounds[2]
            || bounds[1] >= source.bounds[3] || source.bounds[1] >= bounds[3]))
            throw Object.assign(new HttpError(404, 'Tile lies outside imagery coverage.'), { code: 'imagery-outside-bounds' });
        return reader.tileRequest(z, x, y);
    }));
    app.get('/imagery-sources/:sourceId/map', tileLimit, (req, res) => sendImage(req, res, (source, reader) => {
        if (typeof reader.mapRequest !== 'function') throw invalid('This imagery source is not WMS.');
        const bbox = parseBbox(req.query.bbox), width = dimension(req.query.width), height = dimension(req.query.height);
        return reader.mapRequest(bbox, width, height);
    }));
}
