// Read-only, bounded source proposals for the shared Existing / Permitted / Proposed experience.
import { validateBounds } from '../parcels/source-contract.js';
import { planningRepresentations } from '../planning/sources.js';

export function setupPlanningRoutes(app, pool, { query = planningRepresentations } = {}) {
    app.get('/planning/representations', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const city = req.query.city;
            if (typeof city !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(city)) {
                return res.status(400).json({ error: 'A city is required.', code: 'invalid-planning-query' });
            }
            const bbox = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(value => value.trim() ? Number(value) : NaN) : [];
            validateBounds(bbox, 4);
            const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
                return res.status(400).json({ error: 'Limit must be between 1 and 200.', code: 'invalid-planning-query' });
            }
            res.json(await query(pool, { city, bbox, limit }));
        } catch (error) {
            if (error.status === 400) return res.status(400).json({ error: 'Choose a smaller map area.', code: 'invalid-planning-query' });
            console.error('[planning] Source read failed', error);
            res.status(503).json({ error: 'Planning source is unavailable.', code: 'planning-source-unavailable' });
        }
    });
}
