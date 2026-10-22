// Attestation stores for the reference lens member: Postgres (consensus.lens_attestation, DDL in
// routes/lens-member-ddl.sql) for a live member, a JSON file for a member run without Postgres, and
// an in-memory one for dry runs and tests. All hold the same record shape the member produces;
// issued_at is chain time, never insert time. An AgreementDecision record names its agreement in the
// payload (agreementCid, sponsor), the way MarketEvidence names its recipe.

import fs from 'node:fs';

function emptyCounts() {
    return { ownership: 0, decision: 0, evidence: 0, parcels: 0, agreements: 0 };
}

// recipeHash selects MarketEvidence-v1 records by the recipe they answer and agreementCid
// AgreementDecision-v1 records by their agreement (both live in the payload).
function matches(record, { parcelUid, agreementCid, owner, recipeHash, kind }) {
    return (!parcelUid || record.parcelUid === parcelUid)
        && (!agreementCid || record.payload?.agreementCid === agreementCid)
        && (!owner || record.owner === owner)
        && (!recipeHash || record.payload?.recipeHash === recipeHash)
        && (!kind || record.kind === kind);
}

export function createMemoryStore({ initial = [], onRecord = null } = {}) {
    const records = new Map(initial.map(record => [record.address, { ...record }]));
    return {
        kind: 'memory',
        async get(address) {
            return records.get(address) ?? null;
        },
        async record(record) {
            if (records.has(record.address)) throw new Error(`attestation ${record.address} is already recorded`);
            records.set(record.address, { ...record });
            if (onRecord) await onRecord([...records.values()]);
        },
        async list(filter = {}) {
            return [...records.values()].filter(record => matches(record, filter)).slice(0, filter.limit ?? 200);
        },
        async counts() {
            const counts = emptyCounts();
            const parcels = new Set();
            const agreements = new Set();
            for (const record of records.values()) {
                counts[record.kind] += 1;
                if (record.parcelUid) parcels.add(record.parcelUid);
                if (record.kind === 'decision') agreements.add(record.payload?.agreementCid);
            }
            return { ...counts, parcels: parcels.size, agreements: agreements.size };
        }
    };
}

// Every issued attestation in one JSON array, rewritten through a temp file and a rename on each
// record, so a kill never leaves a half-written file. For a single member process only.
export function createFileStore(file) {
    let initial = [];
    if (fs.existsSync(file)) {
        initial = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(initial)) throw new Error(`${file} must hold a JSON array of attestation records`);
    }
    const store = createMemoryStore({
        initial,
        onRecord: async records => {
            const temp = `${file}.${process.pid}.tmp`;
            await fs.promises.writeFile(temp, `${JSON.stringify(records, null, 2)}\n`);
            await fs.promises.rename(temp, file);
        }
    });
    return { ...store, kind: 'file' };
}

function recordOf(row) {
    return {
        address: row.address,
        kind: row.kind,
        credential: row.credential,
        schema: row.schema,
        authority: row.authority,
        parcelUid: row.parcel_uid,
        owner: row.owner,
        payload: row.payload,
        accountHash: row.account_hash,
        expiry: Number(row.expiry),
        transactionSignature: row.transaction_signature,
        payment: row.payment,
        issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null
    };
}

const COLUMNS = `address, kind, credential, schema, authority, parcel_uid, owner, payload,
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
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13)
                ON CONFLICT (address) DO NOTHING
            `, [r.address, r.kind, r.credential, r.schema, r.authority, r.parcelUid, r.owner,
                JSON.stringify(r.payload), r.accountHash, r.expiry, r.transactionSignature,
                r.payment ? JSON.stringify(r.payment) : null, r.issuedAt]);
            if (rowCount !== 1) throw new Error(`attestation ${r.address} is already recorded`);
        },
        async list({ parcelUid = null, agreementCid = null, owner = null, recipeHash = null, kind = null, limit = 200 } = {}) {
            const { rows } = await pool.query(`
                SELECT ${COLUMNS} FROM consensus.lens_attestation
                WHERE ($1::text IS NULL OR parcel_uid = $1)
                  AND ($2::text IS NULL OR payload->>'agreementCid' = $2)
                  AND ($3::text IS NULL OR owner = $3)
                  AND ($4::text IS NULL OR kind = $4)
                  AND ($5::text IS NULL OR payload->>'recipeHash' = $5)
                ORDER BY issued_at DESC NULLS LAST, address
                LIMIT $6
            `, [parcelUid, agreementCid, owner, kind, recipeHash, limit]);
            return rows.map(recordOf);
        },
        async counts() {
            const { rows } = await pool.query(`
                SELECT count(*) FILTER (WHERE kind = 'ownership')::int AS ownership,
                       count(*) FILTER (WHERE kind = 'decision')::int AS decision,
                       count(*) FILTER (WHERE kind = 'evidence')::int AS evidence,
                       count(DISTINCT parcel_uid)::int AS parcels,
                       count(DISTINCT payload->>'agreementCid') FILTER (WHERE kind = 'decision')::int AS agreements
                FROM consensus.lens_attestation
            `);
            return { ...emptyCounts(), ...rows[0] };
        }
    };
}
