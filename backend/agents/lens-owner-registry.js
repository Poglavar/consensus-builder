// The lens member's devnet owner registry, consensus.lens_devnet_owner (DDL: routes/lens-member-ddl.sql;
// read by backend/lens/identity/devnet-registry.js): the devnet stand-in for the land registry, one row per
// owner wallet of a parcel. The operator may seed it freely. A proposer persona is registered as the sole
// owner of the parcels it proposes on, so its agreements are binding owners' agreements it can get
// decided itself (plan-design-agreement.md M3). Shared by scripts/seed-lens-owners.mjs and
// agents/run.mjs --seed-owners; a parcel another wallet holds is never replaced.

export const OWNER_TABLE = 'consensus.lens_devnet_owner';
// Advisory-lock namespace of one parcel's registration: two seeders never both register a sole owner.
export const REGISTRATION_LOCK_NAMESPACE = 480405;

const isoOf = value => (value ? new Date(value).toISOString() : null);

/**
 * The registry's owner set of each parcel: Map(parcelId → [{ owner, ownerCount, establishedAt, note }]),
 * an empty list for a parcel with no row.
 */
export async function readParcelOwners(db, parcelIds) {
    const ids = [...new Set((parcelIds || []).map(id => String(id)).filter(Boolean))];
    const owners = new Map(ids.map(id => [id, []]));
    if (!ids.length) return owners;
    const { rows } = await db.query(
        `SELECT parcel_uid, owner_wallet, owner_count, established_at, note
           FROM ${OWNER_TABLE}
          WHERE parcel_uid = ANY($1::text[])
          ORDER BY parcel_uid, owner_wallet`,
        [ids]
    );
    for (const row of rows) {
        owners.get(row.parcel_uid)?.push({
            owner: row.owner_wallet, ownerCount: Number(row.owner_count), establishedAt: isoOf(row.established_at), note: row.note ?? null
        });
    }
    return owners;
}

/** Whether a parcel's owner set is exactly this one wallet, the sole owner. */
export function isSoleOwner(set, wallet) {
    return Array.isArray(set) && set.length === 1 && set[0].owner === wallet && set[0].ownerCount === 1;
}

/**
 * Pure: what registering `wanted` ([{ parcelId, wallet, persona }]) as sole owners does against the
 * registry's current owner sets (readParcelOwners): `register` (no owner yet), `registered` (already
 * this wallet's alone) and `conflicts` (held by other wallets, or wanted by two personas; never replaced).
 */
export function planOwnerRegistrations(wanted, owners) {
    const register = [];
    const registered = [];
    const conflicts = [];
    const claimed = new Map();
    for (const item of wanted || []) {
        const parcelId = String(item.parcelId);
        const entry = { ...item, parcelId };
        const earlier = claimed.get(parcelId);
        if (earlier) {
            if (earlier.wallet !== item.wallet) conflicts.push({ ...entry, reason: `also picked by ${earlier.persona}` });
            continue;
        }
        claimed.set(parcelId, entry);
        const set = owners.get(parcelId) || [];
        if (!set.length) register.push(entry);
        else if (isSoleOwner(set, item.wallet)) registered.push(entry);
        else conflicts.push({ ...entry, reason: `registered to ${set.map(row => row.owner).join(', ')}` });
    }
    return { register, registered, conflicts };
}

/**
 * Register each item's wallet as the sole owner (owner_count 1) of its parcel, each parcel in its own
 * transaction under a per-parcel advisory lock, re-reading the parcel inside it: one registered meanwhile
 * is reported (outcome 'registered' when it is this wallet's, else 'conflict') and left as it is.
 * established_at is the registration's own time: on devnet this row is where the ownership begins.
 * @returns {Promise<Array<{ parcelId, wallet, persona, outcome: 'inserted'|'registered'|'conflict', owners? }>>}
 */
export async function registerSoleOwners(pool, items, { note = () => null, log = () => {} } = {}) {
    const results = [];
    for (const [index, item] of (items || []).entries()) {
        const client = await pool.connect();
        let result;
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [REGISTRATION_LOCK_NAMESPACE, item.parcelId]);
            const { rows } = await client.query(`SELECT owner_wallet, owner_count FROM ${OWNER_TABLE} WHERE parcel_uid = $1`, [item.parcelId]);
            if (rows.length) {
                await client.query('ROLLBACK');
                const set = rows.map(row => ({ owner: row.owner_wallet, ownerCount: Number(row.owner_count) }));
                result = { ...item, outcome: isSoleOwner(set, item.wallet) ? 'registered' : 'conflict', owners: set.map(row => row.owner) };
            } else {
                await client.query(
                    `INSERT INTO ${OWNER_TABLE} (parcel_uid, owner_wallet, owner_count, established_at, note)
                     VALUES ($1, $2, 1, now(), $3)`,
                    [item.parcelId, item.wallet, note(item)]
                );
                await client.query('COMMIT');
                result = { ...item, outcome: 'inserted' };
            }
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        results.push(result);
        log(`${index + 1}/${items.length} ${result.parcelId} → ${result.persona} ${result.wallet}: ${result.outcome}${result.owners ? ` (${result.owners.join(', ')})` : ''}`);
    }
    return results;
}

/** The registry note of an agent's registration: free operator text, never a person's name. */
export const agentRegistrationNote = (source) => item => `agent ${item.persona} (${source})`;
