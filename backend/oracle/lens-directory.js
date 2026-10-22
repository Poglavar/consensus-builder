// Attester directory for the lens model: reads and writes consensus.lens_member. Informational only;
// no program reads it. A member lists itself through registerLensMember (oracle/lens-registration.js
// verifies it first). The coverage counts were derived from proposal_nft acceptance records, which M3
// removed with per-proposal consent (owner decisions are off-chain documents now); they are served as
// stored and nothing refreshes them.

const COVERAGE_KEYS = ['ownership', 'parcels', 'executed'];

function count(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function memberFromRow(row) {
    const coverage = row.coverage || {};
    return {
        key: row.key,
        kind: row.kind ?? null,
        name: row.name ?? null,
        description: row.description ?? null,
        serviceUrl: row.service_url ?? null,
        registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
        coverage: Object.fromEntries(COVERAGE_KEYS.map(key => [key, count(coverage[key])]))
    };
}

export async function listLensMembers(pool) {
    const { rows } = await pool.query(`
        SELECT key, kind, name, description, service_url, registered_at, coverage
        FROM consensus.lens_member
        ORDER BY COALESCE((coverage->>'ownership')::bigint, 0) DESC, key
    `);
    return rows.map(memberFromRow);
}

// A verified self-registration: the member's own statement replaces its name, kind, description and
// service URL. registered_at is the member's signed time, and only a newer one may replace it, so a
// replayed registration changes nothing. Returns null for such a replay.
export async function registerLensMember(pool, registration) {
    const { rows } = await pool.query(`
        INSERT INTO consensus.lens_member (key, kind, name, description, service_url, credential_name, registered_at)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
        ON CONFLICT (key) DO UPDATE SET
            kind = EXCLUDED.kind,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            service_url = EXCLUDED.service_url,
            credential_name = EXCLUDED.credential_name,
            registered_at = EXCLUDED.registered_at,
            updated_at = now()
        WHERE lens_member.registered_at IS NULL OR lens_member.registered_at < EXCLUDED.registered_at
        RETURNING key, kind, name, description, service_url, registered_at, coverage
    `, [
        registration.key,
        registration.kind,
        registration.name,
        registration.description || null,
        registration.serviceUrl,
        registration.credentialName,
        registration.signedAt
    ]);
    return rows[0] ? memberFromRow(rows[0]) : null;
}
