// Cached image sets are derived from one immutable agreement revision. The manifest changes
// only after every image in a set is stored, so both halves always share a camera and baseline.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isCid } from '../cid.js';
import { loadDesigns } from '../routes/designs.js';
import { saveImageBuffer, imageFileExists, METADATA_DIR } from '../utils/image-store.js';
import { createLimiter } from './tile-source.js';
import { renderAgreementModel } from './agreement-model.js';

export const AGREEMENT_PREVIEW_REVISION = 'agreement-model-v1';
const fail = (status, message) => Object.assign(new Error(message), { status });
const imageKeys = ['after', 'before', 'pair'];
const publicViews = record => ({
    after: record.after?.imagePath ?? null, before: record.before?.imagePath ?? null,
    pair: record.pair?.imagePath ?? null, baselineComplete: record.baselineComplete
});

export function createAgreementPreviewService({ pool, cacheDir = METADATA_DIR, load = loadDesigns,
    render = renderAgreementModel, save = saveImageBuffer, exists = imageFileExists,
    maxQueued = 20, concurrency = 2, now = Date.now, retryMs = 5 * 60_000 } = {}) {
    const active = new Map(), limiter = createLimiter(concurrency);

    async function stored(file) {
        try {
            const record = JSON.parse(await fs.readFile(file, 'utf8'));
            if (record.revision !== AGREEMENT_PREVIEW_REVISION || !record.after ||
                (record.baselineComplete && (!record.before || !record.pair))) return null;
            return imageKeys.every(k => !record[k] || exists(record[k].fileName)) ? record : null;
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
            throw error;
        }
    }

    async function loadSubject(cid) {
        const { rows: [row] } = await pool.query(
            'SELECT city, design_cids, input_parcel_ids, parcel_source_id FROM consensus.agreement WHERE cid = $1', [cid]);
        if (!row) throw fail(404, 'The agreement was not found.');
        const designs = await load(pool, row.design_cids);
        if (row.design_cids.some(id => !designs.has(id))) throw fail(404, 'A published design in the agreement was not found.');
        return { cid, city: row.city, designs: row.design_cids.map(id => designs.get(id)),
            inputParcelIds: row.input_parcel_ids, parcelSourceId: row.parcel_source_id };
    }

    async function prepare(cid, subject) {
        if (!isCid(cid)) throw fail(400, 'A valid agreement CID is required.');
        if (active.has(cid)) return active.get(cid);
        const key = AGREEMENT_PREVIEW_REVISION + '-' + cid;
        const file = path.join(cacheDir, key + '.json');
        const partialFile = path.join(cacheDir, key + '.partial.json');
        const previous = await stored(file) || await stored(partialFile);
        if (previous && (previous.baselineComplete || previous.retryAt > now())) return publicViews(previous);
        if (active.has(cid)) return active.get(cid);
        if (active.size >= maxQueued) throw fail(503, 'Agreement preview rendering is busy.');
        const pending = limiter.run(async () => {
            const rendered = await render(pool, subject || await loadSubject(cid));
            if (!rendered) return { after: null, before: null, pair: null, baselineComplete: false };
            const record = { revision: AGREEMENT_PREVIEW_REVISION, baselineComplete: rendered.baselineComplete };
            if (!record.baselineComplete) record.retryAt = now() + retryMs;
            for (const side of imageKeys) {
                if (!rendered[side]) continue;
                const hash = createHash('sha256').update(rendered[side]).digest('hex');
                if (previous?.[side]?.hash === hash) { record[side] = previous[side]; continue; }
                const { fileName, imagePath } = await save(rendered[side], key + '-' + side);
                record[side] = { fileName, imagePath, hash };
            }
            await fs.mkdir(cacheDir, { recursive: true });
            // Another worker can finish a complete pair while this one has only After.
            // Separate manifests keep the complete view available regardless of write order.
            const target = record.baselineComplete ? file : partialFile;
            const temporary = target + '.' + randomUUID() + '.tmp';
            try {
                await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx' });
                await fs.rename(temporary, target);
            } finally { await fs.rm(temporary, { force: true }); }
            return publicViews(record);
        });
        active.set(cid, pending);
        try { return await pending; } finally { active.delete(cid); }
    }
    return { prepare };
}

const perPool = new WeakMap();
const noPool = {};
export function defaultAgreementPreviewService(pool) {
    const key = pool || noPool;
    if (!perPool.has(key)) perPool.set(key, createAgreementPreviewService({ pool }));
    return perPool.get(key);
}
