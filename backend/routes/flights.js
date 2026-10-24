// Immutable camera flights pin their complete presentation snapshot before entering the durable index.
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { pinBytes as defaultPinBytes, MAX_PINNED_OBJECT_BYTES } from '../storage/pinning.js';
import { createUploadRateLimiter } from '../utils/nft-asset-upload.js';
const require = createRequire(import.meta.url);
const CameraFlight = require('../../frontend/js/camera-flight.js');
const { validateFloorPlans } = require('../../frontend/js/building-floor-plans.js');

function validate(content) {
    try {
        const error = CameraFlight.validate(content);
        if (error) return error;
        CameraFlight.compile(content);
        for (const [index, interior] of content.interiors.entries()) {
            const errors = validateFloorPlans(interior.feature.properties.floorPlans);
            if (errors.length) return `interiors[${index}]: ${errors.join('; ')}`;
        }
        return null;
    } catch {
        return 'Invalid camera flight or interior floor model.';
    }
}

export function setupFlightsRoute(app, { pool, pinBytes = defaultPinBytes, uploadRateLimiter } = {}) {
    const read = async cid => {
        const record = (await pool.query('SELECT cid, content FROM consensus.camera_flight WHERE cid = $1', [cid])).rows[0];
        if (!record) return null;
        if (record.cid !== cid || validate(record.content) || cidOf(canonicalBytes(record.content)) !== cid) {
            throw new Error('The stored camera flight failed content integrity verification.');
        }
        return record;
    };
    const fail = (res, error) => {
        if (error?.code === 'pinning-quota-exhausted') return res.status(409).json({ code: error.code,
            error: 'Publication is blocked because the pinning account has reached its usage limit.',
            next: { action: 'Restore quota on the configured pinning account, then retry saving this flight.' } });
        // Upstream errors can contain credentials or request bodies; keep those out of logs and responses.
        console.error(`[${new Date().toISOString()}] [flights] Camera flight storage operation failed.`);
        return res.status(503).json({ error: 'The camera flight could not be saved or loaded. Please retry.' });
    };
    app.post('/flights', uploadRateLimiter || createUploadRateLimiter(), async (req, res) => {
        const content = req.body?.content;
        const error = validate(content);
        if (error) return res.status(400).json({ error });
        let bytes;
        try { bytes = canonicalBytes(content); }
        catch { return res.status(400).json({ error: 'Camera flight content must contain only finite JSON values.' }); }
        if (bytes.length > MAX_PINNED_OBJECT_BYTES) return res.status(413).json({ code: 'too-large',
            error: `A camera flight is at most ${MAX_PINNED_OBJECT_BYTES} bytes; this one is ${bytes.length}.` });
        const cid = cidOf(bytes);
        try {
            const existing = await read(cid);
            if (existing) return res.json(existing);
            if (content.designCids.length) {
                const { rows } = await pool.query('SELECT cid FROM consensus.design WHERE cid = ANY($1::text[])', [content.designCids]);
                const present = new Set(rows.map(row => row.cid));
                const missing = content.designCids.filter(id => !present.has(id));
                if (missing.length) return res.status(409).json({ error: 'Publish every selected design before saving the flight.', missing });
            }
            const pinned = await pinBytes({ bytes, cid, name: `flight-${cid}` });
            if (pinned?.cid !== cid) throw new Error('The pinned flight did not match its content identifier.');
            await pool.query('INSERT INTO consensus.camera_flight (cid, content) VALUES ($1, $2::jsonb) ON CONFLICT (cid) DO NOTHING', [cid, JSON.stringify(content)]);
            const record = await read(cid);
            if (!record) throw new Error('The saved camera flight could not be read back.');
            return res.status(201).json(record);
        } catch (error) { return fail(res, error); }
    });
    app.get('/flights/:cid', async (req, res) => {
        if (!isCid(req.params.cid)) return res.status(400).json({ error: 'Invalid camera flight link.' });
        try {
            const record = await read(req.params.cid);
            if (!record) return res.status(404).json({ error: 'This camera flight was not found.' });
            return res.json(record);
        } catch (error) { return fail(res, error); }
    });
}
