import express from 'express';

export function createRouteApp(setupRoute, ...setupArgs) {
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    setupRoute(app, ...setupArgs);
    return app;
}