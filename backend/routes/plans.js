// Durable named plans reference existing published designs; saving one never creates agreement terms or changes designs.
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { pinBytes as defaultPinBytes } from '../storage/pinning.js';
import { createUploadRateLimiter } from '../utils/nft-asset-upload.js';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');

export function setupPlansRoute(app, { pool, pinBytes = defaultPinBytes, uploadRateLimiter } = {}) {
    const read = async cid => (await pool.query('SELECT cid, content FROM consensus.plan WHERE cid = $1', [cid])).rows[0] || null;
    const fail = (res, error) => {
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
    app.get('/plans/:cid', async (req, res) => {
        if (!isCid(req.params.cid)) return res.status(400).json({ error: 'Invalid plan link.' });
        try {
            const record = await read(req.params.cid);
            if (!record) return res.status(404).json({ error: 'This named plan was not found.' });
            return res.json(record);
        } catch (error) { return fail(res, error); }
    });
}
