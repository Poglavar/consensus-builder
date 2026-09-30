// Attestation stores for the reference lens member: Postgres (consensus.lens_attestation, DDL in
// routes/lens-member-ddl.sql) for a live member, and an in-memory one for dry runs and tests.
// Both hold the same record shape the member produces; issued_at is chain time, never insert time.

function emptyCounts() {
    return { ownership: 0, verdict: 0, parcels: 0, proposals: 0 };
}

function matches(record, { parcelUid, proposalAccount, owner, kind }) {
    return (!parcelUid || record.parcelUid === parcelUid)
        && (!proposalAccount || record.proposalAccount === proposalAccount)
        && (!owner || record.owner === owner)
        && (!kind || record.kind === kind);
}

export function createMemoryStore() {
    const records = new Map();
    return {
        kind: 'memory',
        async get(address) {
            return records.get(address) ?? null;
        },
        async record(record) {
            if (records.has(record.address)) throw new Error(`attestation ${record.address} is already recorded`);
            records.set(record.address, { ...record });
        },
        async list(filter = {}) {
            return [...records.values()].filter(record => matches(record, filter)).slice(0, filter.limit ?? 200);
        },
        async counts() {
            const counts = emptyCounts();
            const parcels = new Set();
            const proposals = new Set();
            for (const record of records.values()) {
                counts[record.kind] += 1;
                if (record.parcelUid) parcels.add(record.parcelUid);
                if (record.proposalAccount) proposals.add(record.proposalAccount);
            }
            return { ...counts, parcels: parcels.size, proposals: proposals.size };
        }
    };
}

function recordOf(row) {
    return {
        address: row.address,
        kind: row.kind,
        credential: row.credential,
        schema: row.schema,
        authority: row.authority,
        parcelUid: row.parcel_uid,
        proposalAccount: row.proposal_account,
        owner: row.owner,
        payload: row.payload,
        accountHash: row.account_hash,
        expiry: Number(row.expiry),
        transactionSignature: row.transaction_signature,
        payment: row.payment,
        issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null
    };
}

const COLUMNS = `address, kind, credential, schema, authority, parcel_uid, proposal_account, owner, payload,
    account_hash, expiry, transaction_signature, payment, issued_at`;

export function createPgStore(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('createPgStore: a pg pool is required');
    return {
        kind: 'postgres',
        async get(address) {
            const { rows } = await pool.query(`SELECT ${COLUMNS} FROM consensus.lens_attestation WHERE address = $1`, [address]);
            return rows[0] ? recordOf(rows[0]) : null;
        },
        async record(r) {
            const { rowCount } = await pool.query(`
                INSERT INTO consensus.lens_attestation (${COLUMNS})
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14)
                ON CONFLICT (address) DO NOTHING
            `, [r.address, r.kind, r.credential, r.schema, r.authority, r.parcelUid, r.proposalAccount, r.owner,
                JSON.stringify(r.payload), r.accountHash, r.expiry, r.transactionSignature,
                r.payment ? JSON.stringify(r.payment) : null, r.issuedAt]);
            if (rowCount !== 1) throw new Error(`attestation ${r.address} is already recorded`);
        },
        async list({ parcelUid = null, proposalAccount = null, owner = null, kind = null, limit = 200 } = {}) {
            const { rows } = await pool.query(`
                SELECT ${COLUMNS} FROM consensus.lens_attestation
                WHERE ($1::text IS NULL OR parcel_uid = $1)
                  AND ($2::text IS NULL OR proposal_account = $2)
                  AND ($3::text IS NULL OR owner = $3)
                  AND ($4::text IS NULL OR kind = $4)
                ORDER BY issued_at DESC NULLS LAST, address
                LIMIT $5
            `, [parcelUid, proposalAccount, owner, kind, limit]);
            return rows.map(recordOf);
        },
        async counts() {
            const { rows } = await pool.query(`
                SELECT count(*) FILTER (WHERE kind = 'ownership')::int AS ownership,
                       count(*) FILTER (WHERE kind = 'verdict')::int AS verdict,
                       count(DISTINCT parcel_uid)::int AS parcels,
                       count(DISTINCT proposal_account)::int AS proposals
                FROM consensus.lens_attestation
            `);
            return { ...emptyCounts(), ...rows[0] };
        }
    };
}
