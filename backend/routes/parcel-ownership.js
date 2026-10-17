// GET /parcel-ownership/:sourceId/:parcelId — one route for every city's parcel ownership display
// data, dispatched to the adapter its parcel source declares (backend/ownership, docs/ownership-adapters.md).
import { createOwnershipRegistry } from '../ownership/registry.js';

const MAX_PARCEL_ID_LENGTH = 200;

function log(level, message, error) {
    console[level](`[${new Date().toISOString()}] [parcel-ownership] ${message}`, ...(error ? [error] : []));
}

export function setupParcelOwnershipRoute(app, pool, { registry = createOwnershipRegistry() } = {}) {
    // Parcel ids may contain slashes (HR-335258-4341/2), so the id is the rest of the path.
    app.get(/^\/parcel-ownership\/([^/]+)\/(.+)$/, async (req, res) => {
        const sourceId = req.params[0];
        const parcelId = (req.params[1] || '').trim();
        if (!parcelId || parcelId.length > MAX_PARCEL_ID_LENGTH) {
            return res.status(400).json({ error: 'A parcel id of at most 200 characters is required.', code: 'invalid-parcel-id' });
        }
        try {
            const record = await registry.lookup(sourceId, parcelId, { pool });
            if (!record) {
                return res.status(404).json({ error: 'Ownership data not found for this parcel.', code: 'ownership-not-found' });
            }
            return res.json(record);
        } catch (error) {
            if (error.code === 'ownership-contract-violation') {
                log('error', error.message);
                return res.status(502).json({ error: error.message, code: error.code });
            }
            const status = Number.isInteger(error.status) ? error.status : 500;
            if (status >= 500) log('error', `${sourceId} ${parcelId} failed`, error);
            return res.status(status).json({
                // Unexpected failures (DB errors, bugs) keep their detail in the log, not the reply.
                error: status === 500 ? 'Failed to read parcel ownership.' : error.message,
                ...(error.code ? { code: error.code } : {})
            });
        }
    });
}
