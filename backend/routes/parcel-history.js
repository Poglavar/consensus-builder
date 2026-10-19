// GET /parcels/:parcelUid/history: the permanent per-parcel log (backend/oracle/parcel-history.js).
// Read-only and uncached (no-store): a new attestation or acceptance must show on the next read.

import { Connection, PublicKey } from '@solana/web3.js';
import { loadParcelHistory, PARCEL_PROGRAM_ID, validParcelUid } from '../oracle/parcel-history.js';

// True when the anchor PDA exists on devnet as a parcel_nft account. Tests inject their own reader.
function defaultAnchorReader() {
    let connection = null;
    return async (address) => {
        connection ??= new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
        const info = await connection.getAccountInfo(new PublicKey(address), 'confirmed');
        return Boolean(info && info.owner?.toBase58?.() === PARCEL_PROGRAM_ID);
    };
}

export function setupParcelHistoryRoute(app, pool, { readAnchorAccount = defaultAnchorReader() } = {}) {
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
