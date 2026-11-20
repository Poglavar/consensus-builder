// Pending transfer proofs are scoped to one lens and network.  This is evidence
// coordination only: callers decide what proof means and no current-owner state
// is recorded here.
import { LensError } from '../lens/errors.js';

const fail = (status, code, message) => { throw new LensError(status, code, message); };
const text = (value, name) => {
    if (typeof value !== 'string' || !value.trim()) fail(400, 'bad_request', `${name} is required`);
    return value.trim();
};
const keysOf = value => {
    if (!Array.isArray(value) || !value.length) fail(400, 'bad_request', 'parcel keys are required');
    const keys = [...new Set(value.map(key => text(key, 'parcel key')))].sort();
    return keys;
};
const observedOf = value => {
    if (!Number.isSafeInteger(value) || value < 0) fail(400, 'bad_request', 'observedAt must be a non-negative safe integer');
    return value;
};
const terminalOf = value => {
    if (value !== 'settled' && value !== 'void') fail(400, 'bad_request', 'terminal must be settled or void');
    return value;
};
const rowOf = row => row && ({
    cid: row.offer_cid,
    proof: row.proof,
    decision: row.decision,
    terminal: row.terminal,
    observedAt: row.observed_at == null ? null : Number(row.observed_at)
});
const select = `SELECT offer_cid,proof,decision,terminal,observed_at
    FROM consensus.property_offer_transfer`;

export function createTransferStore(pool) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new Error('createTransferStore: a pg pool is required');
    }
    const get = async (lens, network, cid, db = pool) => {
        const { rows } = await db.query(`${select} WHERE lens=$1 AND network=$2 AND offer_cid=$3`,
            [text(lens, 'lens'), text(network, 'network'), text(cid, 'cid')]);
        return rowOf(rows[0]);
    };
    return {
        async list(lens, network, keys, db = pool) {
            const { rows } = await db.query(`${select}
                WHERE lens=$1 AND network=$2 AND terminal IS DISTINCT FROM 'void' AND parcel_keys && $3::text[]
                ORDER BY offer_cid`, [text(lens, 'lens'), text(network, 'network'), keysOf(keys)]);
            return rows.map(rowOf);
        },
        get,
        async observe(lens, network, cid, { terminal, observedAt }, db = pool) {
            lens = text(lens, 'lens'); network = text(network, 'network'); cid = text(cid, 'cid');
            terminal = terminalOf(terminal); observedAt = observedOf(observedAt);
            const updated = await db.query(`UPDATE consensus.property_offer_transfer
                SET terminal=$4, observed_at=$5
                WHERE lens=$1 AND network=$2 AND offer_cid=$3 AND terminal IS NULL
                RETURNING offer_cid,proof,decision,terminal,observed_at`, [lens, network, cid, terminal, observedAt]);
            if (updated.rows[0]) return rowOf(updated.rows[0]);
            const existing = await get(lens, network, cid, db);
            if (!existing) return null;
            if (existing.terminal !== terminal) fail(409, 'transfer_terminal_conflict', 'transfer was already observed with a different terminal state');
            return existing;
        },
        async reserve({ lens, network, cid, keys, proof, decision }, verifyCurrent) {
            lens = text(lens, 'lens'); network = text(network, 'network'); cid = text(cid, 'cid');
            keys = keysOf(keys); decision = text(decision, 'decision');
            if (!proof || typeof proof !== 'object' || Array.isArray(proof)) fail(400, 'bad_request', 'proof must be an object');
            if (typeof verifyCurrent !== 'function') throw new Error('reserve: verifyCurrent must be a function');
            const db = await pool.connect();
            try {
                await db.query('BEGIN');
                await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`property-offer-transfer:${lens}:${network}`]);
                const prior = await db.query(`SELECT offer_cid,proof,decision,terminal,observed_at,parcel_keys
                    FROM consensus.property_offer_transfer
                    WHERE lens=$1 AND network=$2 AND offer_cid=$3 FOR UPDATE`, [lens, network, cid]);
                if (prior.rows[0]) {
                    const equivalent = await db.query(`SELECT 1 FROM consensus.property_offer_transfer
                        WHERE lens=$1 AND network=$2 AND offer_cid=$3 AND terminal IS NULL
                          AND parcel_keys=$4::text[] AND proof=$5::jsonb AND decision=$6`,
                    [lens, network, cid, keys, JSON.stringify(proof), decision]);
                    if (equivalent.rows[0]) { await db.query('COMMIT'); return rowOf(prior.rows[0]); }
                    fail(409, 'transfer_conflict', 'a different transfer proof is already reserved for this offer');
                }
                const overlap = await db.query(`SELECT offer_cid FROM consensus.property_offer_transfer
                    WHERE lens=$1 AND network=$2 AND terminal IS NULL AND parcel_keys && $3::text[] LIMIT 1`,
                [lens, network, keys]);
                if (overlap.rows[0]) fail(409, 'transfer_overlap', `pending transfer ${overlap.rows[0].offer_cid} already reserves one of these parcels`);
                await verifyCurrent(db);
                const inserted = await db.query(`INSERT INTO consensus.property_offer_transfer
                    (lens,network,offer_cid,parcel_keys,proof,decision)
                    VALUES ($1,$2,$3,$4::text[],$5::jsonb,$6)
                    RETURNING offer_cid,proof,decision,terminal,observed_at`,
                [lens, network, cid, keys, JSON.stringify(proof), decision]);
                await db.query('COMMIT');
                return rowOf(inserted.rows[0]);
            } catch (error) {
                await db.query('ROLLBACK');
                throw error;
            } finally { db.release(); }
        }
    };
}
