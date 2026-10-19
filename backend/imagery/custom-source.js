// Portable, city-bound imagery descriptors. Decoding revalidates every field; a source id is a
// configuration, not a server-side registration or proof of permission to fetch another URL.
import { createHash } from 'node:crypto';
import { HttpError } from '../utils/helpers.js';
import { validatePublicSourceUrl } from '../parcels/public-source-fetch.js';

const FIELDS = ['kind', 'adapter', 'endpoint', 'cityIds', 'name', 'layers', 'version', 'crs', 'format',
    'bounds', 'attribution', 'minZoom', 'maxZoom'];
const invalid = () => Object.assign(new HttpError(400, 'Invalid imagery source configuration.'), { code: 'invalid-imagery-source' });
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 300 && !/[<>\r\n]/.test(value);
const validBounds = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite)
    && b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90 && b[0] < b[2] && b[1] < b[3];

export function canonicalImageryConfig(input) {
    if (!input || input.kind !== 'imagery' || !['xyz', 'wms'].includes(input.adapter)) throw invalid();
    const config = Object.fromEntries(FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    if (!Array.isArray(config.cityIds) || config.cityIds.length !== 1
        || !/^[a-z][a-z0-9_]{0,79}$/.test(config.cityIds[0]) || !label(config.name)
        || (config.attribution !== undefined && !label(config.attribution))
        || (config.bounds !== undefined && !validBounds(config.bounds))) throw invalid();
    let url;
    try { url = validatePublicSourceUrl(config.endpoint); } catch { throw invalid(); }
    // Public sources only. These keys can hide credentials even when the common public URL guard
    // does not know a provider's spelling (for example authKey).
    if ([...url.searchParams.keys()].some(key => /(?:auth|token|key|secret|password|signature|^sig$)/i.test(key))) throw invalid();
    config.endpoint = url.href;
    if (config.adapter === 'xyz') {
        config.endpoint = config.endpoint.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
        for (const token of ['z', 'x', 'y']) {
            if (config.endpoint.split(`{${token}}`).length !== 2) throw invalid();
        }
        if (/[{}]/.test(config.endpoint.replace(/\{[zxy]\}/g, ''))) throw invalid();
        if (['layers', 'version', 'crs', 'format'].some(key => config[key] !== undefined)) throw invalid();
    } else {
        if (!Array.isArray(config.layers) || !config.layers.length || config.layers.length > 8
            || config.layers.some(layer => typeof layer !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(layer))
            || !['1.1.1', '1.3.0'].includes(config.version)
            || !['EPSG:3857', 'CRS:84', 'EPSG:4326'].includes(config.crs)
            || !['image/png', 'image/jpeg'].includes(config.format)
            || config.minZoom !== undefined || config.maxZoom !== undefined) throw invalid();
        if (config.version === '1.1.1' && config.crs === 'CRS:84') throw invalid();
    }
    if (config.minZoom !== undefined && (!Number.isInteger(config.minZoom) || config.minZoom < 0 || config.minZoom > 22)) throw invalid();
    if (config.maxZoom !== undefined && (!Number.isInteger(config.maxZoom) || config.maxZoom < 0 || config.maxZoom > 22
        || config.maxZoom < (config.minZoom ?? 0))) throw invalid();
    if (JSON.stringify(config).length > 4000) throw invalid();
    return config;
}

export function encodeImagerySource(input) {
    const config = canonicalImageryConfig(input);
    const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 20);
    return 'imagery.' + Buffer.from(JSON.stringify({ ...config, idPrefix: `CUSTOM-I-${hash}-` })).toString('base64url');
}

export function decodeImagerySource(id) {
    if (typeof id !== 'string' || !/^imagery\.[A-Za-z0-9_-]{1,6500}$/.test(id)) throw invalid();
    let raw, config;
    try {
        raw = JSON.parse(Buffer.from(id.slice(8), 'base64url').toString('utf8'));
        config = canonicalImageryConfig(raw);
    } catch { throw invalid(); }
    if (encodeImagerySource(config) !== id) throw invalid();
    return { ...config, id, idPrefix: raw.idPrefix, defaultForCity: false };
}
