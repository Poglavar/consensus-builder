// Health check route
export function setupHealthRoute(app) {
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });
}
