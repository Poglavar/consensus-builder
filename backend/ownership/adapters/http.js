// Ownership adapter for a linked endpoint: fetches the URL registered for a source in
// source-catalog.json (never one a client supplies) and returns its answer for contract validation.
import { HttpError } from '../../utils/helpers.js';

export const DEFAULT_HTTP_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 20000;

// Called once per declaration at registry build, so a bad registration stops startup.
export function validateHttpDeclaration(http, sourceId) {
    const fail = message => { throw new Error(`Ownership link for ${sourceId}: ${message}`); };
    if (!http || typeof http !== 'object') fail('http must be an object');
    if (typeof http.urlTemplate !== 'string' || !http.urlTemplate.includes('{parcelId}')) fail('urlTemplate must contain {parcelId}');
    let url;
    try { url = new URL(http.urlTemplate.replace('{parcelId}', 'x')); } catch (_) { fail('urlTemplate is not a URL'); }
    if (url.protocol !== 'https:') fail('urlTemplate must use https');
    if (http.timeoutMs !== undefined && !(Number.isSafeInteger(http.timeoutMs) && http.timeoutMs > 0 && http.timeoutMs <= MAX_TIMEOUT_MS)) {
        fail(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
    }
}

export const httpAdapter = {
    name: 'http',
    async lookup({ parcelId, declaration, fetchImpl = globalThis.fetch }) {
        const { urlTemplate, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = declaration.http;
        const url = urlTemplate.replaceAll('{parcelId}', encodeURIComponent(parcelId));
        let response;
        try {
            response = await fetchImpl(url, {
                headers: { Accept: 'application/json' },
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
            throw Object.assign(new HttpError(timedOut ? 504 : 502, timedOut
                ? `Linked ownership endpoint did not answer within ${timeoutMs} ms.`
                : 'Linked ownership endpoint could not be reached.'), { cause: error, code: 'ownership-upstream' });
        }
        if (response.status === 404) return null;
        if (!response.ok) {
            throw Object.assign(new HttpError(502, `Linked ownership endpoint answered HTTP ${response.status}.`), { code: 'ownership-upstream' });
        }
        try {
            return await response.json();
        } catch (error) {
            throw Object.assign(new HttpError(502, 'Linked ownership endpoint answered with invalid JSON.'), { cause: error, code: 'ownership-upstream' });
        }
    }
};
