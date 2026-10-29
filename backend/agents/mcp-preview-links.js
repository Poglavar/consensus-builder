// Expiring bearer references address individual durable private draft objects.
import { createRequire } from 'node:module';
import { canonicalBytes, cidOfObject } from '../cid.js';
import { createDraftStore, draftMembersMatch } from './mcp-draft-store.js';
import { isTrustedMetadata } from './mcp-results.js';
const require = createRequire(import.meta.url);
const links = require('../../frontend/js/draft-link.js');
const mapShare = require('../../frontend/js/map-share.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const unavailable = message => Object.assign(new Error(message), { code: 'draft-reference-expired' });

export function createPreviewLinks({ origin, appOrigin, storeDirectory, now = Date.now, ttlMs = 86_400_000, maxEntries = 4096, maxBytes = 128 * 1024 * 1024 }) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0
        || !Number.isFinite(maxBytes) || maxBytes < links.MAX_OBJECT_BYTES) throw new Error('Preview bounds must be positive');
    const base = new URL(origin), app = new URL(appOrigin);
    links.reference(new URL(`/mcp/previews/${'a'.repeat(32)}`, base).href);
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Preview origin must be an origin');
    const store = createDraftStore({ directory: storeDirectory, now, maxEntries, maxBytes });
    const ref = token => new URL(`/mcp/previews/${token}`, base).href;
    function create(artifact) {
        const { design, agreement, plan, designs = [], parcelSourceId = null, designSources, when = null, buildout = null } = artifact;
        const record = design || agreement || plan;
        if (!record || !['design/v1', 'agreement/v1', 'plan/v1'].includes(record.schema)) throw new Error('A preview needs a canonical draft record');
        let verifiedPlan = plan;
        if (agreement) {
            const content = plan?.content || plan;
            const planCid = plan?.content ? plan.cid : content ? cidOfObject(content) : null;
            if (Object.hasOwn(agreement, 'designs') || Object.hasOwn(agreement, 'designCids')
                || !content || planCid !== agreement.planCid || cidOfObject(content) !== planCid
                || content.schema !== PlanRecord.SCHEMA || PlanRecord.validate(content)) {
                throw Object.assign(new Error('An agreement preview needs its exact valid plan/v1 matching planCid and no inline membership.'), { code: 'invalid-draft-plan' });
            }
            verifiedPlan = { cid: planCid, content };
        }
        if (!design && !draftMembersMatch(record, designs.map(content => ({ cid: cidOfObject(content) })), verifiedPlan))
            throw Object.assign(new Error('Private collection members must exactly match its canonical design CIDs.'), { code: 'invalid-draft-members' });
        let stored;
        try {
            stored = store.putBatch(add => {
                const save = (content, source, members) => {
                    if (canonicalBytes(content).length > links.MAX_OBJECT_BYTES) throw new Error('A private draft object exceeds 10 MiB');
                    const cid = cidOfObject(content);
                    const agreementPlan = content === agreement ? verifiedPlan : null;
                    const row = { cid, record: content, parcelSourceId: source, ...(agreementPlan ? { plan: agreementPlan } : {}), ...(members ? { designs: members } : {}), ...(members && designSources ? { designSources } : {}) };
                    const key = JSON.stringify([cid, source, members?.map(member => member.draftRef) || null]);
                    return add(key, row);
                };
                const members = design ? null : designs.map(content => {
                    const member = save(content, designSources && Object.hasOwn(designSources, cidOfObject(content)) ? designSources[cidOfObject(content)] : parcelSourceId);
                    return { cid: member.row.cid, draftRef: ref(member.token) };
                });
                return save(record, parcelSourceId, members);
            }, now() + ttlMs);
        } catch (error) {
            if (error.code === 'preview-cache-full') return { previewUrl: null, previewStatus: 'private-artifact', draftArtifact: artifact,
                previewWarning: 'Private draft storage is full. Keep or export this draft artifact; existing unexpired references are retained.' };
            throw error;
        }
        const view = record.view || (record.schema === 'agreement/v1' ? verifiedPlan.content.view : null);
        const url = new URL(view?.at ? mapShare.link(new URL('/designs', app).href, view) : new URL('/designs', app));
        url.searchParams.set('draft', ref(stored.token));
        if (record.city) url.searchParams.set('city', record.city);
        if (when) url.searchParams.set('when', when);
        if (buildout) url.searchParams.set('buildout', buildout);
        return { previewUrl: url.href, draftRef: ref(stored.token), previewStatus: 'private-link', previewExpiresAt: new Date(stored.expiresAt).toISOString() };
    }
    function decorate(value) {
        if (!value || typeof value !== 'object' || isTrustedMetadata(value) || ['design/v1', 'agreement/v1', 'plan/v1'].includes(value.schema)) return value;
        if (Array.isArray(value)) return value.map(decorate);
        const { draftArtifact, ...rest } = value;
        const out = Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, decorate(item)]));
        return draftArtifact ? { ...out, ...create(draftArtifact) } : out;
    }
    function get(token) { return store.get(token)?.row || null; }
    function readReference(reference) {
        const url = links.reference(reference);
        if (url.origin !== base.origin) throw new Error('Use a draftRef returned by this server.');
        const row = get(url.pathname.split('/').at(-1));
        if (!row) throw unavailable('This private draft reference is unavailable or expired. Recover it from an exported artifact, or draft it again.');
        return row;
    }
    async function resolve(reference) {
        const row = readReference(reference);
        if (row.record.schema === 'design/v1') return { design: row.record, parcelSourceId: row.parcelSourceId };
        const designs = [];
        for (const member of row.designs) {
            const child = readReference(member.draftRef);
            if (child.record.schema !== 'design/v1' || child.cid !== member.cid
                || (row.record.schema !== 'plan/v1' && child.parcelSourceId !== row.parcelSourceId)
                || (row.designSources && child.parcelSourceId !== row.designSources[member.cid])) throw unavailable('A private draft member is unavailable or expired. Recover the collection from its exported artifact, or draft it again.');
            designs.push(child.record);
        }
        return { [row.record.schema === 'plan/v1' ? 'plan' : 'agreement']: row.record,
            ...(row.plan ? { plan: row.plan.content } : {}), designs, parcelSourceId: row.parcelSourceId,
            ...(row.designSources ? { designSources: row.designSources } : {}) };
    }
    return { decorate, create, get, resolve, exportDraft: resolve, dispose: () => store.dispose(), clear: () => store.clear() };
}
