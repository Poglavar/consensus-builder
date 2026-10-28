// Read only bounded, anonymous Praia Grande WFS queries through the declared public text reader.
// This transport preserves source JSON geometry, never uses CQL, and disables reader caching.
import { upstreamError } from './source-contract.js';

export const PRAIA_GRANDE_ENDPOINT = 'https://geoserver.praiagrande.sp.gov.br/PraiaGrandePlantaCadastral/wfs';
const READER = 'https://r.jina.ai/';
const FILTER_START = '<Filter xmlns="http://www.opengis.net/ogc">';
const comparison = '<PropertyIsEqualTo><PropertyName>top_id</PropertyName><Literal>[0-9]+</Literal></PropertyIsEqualTo>';
const exactFilter = new RegExp(`^${FILTER_START}(?:${comparison}|<Or>(?:${comparison}){2,80}</Or>)</Filter>$`);

export function isPraiaGrandeReaderSource(descriptor) {
    return descriptor?.id === 'br-praia-grande-geopg-lotes' && descriptor.adapter === 'wfs'
        && descriptor.endpoint === PRAIA_GRANDE_ENDPOINT && descriptor.wfsPublicReader === 'jina-v1';
}

function validQuery(url) {
    if (url.origin + url.pathname !== PRAIA_GRANDE_ENDPOINT || url.username || url.password || url.hash) return false;
    const p = url.searchParams;
    const allowed = ['service', 'version', 'request', 'typeName', 'outputFormat', 'srsName',
        'propertyName', 'sortBy', 'startIndex', 'maxFeatures', 'bbox', 'filter'];
    if ([...p.keys()].some(key => !allowed.includes(key) || p.getAll(key).length !== 1)
        || p.get('service') !== 'WFS' || p.get('version') !== '1.1.0' || p.get('request') !== 'GetFeature'
        || p.get('typeName') !== 'PraiaGrandePlantaCadastral:lotes' || p.get('outputFormat') !== 'application/json'
        || p.get('srsName') !== 'EPSG:4326' || p.get('propertyName') !== 'the_geom,top_id'
        || (p.has('sortBy') && p.get('sortBy') !== 'top_id')
        || !/^[1-9][0-9]{0,2}$/.test(p.get('maxFeatures') || '')
        || (p.has('startIndex') && !/^(0|[1-9][0-9]{0,4})$/.test(p.get('startIndex')))) return false;
    if (p.has('filter')) return !p.has('bbox') && exactFilter.test(p.get('filter'));
    if (!p.has('bbox')) return false;
    const parts = p.get('bbox').split(',');
    const bounds = parts.slice(0, 4).map(Number);
    return parts.length === 5 && parts[4] === 'CRS:84' && bounds.every(Number.isFinite)
        && bounds[0] >= -46.7 && bounds[2] <= -46.3 && bounds[1] >= -24.2 && bounds[3] <= -23.8
        && bounds[0] < bounds[2] && bounds[1] < bounds[3]
        && (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) < 0.003;
}

export function isPraiaGrandeReaderRequest(url, descriptor) {
    if (!isPraiaGrandeReaderSource(descriptor) || url.origin !== 'https://r.jina.ai'
        || !url.href.startsWith(READER + PRAIA_GRANDE_ENDPOINT) || url.username || url.password || url.hash) return false;
    try { return validQuery(new URL(url.href.slice(READER.length))); } catch { return false; }
}

export function createPraiaGrandeReaderFetch(descriptor, fetchImpl) {
    if (!isPraiaGrandeReaderSource(descriptor) || descriptor.idFilter !== 'ogc' || descriptor.idField !== 'top_id'
        || descriptor.idType !== 'string' || descriptor.responseSrid !== 4326
        || descriptor.requestProperties !== true || descriptor.geometryField !== 'the_geom'
        || JSON.stringify(descriptor.outFields) !== '["top_id"]'
        || !Number.isSafeInteger(descriptor.maxResponseBytes) || descriptor.maxResponseBytes < 1
        || descriptor.maxResponseBytes > 16 * 1024 * 1024) throw new Error('Invalid Praia Grande public-reader descriptor.');
    return async (input, options = {}) => {
        const source = new URL(input);
        if (!validQuery(source) || ![undefined, 'GET'].includes(options.method) || options.body !== undefined) {
            throw upstreamError('Invalid Praia Grande bounded WFS request.', 400);
        }
        const response = await fetchImpl(READER + source.href, { signal: options.signal, redirect: 'error',
            credentials: 'omit', cache: 'no-store', headers: { Accept: 'text/plain', 'X-No-Cache': 'true' } });
        if (!response.ok) return response;
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('Praia Grande reader omitted its response body.');
        const chunks = []; let bytes = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > descriptor.maxResponseBytes) throw upstreamError('Praia Grande reader exceeded the response byte limit.');
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const merged = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
        const text = new TextDecoder().decode(merged);
        const marker = '\nMarkdown Content:\n';
        const index = text.indexOf(marker);
        const reported = /^URL Source: (.+)$/m.exec(text)?.[1];
        let urlMatches = false;
        try { urlMatches = decodeURIComponent(reported) === decodeURIComponent(source.href); } catch { /* Invalid reader envelope. */ }
        if (index < 0 || !urlMatches || /^Warning:/m.test(text.slice(0, index))) {
            throw upstreamError('Praia Grande reader returned an unverified upstream response.');
        }
        // The shared WFS parser validates the untouched JSON and all parcel identities.
        return new Response(text.slice(index + marker.length).trim(), { headers: { 'content-type': 'application/json' } });
    };
}
