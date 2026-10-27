// Follow only explicitly observed public archive origins. The supplied relay transport
// still validates DNS/public addresses and TLS on every hop; no cookies or credentials.
import { upstreamError } from './source-contract.js';

export function createArchiveRangeFetch(descriptor, transport) {
    const endpoint = new URL(descriptor.endpoint), values = descriptor.archiveRedirectOrigins;
    if (!Array.isArray(values) || !values.length || values.length > 4 || values.some(value => {
        try { const url = new URL(value); return url.protocol !== 'https:' || url.origin !== value || url.username || url.password; }
        catch { return true; }
    })) throw new Error('Invalid archive redirect origins.');
    const origins = new Set([endpoint.origin, ...values]);
    return async (input, options = {}) => {
        let current = new URL(input);
        const headers = new Headers(options.headers);
        if (current.href !== endpoint.href || (options.method || 'GET') !== 'GET' || options.body !== undefined
            || [...headers.keys()].some(key => !['accept', 'range', 'if-match'].includes(key))) throw upstreamError('Invalid fixed archive range request.');
        for (let hop = 0; hop <= 4; hop++) {
            const response = await transport(current, { ...options, headers });
            if (![301, 302, 303, 307, 308].includes(response.status)) return response;
            let next;
            try { next = new URL(response.headers.get('location'), current); }
            catch { /* Rejected below after cancelling the body. */ }
            await response.body?.cancel().catch(() => {});
            if (hop === 4 || !next || next.protocol !== 'https:' || next.username || next.password || next.hash
                || !origins.has(next.origin)) throw upstreamError('Archive redirect is outside its observed public origins.');
            current = next;
        }
    };
}
