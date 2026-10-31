import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { createSharedPlanSessions } from '../agents/mcp-shared-plan-sessions.js';
import { canonicalArtifact } from '../agents/shared-plan-artifact.js';

export function setupSharedPlanSessionsRoute(app, pool, { sessions = createSharedPlanSessions({ pool, validateArtifact: canonicalArtifact }), rateLimiter } = {}) {
    const streams = new Set();
    let closing = false;
    const capability = req => /^Bearer ([\w-]{32})$/.exec(String(req.headers.authorization || ''))?.[1];
    const limiter = rateLimiter || rateLimit({ windowMs: 60_000, max: 600,
        // Public session ids and invalid/missing credentials cannot spend an owner's budget.
        keyGenerator: req => capability(req)
            ? `cap:${createHash('sha256').update(capability(req)).digest('hex')}`
            : `ip:${ipKeyGenerator(req.ip)}`,
        standardHeaders: true, legacyHeaders: false });
    const creationLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
        skip: req => req.method !== 'POST' || !['', '/'].includes(req.path) });
    app.use('/shared-plan-sessions', creationLimiter, limiter, async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        const match = /^\/([\w-]{24})(?:\/(control|undo|check|state|events|publication-approval|publication-check))?\/?$/.exec(req.path);
        const root = req.path === '/' || req.path === '';
        const token = capability(req), id = match?.[1], action = match?.[2];
        try {
            if (closing) return res.status(503).json({ code: 'shared-plan-unavailable' });
            if (root && req.method === 'POST') return res.status(201).json(await sessions.create(canonicalArtifact(req.body?.artifact)));
            if (!match) return res.status(404).json({ code: 'not-found' });
            if (!token) return res.status(401).json({ code: 'shared-plan-capability-required' });
            if (action === 'events' && req.method === 'GET') {
                await sessions.eventState(id, token);
                if (streams.size >= 128 || [...streams].filter(stream => stream.id === id).length >= 8) return res.status(429).json({ code: 'shared-plan-stream-capacity' });
                let closed = false, off = () => {}, timer, ready = false, sending = Promise.resolve();
                function close() { if (closed) return; closed = true; clearInterval(timer); off(); streams.delete(stream); if (!res.destroyed) res.end(); }
                const stream = { id, close }; streams.add(stream);
                res.on('close', close);
                function send() {
                    sending = sending.then(async () => {
                        if (closed || !ready) return;
                        const state = await sessions.eventState(id, token);
                        if (!closed && !res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`)) { close(); res.destroy(); }
                    }).catch(close);
                }
                try { off = await sessions.subscribe(id, token, send, close); }
                catch (error) { streams.delete(stream); res.removeListener('close', close); throw error; }
                if (closed || closing) { off(); close(); return; }
                res.status(200).set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
                res.flushHeaders();
                timer = setInterval(send, 15_000); timer.unref();
                ready = true; send(); return;
            }
            if (!action && req.method === 'DELETE') {
                const result = await sessions.terminate(id, token);
                for (const stream of [...streams]) if (stream.id === id) stream.close();
                return res.json(result);
            }
            if (!action && req.method === 'GET') return res.json(await sessions.inspect(id, token));
            if (action === 'state' && req.method === 'GET') return res.json(await sessions.eventState(id, token));
            if (!action && req.method === 'PUT') return res.json(await sessions.replace(id, token, { ...req.body, artifact: canonicalArtifact(req.body?.artifact) }));
            if (req.method === 'POST') {
                if (action === 'publication-approval') return res.json(await sessions.approvePublication(id, token, req.body || {}));
                if (action === 'publication-check') return res.json(await sessions.approvedPublication(id, token, req.body || {}));
                if (action === 'control') return res.json(await sessions.control(id, token, req.body || {}));
                if (action === 'undo') return res.json(await sessions.undo(id, token, req.body || {}));
                if (action === 'check') return res.json(await sessions.assertEditable(id, token, req.body?.expectedVersion));
            }
            return res.status(405).json({ code: 'method-not-allowed' });
        } catch (error) {
            if (res.headersSent) { res.destroy(); return; }
            const known = error.code?.startsWith('shared-plan-');
            res.status(known ? error.status || 400 : 503).json({ code: known ? error.code : 'shared-plan-unavailable',
                message: known ? error.message : 'Shared plan storage unavailable.',
                ...(known && error.currentVersion != null ? { currentVersion: error.currentVersion, currentCid: error.currentCid } : {}) });
        }
    });
    return { async close() { closing = true; for (const stream of [...streams]) stream.close(); await sessions.dispose(); } };
}
