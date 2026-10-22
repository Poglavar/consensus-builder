// GET /parcels/:parcelUid/history: the permanent per-parcel log (backend/oracle/parcel-history.js).
// Read-only and uncached (no-store): a new attestation or execution must show on the next read.

import { Connection, PublicKey } from '@solana/web3.js';
import { loadParcelHistory, parcelAnchorAccountMatches, validParcelUid } from '../oracle/parcel-history.js';
import { DEVNET_GENESIS_HASH } from '../agreements/onchain.js';

// A missing account is false; a failed or invalid observation throws and becomes unknown.
export function createAnchorReader({ connection = null } = {}) {
    return async (address, parcelUid) => {
        connection ??= new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
        if (await connection.getGenesisHash() !== DEVNET_GENESIS_HASH) throw new Error('Parcel anchor reads require Solana devnet.');
        const info = await connection.getAccountInfo(new PublicKey(address), 'confirmed');
        if (info === null) return false;
        if (!parcelAnchorAccountMatches(info, parcelUid)) throw new Error('Parcel anchor account does not match its program, type or parcel identity.');
        return true;
    };
}

export function setupParcelHistoryRoute(app, pool, { readAnchorAccount = createAnchorReader() } = {}) {
    app.get('/parcels/:parcelUid/history', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const parcelUid = validParcelUid(req.params.parcelUid);
        if (!parcelUid) return res.status(400).json({ error: 'parcelUid must be 1-128 printable characters' });
        try {
            return res.json(await loadParcelHistory(pool, parcelUid, { readAnchorAccount }));
        } catch (error) {
            console.error(`[${new Date().toISOString()}] GET /parcels/${parcelUid}/history failed`, error);
            return res.status(500).json({ error: 'Failed to read parcel history' });
        }
    });
}
