// Expiring bearer references address individual draft objects; collections carry member references.
// Cache capacity is a service resource budget, separate from the per-object publication budget.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { canonicalBytes, cidOfObject } from '../cid.js';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/draft-link.js');
const mapShare = require('../../frontend/js/map-share.js');
const unavailable = message => Object.assign(new Error(message), { code: 'draft-reference-expired' });

export function createPreviewLinks({ origin, appOrigin, now = Date.now, ttlMs = 86_400_000, maxEntries = 4096, maxBytes = 128 * 1024 * 1024 }) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0
        || !Number.isFinite(maxBytes) || maxBytes < links.MAX_OBJECT_BYTES) throw new Error('Preview bounds must be positive');
    const base = new URL(origin), app = new URL(appOrigin);
    links.reference(new URL(`/mcp/previews/${'a'.repeat(32)}`, base).href);
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Preview origin must be an origin');
    const entries = new Map(), byContent = new Map(); let bytes = 0;
    const remove = token => { const entry = entries.get(token); if (!entry) return; entries.delete(token); byContent.delete(entry.key); bytes -= entry.size; };
    const prune = () => { for (const [token, entry] of entries) if (entry.expiresAt <= now()) remove(token); };
    const ref = token => new URL(`/mcp/previews/${token}`, base).href;
    function add(record, parcelSourceId, designs) {
        if (canonicalBytes(record).length > links.MAX_OBJECT_BYTES) throw new Error('A private draft object exceeds 10 MiB');
        const cid = cidOfObject(record), key = JSON.stringify([cid, parcelSourceId]);
        const row = { cid, record, parcelSourceId, ...(designs ? { designs } : {}) };
        const size = Buffer.byteLength(JSON.stringify(row));
        if (size > maxBytes) throw Object.assign(new Error('The temporary preview cache is full'), { code: 'preview-cache-full' });
        let token = byContent.get(key);
        if (token) {
            const entry = entries.get(token); entry.expiresAt = now() + ttlMs;
            if (designs) entry.row.designs = designs;
            return { cid, draftRef: ref(token) };
        }
        while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
        token = randomBytes(24).toString('base64url');
        entries.set(token, { key, size, expiresAt: now() + ttlMs, row: structuredClone(row) });
        byContent.set(key, token); bytes += size;
        return { cid, draftRef: ref(token) };
    }
    function create(artifact) {
        prune();
        const { design, agreement, plan, designs = [], parcelSourceId = null } = artifact;
        const record = design || agreement || plan;
        if (!record || !['design/v1', 'agreement/v1', 'plan/v1'].includes(record.schema)) throw new Error('A preview needs a canonical draft record');
        const retained = () => ({ previewUrl: null, previewStatus: 'private-artifact', draftArtifact: artifact,
            previewWarning: 'The temporary preview cache is full. The draft is retained; retry its preview later.' });
        let members, stored;
        try {
            members = design ? null : designs.map(content => add(content, parcelSourceId));
            stored = add(record, parcelSourceId, members);
        } catch (error) {
            if (error.code === 'preview-cache-full') return retained();
            throw error;
        }
        // Never claim a usable collection if capacity eviction removed one of its members.
        if (members?.some(member => !get(new URL(member.draftRef).pathname.split('/').at(-1)))) {
            return retained();
        }
        const url = new URL(record.view?.at ? mapShare.link(new URL('/designs', app).href, record.view) : new URL('/designs', app));
        url.searchParams.set('draft', stored.draftRef);
        if (record.city) url.searchParams.set('city', record.city);
        return { previewUrl: url.href, draftRef: stored.draftRef, previewStatus: 'private-link',
            previewExpiresAt: new Date(entries.get(new URL(stored.draftRef).pathname.split('/').at(-1)).expiresAt).toISOString() };
    }
    function decorate(value) {
        if (!value || typeof value !== 'object' || ['design/v1', 'agreement/v1', 'plan/v1'].includes(value.schema)) return value;
        if (Array.isArray(value)) return value.map(decorate);
        const { draftArtifact, ...rest } = value;
        const out = Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, decorate(item)]));
        return draftArtifact ? { ...out, ...create(draftArtifact) } : out;
    }
    function get(token) { prune(); const entry = entries.get(token); return entry ? structuredClone(entry.row) : null; }
    async function resolve(reference) {
        const url = links.reference(reference);
        if (url.origin !== base.origin) throw new Error('Use a draftRef returned by this server.');
        const row = get(url.pathname.split('/').at(-1));
        if (!row) throw unavailable('This private draft reference expired. Draft it again.');
        if (row.record.schema === 'design/v1') return { design: row.record, parcelSourceId: row.parcelSourceId };
        const designs = [];
        for (const member of row.designs) {
            const child = await resolve(member.draftRef);
            if (!child.design || cidOfObject(child.design) !== member.cid) throw unavailable('A private draft member is unavailable. Draft it again.');
            designs.push(child.design);
        }
        return { [row.record.schema === 'plan/v1' ? 'plan' : 'agreement']: row.record, designs, parcelSourceId: row.parcelSourceId };
    }
    return { decorate, create, get, resolve, clear() { entries.clear(); byContent.clear(); bytes = 0; } };
}
