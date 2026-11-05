// Public read access to optional floor models; ingestion remains a validated administrative job.
import { readNativeFloorModel, validateModelIdentity } from '../buildings/floor-models.js';

// One building's model, read when the browser needs it (X-ray on, building near): the authored
// registry model, else the plans the city publishes (`city` is the floor-model namespace, `source`
// the building's floorModelSource). `publishedFloorModels` is injected in tests.
export function setupBuildingFloorModelsRoute(app, pool, { publishedFloorModels } = {}) {
    app.get('/buildings/floor-model', async (req, res) => {
        let identity;
        try {
            identity = validateModelIdentity({ city: req.query.city, source: req.query.source,
                ownerId: req.query.ownerId || '', buildingId: req.query.buildingId });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
        try {
            const report = {};
            const model = await readNativeFloorModel(pool, identity, { ...(publishedFloorModels ? { published: publishedFloorModels } : {}), report });
            // A publication that did not answer is not "no plans": the browser may ask again later.
            if (!model && report.publishedUnavailable) return res.status(503).json({ error: 'Published floor plans are unavailable.' });
            // Absence is normal for most buildings, and does not mean their exterior is unavailable.
            res.json({ model });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /buildings/floor-model failed:`, error);
            res.status(500).json({ error: 'Unable to read building floor model.' });
        }
    });
}
