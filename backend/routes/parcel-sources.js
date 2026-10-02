// Read-only parcel gateway: fixed source descriptors keep provider protocols out of app consumers.
import { parcelSourceCatalog as catalog, createParcelSource } from '../parcels/sources.js';
import { HttpError, queryString } from '../utils/helpers.js';

export function setupParcelSourcesRoute(app, { sources = catalog.sources, fetchImpl } = {}) {
    const adapters = new Map(sources.map(source => {
        return [source.id, createParcelSource(source, { fetchImpl })];
    }));
    app.get('/parcel-sources', (_req, res) => res.json({ schemaVersion: catalog.schemaVersion, sources }));
    const handle = action => async (req, res) => {
        try {
            const adapter = adapters.get(req.params.sourceId);
            if (!adapter) throw new HttpError(404, 'Unknown parcel source.');
            const result = await action(adapter, req);
            res.set('Cache-Control', 'no-store').json(result);
        } catch (error) {
            const status = error.status || 502;
            if (status >= 500) console.error(`[${new Date().toISOString()}] [parcel-sources] ${req.params.sourceId}: ${error.message}`);
            res.status(status).json({ error: error.message, sourceId: req.params.sourceId });
        }
    };
    app.get('/parcel-sources/:sourceId', handle((adapter, req) => {
        const bbox = queryString(req.query, 'bbox');
        const ids = queryString(req.query, 'ids');
        if (Boolean(bbox) === Boolean(ids)) throw new HttpError(400, 'Provide either bbox or ids.');
        if (ids) return adapter.queryIds(ids.split(','));
        if (bbox.split(',').some(part => !part.trim())) throw new HttpError(400, 'Invalid bbox.');
        return adapter.queryBounds(bbox.split(',').map(Number));
    }));
    app.post('/parcel-sources/:sourceId/under', handle((adapter, req) => {
        if (req.body?.srid !== undefined && req.body.srid !== 4326) throw new HttpError(400, 'Parcel geometry must use WGS84 (srid 4326).');
        return adapter.queryGeometry(req.body?.geometry);
    }));
}
