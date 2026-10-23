// Short bearer links avoid asking a model to reproduce thousands of compressed URL characters.
// Only the already-generated fragment URL lives in bounded, expiring process memory; no pin/index.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const links = createRequire(import.meta.url)('../../frontend/js/draft-link.js');

export function createPreviewLinks({ origin, appOrigin, now = Date.now, ttlMs = 86_400_000, maxEntries = 256 }) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Preview bounds must be positive');
    const base = new URL(origin);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error('Preview origin must be HTTPS or loopback HTTP');
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Preview origin must be an origin');
    const entries = new Map(), byTarget = new Map();
    const remove = token => { const entry = entries.get(token); entries.delete(token); if (entry) byTarget.delete(entry.target); };
    const prune = () => { for (const [token, entry] of entries) if (entry.expiresAt <= now()) remove(token); };
    function decorate(value) {
        if (!value || typeof value !== 'object' || ['design/v1', 'agreement/v1'].includes(value.schema)) return value;
        if (Array.isArray(value)) return value.map(decorate);
        const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decorate(item)]));
        if (typeof out.previewUrl !== 'string') return out;
        const target = new URL(out.previewUrl);
        if (target.origin !== new URL(appOrigin).origin || target.pathname !== '/designs' || !target.hash.startsWith('#draft=')) return out;
        prune();
        let token = byTarget.get(target.href);
        if (!token) {
            while (entries.size >= maxEntries) remove(entries.keys().next().value);
            token = randomBytes(24).toString('base64url');
            entries.set(token, { target: target.href, expiresAt: now() + ttlMs }); byTarget.set(target.href, token);
        }
        const reference = new URL(`/mcp/previews/${token}`, base).href;
        return { ...out, previewUrl: reference, draftRef: reference, previewStatus: 'private-link',
            previewExpiresAt: new Date(entries.get(token).expiresAt).toISOString() };
    }
    const get = token => { prune(); return entries.get(token)?.target || null; };
    return { decorate, get, async resolve(reference) {
        const url = new URL(reference);
        if (url.origin !== base.origin || !/^\/mcp\/previews\/[\w-]{32}$/.test(url.pathname) || url.search || url.hash) throw new Error('Use a draftRef returned by this server.');
        const target = get(url.pathname.split('/').at(-1));
        if (!target) throw Object.assign(new Error('This private draft reference expired. Draft it again.'), { code: 'draft-reference-expired' });
        return links.parse(new URL(target).hash);
    }, clear() { entries.clear(); byTarget.clear(); } };
}
