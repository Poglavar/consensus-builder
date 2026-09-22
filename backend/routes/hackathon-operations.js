import { readProspectiveMarketStatus } from '../oracle/prospective-market-public.js';
import { readPublicOperationsStatus } from '../operations/public-status.js';

export function setupHackathonOperationsRoute(app, pool, {
    env = process.env,
    statusReader = readProspectiveMarketStatus,
    operationsReader = readPublicOperationsStatus,
    now = () => Date.now()
} = {}) {
    app.get('/hackathon/operations.json', async (_req, res, next) => {
        try {
            const prospectiveStatus = statusReader({ env, now: now() });
            res.json(await operationsReader({ pool, env, prospectiveStatus, now: now() }));
        } catch (error) {
            next(error);
        }
    });
}
