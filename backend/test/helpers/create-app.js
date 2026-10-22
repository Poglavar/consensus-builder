// Express apps for route tests: the read-only proposal routes, and the publish routes of designs and
// agreements (routes/content-routes.js) with their collaborators replaced through its overrides.
import express from 'express';
import { setupProposalsRoute } from '../../routes/proposals.js';
import { registerContentRoutes } from '../../routes/content-routes.js';

export function createTestApp(pool) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    setupProposalsRoute(app, pool);
    return app;
}

/**
 * POST /pins, /designs and /agreements on a JSON app.
 * @param overrides registerContentRoutes overrides; the per-client upload limiter is a pass-through
 *   unless one is given, so a test can send any number of pins
 */
export function createContentApp(pool, overrides = {}) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    registerContentRoutes(app, pool, { uploadRateLimiter: (req, res, next) => next(), ...overrides });
    return app;
}
