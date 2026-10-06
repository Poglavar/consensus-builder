// Public read access to optional floor models; ingestion remains a validated administrative job.
import { canonicalJson, fetchFloorModels, validateModelIdentity } from '../buildings/floor-models.js';

export function setupBuildingFloorModelsRoute(app, pool) {
    app.get('/buildings/floor-model', async (req, res) => {
        let identity;
        try {
            identity = validateModelIdentity({ city: req.query.city, source: req.query.source,
                ownerId: req.query.ownerId || '', buildingId: req.query.buildingId });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
        try {
            const models = await fetchFloorModels(pool, [identity]);
            const row = models.get(canonicalJson([identity.city, identity.source, identity.ownerId, identity.buildingId]));
            // Absence is normal for most buildings, and does not mean their exterior is unavailable.
            res.json({ model: row ? { ...identity, version: row.version, updatedAt: row.updated_at,
                floorPlans: row.floor_plans } : null });
        } catch (error) {
            console.error('GET /buildings/floor-model failed:', error);
            res.status(500).json({ error: 'Unable to read building floor model.' });
        }
    });
}
