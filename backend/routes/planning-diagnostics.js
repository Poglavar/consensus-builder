import express from 'express';
import { createBudget, createDiagnosticStore, createApiObservation, validateDiagnosticReport, MAX_BODY_BYTES } from '../operations/planning-diagnostics.js';

export function setupPlanningDiagnostics(app, pool, { env = process.env, store = createDiagnosticStore(pool), now = Date.now } = {}) {
    const enabled = env.UGT_DIAGNOSTICS_INGEST === 'true';
    const allowRequest = createBudget({ now });
    const allowObservation = createBudget({ now, limit: 120 });
    if (enabled || env.UGT_PLANNING_SERVER_OBSERVATIONS === 'true') {
        // Prune even on an idle enabled service. No new schema is created implicitly.
        const prune = () => { void store.insert([]).catch(() => {}); };
        prune();
        const timer = setInterval(prune, 60 * 60 * 1000); timer.unref();
        app.locals.stopPlanningDiagnosticCleanup = () => clearInterval(timer);
    }
    // Registered after the existing origin guard, before the global 15 MiB parser and write limiter.
    app.post('/diagnostics/reports', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!enabled) return res.status(404).json({ code: 'diagnostics-disabled' });
        if (!allowRequest()) return res.status(429).json({ code: 'diagnostics-rate-limited' });
        next();
    }, express.json({ limit: MAX_BODY_BYTES, strict: true }), async (req, res) => {
        const checked = validateDiagnosticReport(req.body);
        if (checked.error) return res.status(400).json({ code: checked.error });
        const result = await store.insert(checked.value);
        if (result.conflict) return res.status(409).json({ code: 'diagnostic-id-conflict' });
        if (result.busy) return res.status(429).json({ code: 'diagnostics-busy' });
        if (result.unavailable) return res.status(503).json({ code: 'diagnostics-unavailable' });
        return res.status(202).json({ accepted: result.accepted });
    }, (error, _req, res, _next) => {
        // body-parser messages can echo input. Keep this response fixed and bypass global logging.
        res.status(error?.type === 'entity.too.large' ? 413 : 400).json({ code: 'invalid-diagnostic-report' });
    });
    if (env.UGT_PLANNING_SERVER_OBSERVATIONS === 'true') app.use((req, res, next) => {
        res.once('finish', () => {
            const entry = createApiObservation(req, res, { knownTest: env.NODE_ENV === 'test' });
            if (entry && allowObservation()) void store.insert([entry]).catch(() => {});
        });
        next();
    });
}
