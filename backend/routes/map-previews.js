import { createMapPreviewService } from '../thumbnails/map-preview.js';
import { publicFileUrl } from '../utils/public-base-url.js';

export function setupMapPreviewsRoute(app, { pool, mapPreviewService } = {}) {
    const service = mapPreviewService || createMapPreviewService({ pool });
    const fail = (res, error) => {
        const status = error.status || 503;
        res.set('Cache-Control', 'no-store');
        if (status === 503) res.set('Retry-After', '15');
        if (!error.status) console.error('[map-preview] Rendering failed:', error.message);
        return res.status(status).json({ error: error.status ? error.message : 'The map preview could not be rendered. Please retry.' });
    };
    app.post('/map-previews', async (req, res) => {
        try {
            const record = await service.prepare(req.body?.cids);
            return res.json({ imageUrl: publicFileUrl(record.imagePath), width: record.width, height: record.height });
        } catch (error) { return fail(res, error); }
    });
    // This lazy path repairs a missing asset even if no browser warmed it, or the API restarted
    // during preparation. Never cache an error or a generic replacement as the plan's image.
    app.get('/map-previews/:cids/image.png', async (req, res) => {
        try {
            const record = await service.prepare(req.params.cids.split(','));
            res.set('Cache-Control', 'public, max-age=3600');
            return res.redirect(302, publicFileUrl(record.imagePath));
        } catch (error) { return fail(res, error); }
    });
}
