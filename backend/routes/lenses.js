// Lens-model read API: the attester directory (GET /lenses/members, alias /agent/lenses/members)
// and the two SAS schema definitions (GET /lenses/schemas) so clients agree on payload bytes.

import { listLensMembers } from '../oracle/lens-directory.js';
import { describeLensSchemas, SAS_PROGRAM_ID } from '../oracle/lens-schemas.js';

export function setupLensesRoute(app, pool) {
    const members = async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            res.json({ members: await listLensMembers(pool) });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET lens members failed:`, error);
            res.status(500).json({ error: 'Failed to load lens members' });
        }
    };
    app.get('/lenses/members', members);
    app.get('/agent/lenses/members', members);

    app.get('/lenses/schemas', (_req, res) => {
        res.set('Cache-Control', 'no-store').json({ sasProgram: SAS_PROGRAM_ID, schemas: describeLensSchemas() });
    });
}
