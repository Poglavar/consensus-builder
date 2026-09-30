// Attester directory for the lens model: reads and upserts consensus.lens_member. Informational only;
// no program reads it. The land-event job calls upsertLensMember with what it saw on chain; a member
// lists itself through registerLensMember (oracle/lens-registration.js verifies it first).

import { PublicKey } from '@solana/web3.js';

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

// seenAt is the on-chain time of the attestation that revealed the member (never the job's clock);
// omit it for a curated entry and the seen columns stay as they are. Null text fields keep the
// stored value, so a coverage refresh never wipes a curated name.
function sourceTime(value) {
    if (value === undefined || value === null) return null;
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('seenAt must be a Date, ISO string or Unix seconds');
    return date.toISOString();
}

export async function upsertLensMember(pool, member = {}) {
    let key;
    try {
        key = new PublicKey(member.key).toBase58();
    } catch {
        throw new Error('lens member key must be a base58 public key');
    }
    if (key !== member.key) throw new Error('lens member key must be a base58 public key');
    const coverage = member.coverage
        ? Object.fromEntries(COVERAGE_KEYS.map(k => [k, count(member.coverage[k])]))
        : null;
    const seenAt = sourceTime(member.seenAt);
    const { rows } = await pool.query(`
        INSERT INTO consensus.lens_member
            (key, kind, name, description, metadata_uri, service_url, coverage, first_seen_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{"ownership":0,"parcels":0,"executed":0}'::jsonb), $8, $8)
        ON CONFLICT (key) DO UPDATE SET
            kind = COALESCE(EXCLUDED.kind, lens_member.kind),
            name = COALESCE(EXCLUDED.name, lens_member.name),
            description = COALESCE(EXCLUDED.description, lens_member.description),
            metadata_uri = COALESCE(EXCLUDED.metadata_uri, lens_member.metadata_uri),
            service_url = COALESCE(EXCLUDED.service_url, lens_member.service_url),
            coverage = COALESCE($7::jsonb, lens_member.coverage),
            first_seen_at = LEAST(lens_member.first_seen_at, EXCLUDED.first_seen_at),
            last_seen_at = GREATEST(lens_member.last_seen_at, EXCLUDED.last_seen_at),
            updated_at = now()
        RETURNING key, kind, name, description, service_url, registered_at, coverage
    `, [
        key,
        member.kind ?? null,
        member.name ?? null,
        member.description ?? null,
        member.metadataUri ?? null,
        member.serviceUrl ?? null,
        coverage ? JSON.stringify(coverage) : null,
        seenAt
    ]);
    return memberFromRow(rows[0]);
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
