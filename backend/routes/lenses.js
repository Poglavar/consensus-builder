// Lens-model API: the attester directory (GET /lenses/members, alias /agent/lenses/members), member
// self-registration (POST on the same paths, verified by oracle/lens-registration.js) and the two
// SAS schema definitions (GET /lenses/schemas) so clients agree on payload bytes.

import { Connection } from '@solana/web3.js';
import rateLimit from 'express-rate-limit';
import { listLensMembers, registerLensMember } from '../oracle/lens-directory.js';
import { describeLensSchemas, SAS_PROGRAM_ID } from '../oracle/lens-schemas.js';
import {
    connectionAccountReader,
    fetchLensStatus,
    LENS_REGISTRATION_TITLE,
    RegistrationError,
    verifyRegistration
} from '../oracle/lens-registration.js';

const log = (message) => console.log(`[${new Date().toISOString()}] [lenses] ${message}`);

export function setupLensesRoute(app, pool, {
    readAccounts = null,
    fetchStatus = fetchLensStatus,
    nowSeconds = () => Math.floor(Date.now() / 1000),
    allowHttp = false,
    registrationLimit = 20
} = {}) {
    let reader = readAccounts;
    const accounts = addresses => {
        reader ??= connectionAccountReader(new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed'));
        return reader(addresses);
    };

    const members = async (_req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            res.json({ members: await listLensMembers(pool) });
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET lens members failed:`, error);
            res.status(500).json({ error: 'Failed to load lens members' });
        }
    };

    // Each attempt costs an RPC read and an outbound probe, so attempts are rate limited per client.
    const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: registrationLimit, standardHeaders: 'draft-7', legacyHeaders: false });
    const register = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const registration = await verifyRegistration(req.body || {}, { nowSeconds: nowSeconds(), readAccounts: accounts, fetchStatus, allowHttp });
            const member = await registerLensMember(pool, registration);
            if (!member) {
                return res.status(409).json({ error: 'replayed_registration', message: 'a registration signed at the same time or later is already stored; sign a fresh one' });
            }
            log(`registered ${member.key} (${member.kind}) at ${member.serviceUrl}`);
            res.status(201).json({ member });
        } catch (error) {
            if (error instanceof RegistrationError) {
                log(`refused registration for ${req.body?.key ?? 'unknown key'}: ${error.code} ${error.message}`);
                return res.status(error.status).json({ error: error.code, message: error.message });
            }
            console.error(`[${new Date().toISOString()}] POST lens members failed:`, error);
            res.status(500).json({ error: 'Failed to register lens member' });
        }
    };

    for (const path of ['/lenses/members', '/agent/lenses/members']) {
        app.get(path, members);
        app.post(path, limiter, register);
    }

    app.get('/lenses/schemas', (_req, res) => {
        res.set('Cache-Control', 'no-store').json({ sasProgram: SAS_PROGRAM_ID, schemas: describeLensSchemas(), registration: { title: LENS_REGISTRATION_TITLE } });
    });
}
