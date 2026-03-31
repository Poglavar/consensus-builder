import express from 'express';
import { setupAreaMonitorsRoute } from '../../routes/area-monitors.js';

export function createAreaMonitorTestApp(pool) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    setupAreaMonitorsRoute(app, pool);
    return app;
}