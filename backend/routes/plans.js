// Durable named plans reference existing published designs; saving one never creates agreement terms or changes designs.
import { normalizeCityCode } from '../utils/city-code.js';
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { pinBytes as defaultPinBytes } from '../storage/pinning.js';
import { createUploadRateLimiter } from '../utils/nft-asset-upload.js';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');

export function validatePlanContent(content) { return PlanRecord.validate(content); }

export function setupPlansRoute(app, { pool, pinBytes = defaultPinBytes, uploadRateLimiter } = {}) {
    const read = async cid => (await pool.query('SELECT cid, content FROM consensus.plan WHERE cid = $1', [cid])).rows[0] || null;
    const listLimit = raw => {
        if (raw === undefined) return 20;
        if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value <= 50 ? value : null;
    };
    const listOffset = raw => {
        if (raw === undefined) return 0;
        if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw)) return null;
        const value = Number(raw);
        return Number.isSafeInteger(value) && value <= 1000000 ? value : null;
    };
    const fail = (res, error) => {
        if (error?.code === 'pinning-quota-exhausted') return res.status(409).json({ code: error.code, error: error.message,
            next: { action: 'Restore quota on the configured pinning account, then retry saving this plan.' } });
        console.error(`[${new Date().toISOString()}] [plans] ${error.message}`);
        return res.status(503).json({ error: 'The plan could not be saved or loaded. Please retry.' });
    };
    app.post('/plans', uploadRateLimiter || createUploadRateLimiter(), async (req, res) => {
        const content = req.body?.content;
        const error = PlanRecord.validate(content);
        if (error) return res.status(400).json({ error });
        try {
            const bytes = canonicalBytes(content);
            const cid = cidOf(bytes);
            const existing = await read(cid);
            if (existing) return res.json(existing);
            const { rows } = await pool.query('SELECT cid FROM consensus.design WHERE cid = ANY($1::text[])', [content.designCids]);
            const present = new Set(rows.map(row => row.cid));
            const missing = content.designCids.filter(id => !present.has(id));
            if (missing.length) return res.status(409).json({ error: 'Publish every selected design before saving the plan.', missing });
            const pinned = await pinBytes({ bytes, cid, name: `plan-${cid}` });
            if (pinned.cid !== cid) throw new Error('The pinned plan did not match its content identifier.');
            await pool.query('INSERT INTO consensus.plan (cid, content) VALUES ($1, $2::jsonb) ON CONFLICT (cid) DO NOTHING', [cid, JSON.stringify(content)]);
            return res.status(201).json(await read(cid));
        } catch (error) { return fail(res, error); }
    });
    app.get('/plans', async (req, res) => {
        const { design, city: rawCity, limit: rawLimit, offset: rawOffset } = req.query;
        if (rawCity !== undefined && (typeof rawCity !== 'string' || rawCity.length > 100)) return res.status(400).json({ error: 'city must be a string of at most 100 characters.' });
        if (design !== undefined && !isCid(design)) return res.status(400).json({ error: 'design must be a design CID.', code: 'invalid-cid' });
        const limit = listLimit(rawLimit), offset = listOffset(rawOffset);
        if (limit === null || offset === null) return res.status(400).json({ error: 'limit must be an integer from 1 to 50 and offset an integer from 0 to 1000000.', code: 'bad-request' });
        try {
            if (design === undefined) {
                const city = normalizeCityCode(rawCity);
                const { rows } = await pool.query(`SELECT cid, content FROM consensus.plan
                    WHERE ($1::text IS NULL OR content->'view'->>'city' = $1)
                    ORDER BY cid LIMIT $2 OFFSET $3`, [city || null, limit + 1, offset]);
                const hasMore = rows.length > limit;
                const plans = rows.slice(0, limit).map(row => ({ ...row, title: row.content.title,
                    designCount: row.content.designCids.length }));
                return res.json({ plans, count: plans.length, hasMore, nextOffset: hasMore ? offset + plans.length : null });
            }
            const { rows } = await pool.query(`
                SELECT cid, content->>'title' AS title, jsonb_array_length(content->'designCids') AS design_count
                FROM consensus.plan
                WHERE content->'designCids' @> jsonb_build_array($1::text)
                ORDER BY cid
                LIMIT $2 OFFSET $3`, [design, limit + 1, offset]);
            const hasMore = rows.length > limit;
            const plans = rows.slice(0, limit).map(row => ({ cid: row.cid, title: row.title, designCount: Number(row.design_count) }));
            const nextOffset = hasMore ? offset + plans.length : null;
            return res.json({ plans, count: plans.length, hasMore, nextOffset });
        } catch (error) { return fail(res, error); }
    });
    app.get('/plans/:cid', async (req, res) => {
        if (!isCid(req.params.cid)) return res.status(400).json({ error: 'Invalid plan link.' });
        try {
            const record = await read(req.params.cid);
            if (!record) return res.status(404).json({ error: 'This named plan was not found.' });
            return res.json(record);
        } catch (error) { return fail(res, error); }
    });
}
