// Resolves DID Web identity documents and checks their assertion-method wallet claims.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CommunityDidWeb = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const MAX_DOCUMENT_BYTES = 65536;
    const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const HEX_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

    function normalizeDid(input) {
        if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new TypeError('DID must be a non-empty string of at most 2048 characters');
        let value = input.trim();
        if (/^https?:\/\//i.test(value)) {
            const rawPath = value.match(/^https?:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] || '';
            if (rawPath.split('/').some(segment => {
                let decoded = segment;
                try { decoded = decodeURIComponent(segment); } catch { return true; }
                return decoded === '.' || decoded === '..';
            })) {
                throw new TypeError('DID Web URL path cannot traverse directories');
            }
            const url = new URL(value);
            if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:') throw new TypeError('DID Web domain URL must be HTTPS without credentials, query, or fragment');
            const urlPath = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, ':');
            value = url.host.replace(':', '%3A') + (urlPath ? ':' + urlPath : '');
        }
        else if (!value.startsWith('did:web:') && value.includes('/')) value = value.replace(/^\/+|\/+$/g, '').replace(/\//g, ':');
        if (!value.startsWith('did:web:')) value = 'did:web:' + value;
        if (value.includes('?') || value.includes('#') || value.includes('@') || /[\\\s]/.test(value)) throw new TypeError('Invalid DID Web identifier');
        const parts = value.slice('did:web:'.length).split(':');
        if (!parts[0] || parts.some((p, i) => !p || (i > 0 && (!/^[A-Za-z0-9._~-]+$/.test(p) || p === '.' || p === '..')))) throw new TypeError('Invalid DID Web host or path');
        let host = parts.shift();
        if (/%(?!3a)/i.test(host) || /%3a.*%3a/i.test(host)) throw new TypeError('Invalid encoded port');
        host = host.replace(/%3a/i, ':');
        if (host.includes('%') || host.includes('/') || host.includes('\\')) throw new TypeError('Invalid DID Web host');
        const authority = new URL('https://' + host);
        if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) throw new TypeError('Invalid DID Web authority');
        const dnsHost = authority.hostname.toLowerCase();
        if (!dnsHost || dnsHost.includes(':') || dnsHost === 'localhost' || dnsHost.endsWith('.localhost')
            || dnsHost.endsWith('.local') || dnsHost.endsWith('.internal')
            || /^\d+(?:\.\d+){3}$/.test(dnsHost) || !dnsHost.includes('.')
            || !/^[a-z0-9.-]+$/.test(dnsHost) || dnsHost.startsWith('.') || dnsHost.endsWith('.')
            || dnsHost.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
            throw new TypeError('DID Web requires a public DNS hostname');
        }
        const canonicalHost = authority.host.toLowerCase();
        return 'did:web:' + canonicalHost.replace(':', '%3A') + (parts.length ? ':' + parts.join(':') : '');
    }

    function documentUrl(did) {
        const normalized = normalizeDid(did);
        const parts = normalized.slice(8).split(':');
        let host = parts.shift().replace(/%3A/i, ':');
        const path = parts.length ? '/' + parts.map(encodeURIComponent).join('/') : '/.well-known';
        return 'https://' + host + path + '/did.json';
    }

    function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }

    function parseCaip10(value) {
        if (typeof value !== 'string') return null;
        const match = value.match(/^([a-z0-9-]{3,8}):([A-Za-z0-9_-]{1,32}):([-.%a-zA-Z0-9]{1,128})$/);
        if (!match) return null;
        return { namespace: match[1], reference: match[2], address: match[3] };
    }

    function walletMatches(value, accountId) {
        const wallet = parseCaip10(value);
        const account = parseCaip10(accountId);
        if (!wallet || !account || wallet.namespace !== account.namespace || wallet.reference !== account.reference) return false;
        if (wallet.namespace === 'solana') return SOLANA_ADDRESS.test(wallet.address) && wallet.address === account.address;
        if (wallet.namespace === 'eip155') return HEX_EVM_ADDRESS.test(wallet.address) && HEX_EVM_ADDRESS.test(account.address) && wallet.address.toLowerCase() === account.address.toLowerCase();
        return wallet.address === account.address;
    }

    function stableStringify(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }

    async function documentHash(document) {
        const cryptoApi = typeof crypto !== 'undefined' ? crypto : (typeof require === 'function' ? require('node:crypto').webcrypto : null);
        if (!cryptoApi || !cryptoApi.subtle) throw new Error('SHA-256 is unavailable');
        const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(document)));
        return 'sha256:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }

    function authorizedWallet(document, did, accountId) {
        let normalized;
        try { normalized = normalizeDid(did); } catch { return false; }
        if (!document || document.id !== normalized) return false;
        const methods = new Map();
        for (const method of asArray(document.verificationMethod)) {
            if (method && typeof method.id === 'string') methods.set(method.id, method);
        }
        for (const entry of asArray(document.assertionMethod)) {
            let method;
            if (typeof entry === 'string') method = methods.get(entry);
            else if (entry && typeof entry === 'object') method = entry;
            if (method && typeof method.id === 'string'
                && method.id.startsWith(normalized + '#') && method.id.length > normalized.length + 1
                && method.controller === normalized && walletMatches(method.blockchainAccountId, accountId)) return true;
        }
        return false;
    }

    async function resolve(did, options) {
        const normalized = normalizeDid(did);
        const fetchImpl = options && options.fetch || (typeof fetch === 'function' ? fetch : null);
        if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable');
        if (typeof AbortController !== 'function') throw new Error('AbortController is unavailable');
        const controller = new AbortController();
        const timeoutMs = Math.min(15000, Math.max(1, Number(options && options.timeoutMs) || 15000));
        const timer = setTimeout(() => controller.abort(new Error('DID Web resolution timed out')), timeoutMs);
        const externalSignal = options && options.signal;
        const abortFromCaller = () => controller.abort(externalSignal.reason);
        if (externalSignal) {
            if (externalSignal.aborted) abortFromCaller();
            else externalSignal.addEventListener('abort', abortFromCaller, { once: true });
        }
        let response;
        try {
            response = await fetchImpl(documentUrl(normalized), { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
        } catch (error) {
            clearTimeout(timer);
            if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
            throw error;
        }
        try {
            if (!response || !response.ok) throw new Error('DID Web document request failed');
            const declaredLength = Number(response.headers && response.headers.get && response.headers.get('content-length'));
            if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) throw new Error('DID Web document exceeds size limit');
            if (!response.body || typeof response.body.getReader !== 'function') throw new Error('DID Web response does not support bounded streaming');
            let text;
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            const readChunk = () => new Promise((resolve, reject) => {
                const onAbort = () => {
                    controller.signal.removeEventListener('abort', onAbort);
                    reject(controller.signal.reason || new Error('DID Web resolution aborted'));
                };
                controller.signal.addEventListener('abort', onAbort, { once: true });
                reader.read().then(value => {
                    controller.signal.removeEventListener('abort', onAbort);
                    resolve(value);
                }, error => {
                    controller.signal.removeEventListener('abort', onAbort);
                    reject(error);
                });
            });
            while (true) {
                if (controller.signal.aborted) { reader.cancel().catch(() => {}); throw controller.signal.reason || new Error('DID Web resolution aborted'); }
                let item;
                try { item = await readChunk(); }
                catch (error) { reader.cancel().catch(() => {}); throw error; }
                if (item.done) break;
                size += item.value.byteLength;
                if (size > MAX_DOCUMENT_BYTES) { reader.cancel().catch(() => {}); throw new Error('DID Web document exceeds size limit'); }
                chunks.push(item.value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const document = JSON.parse(text);
            if (!document || document.id !== normalized) throw new Error('Resolved DID document ID does not match requested DID');
            return { did: normalized, document, hash: await documentHash(document) };
        } finally {
            clearTimeout(timer);
            if (externalSignal) externalSignal.removeEventListener('abort', abortFromCaller);
        }
    }

    return { normalizeDid, documentUrl, parseCaip10, walletMatches, authorizedWallet, documentHash, resolve, MAX_DOCUMENT_BYTES };
});
