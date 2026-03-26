import express from 'express';
import { setupProposalsRoute } from '../../routes/proposals.js';

export function createTestApp(pool) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    setupProposalsRoute(app, pool);
    return app;
}
