// Fetch user-supplied public sources without letting DNS or redirects reach private networks.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { HttpError } from '../utils/helpers.js';

function invalidUrl() { const error = new HttpError(400, 'Invalid public source URL.'); error.code = 'invalid-source-url'; return error; }

export function validatePublicSourceUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw invalidUrl(); }
    if (url.href.length > 16384 || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password
        || !url.hostname || url.hash || [...url.searchParams.keys()].some(key => /^(?:token|access_token|api[_-]?key|key|password|secret|authorization)$/i.test(key))
        || (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicSourceAddress(url.hostname.replace(/^\[|\]$/g, '')))) throw invalidUrl();
    return url;
}

function ipv4Number(address) { return address.split('.').reduce((n, part) => n * 256 + Number(part), 0); }
function ipv6Number(address) {
    let value = address;
    if (value.includes('.')) {
        const index = value.lastIndexOf(':'), v4 = ipv4Number(value.slice(index + 1));
        value = `${value.slice(0, index)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
    }
    const parts = value.split('::'), left = parts[0] ? parts[0].split(':') : [], right = parts[1] ? parts[1].split(':') : [];
    const groups = parts.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return groups.reduce((n, group) => (n << 16n) + BigInt(`0x${group}`), 0n);
}
function inV4(address, base, bits) { return Math.floor(address / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits)); }
function inV6(address, base, bits) { return address >> BigInt(128 - bits) === ipv6Number(base) >> BigInt(128 - bits); }
export function isPublicSourceAddress(address) {
    if (typeof address !== 'string' || address.includes('%')) return false;
    const family = isIP(address);
    if (family === 4) {
        const value = ipv4Number(address);
        return ![['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
            ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
            ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]
            .some(([base,bits]) => inV4(value,base,bits));
    }
    if (family === 6) {
        const value = ipv6Number(address);
        // Admit global unicast only; reject transition/tunnel and documentation ranges too.
        return inV6(value,'2000::',3) && ![['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]
            .some(([base,bits]) => inV6(value,base,bits));
    }
    return false;
}

export function createPublicSourceFetch({ lookupImpl = lookup, requestImpl = request, maxBytes = 8 * 1024 * 1024,
    timeoutMs = 15000, maxRedirects = 3, maxRequestBytes = 16 * 1024 } = {}) {
    if (typeof lookupImpl !== 'function' || typeof requestImpl !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1
        || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 16 * 1024
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) {
        throw new Error('Invalid public source fetch limits.');
    }
    return async function publicSourceFetch(value, options = {}) {
        const method = options.method ?? 'GET';
        let headers;
        try { headers = new Headers(options.headers); } catch { throw new Error('Public source request headers are invalid.'); }
        if (!['GET', 'POST'].includes(method) || (method === 'GET' && options.body !== undefined)
            || (method === 'POST' && (typeof options.body !== 'string' || Buffer.byteLength(options.body) > maxRequestBytes
                || headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded'))) {
            throw new Error('Public source accepts GET or bounded form POST only.');
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        const signal = controller.signal;
        const timer = setTimeout(abort, timeoutMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        const check = () => { if (signal.aborted) throw new Error('Public source request aborted or timed out.'); };
        async function resolve(url) {
            const host = url.hostname.replace(/^\[|\]$/g, '');
            let answers;
            try { answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupImpl(host, { all: true, verbatim: true }); }
            catch { throw new Error('Public source DNS lookup failed.'); }
            check();
            if (!Array.isArray(answers) || !answers.length || answers.some(a => !isPublicSourceAddress(a.address)
                || a.family !== isIP(a.address))) throw new Error('Public source DNS contains a non-public address.');
            return { host, address: answers[0] };
        }
        async function perform(url) {
            const { host, address } = await resolve(url);
            check();
            return new Promise((resolveResponse, reject) => {
                let req, response, settled = false;
                const finish = (error, result) => {
                    if (settled) return;
                    settled = true; signal.removeEventListener('abort', onAbort);
                    if (error) { response?.destroy(); req?.destroy(); reject(error); } else resolveResponse(result);
                };
                const onAbort = () => finish(new Error('Public source request aborted or timed out.'));
                signal.addEventListener('abort', onAbort, { once: true });
                try {
                    req = requestImpl({ protocol: 'https:', hostname: host, port: 443, path: `${url.pathname}${url.search}`,
                        method, agent: false, servername: isIP(host) ? undefined : host, rejectUnauthorized: true,
                        // A descriptive User-Agent: Overpass (and other public APIs) refuse requests without one.
                        headers: { Accept: 'application/geo+json, application/json', 'Accept-Encoding': 'identity',
                            'User-Agent': 'consensus-builder/1.0 (+https://urbangametheory.xyz)',
                            ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(options.body)) } : {}) },
                        lookup: (_hostname, opts, callback) => {
                            if (typeof opts === 'function') { callback = opts; opts = {}; }
                            if (opts?.all) callback(null, [{ ...address }]); else callback(null, address.address, address.family);
                        } }, incoming => {
                        response = incoming;
                        const status = incoming.statusCode;
                        if ([301,302,303,307,308].includes(status)) {
                            const location = incoming.headers.location;
                            incoming.destroy(); finish(null, { location, status }); return;
                        }
                        const length = incoming.headers['content-length'];
                        if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) {
                            finish(new Error('Public source response exceeds byte limit or has invalid length.')); return;
                        }
                        const encoding = incoming.headers['content-encoding'];
                        if (encoding && encoding !== 'identity') { finish(new Error('Public source compressed responses are unsupported.')); return; }
                        const chunks = []; let bytes = 0;
                        incoming.on('data', chunk => {
                            if (settled) return;
                            const buffer = Buffer.from(chunk); bytes += buffer.length;
                            if (bytes > maxBytes) finish(new Error('Public source response exceeds byte limit.')); else chunks.push(buffer);
                        });
                        incoming.on('error', () => finish(new Error('Public source response failed.')));
                        incoming.on('aborted', () => finish(new Error('Public source response was incomplete.')));
                        incoming.on('end', () => {
                            if (settled) return;
                            if (length !== undefined && bytes !== Number(length)) { finish(new Error('Public source response was incomplete.')); return; }
                            const headers = new Headers();
                            for (const [name,val] of Object.entries(incoming.headers)) {
                                if (val !== undefined) headers.set(name, Array.isArray(val) ? val.join(', ') : String(val));
                            }
                            try {
                                const result = new Response([204,205,304].includes(status) ? null : Buffer.concat(chunks), { status, headers });
                                Object.defineProperty(result, 'url', { value: url.href });
                                finish(null, { response: result });
                            } catch { finish(new Error('Invalid public source response.')); }
                        });
                    });
                    req.on('error', () => finish(new Error('Public source request failed.')));
                    check(); req.end(method === 'POST' ? options.body : undefined);
                } catch { finish(new Error('Public source request failed.')); }
            });
        }
        const work = async () => {
            let url = validatePublicSourceUrl(value);
            for (let redirects = 0; ; redirects++) {
                check(); const result = await perform(url);
                if (result.response) return result.response;
                if (method === 'POST' || options.redirect === 'error' || redirects >= maxRedirects || !result.location) throw new Error('Public source redirect rejected.');
                try { url = validatePublicSourceUrl(new URL(result.location, url)); } catch { throw new Error('Public source redirect rejected.'); }
            }
        };
        let rejectAbort;
        const onAbort = () => rejectAbort(new Error('Public source request aborted or timed out.'));
        const aborted = new Promise((_, reject) => { rejectAbort = reject; });
        signal.addEventListener('abort', onAbort, { once: true });
        try { check(); return await Promise.race([work(), aborted]); }
        catch (error) {
            // Never expose request URLs, user credentials or a transport's raw error text.
            if (error.message?.startsWith('Public source') || error.message === 'Invalid public source URL.') throw error;
            throw new Error('Public source request failed.');
        } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); options.signal?.removeEventListener('abort', abort); }
    };
}
