// Public read API for deterministic land events (the agreement lifecycle oracle's: an agreement's
// terminal `agreement_lifecycle` event and the per-parcel `agreement_executed` events) and the immutable
// court recipes. Event production is a separate restartable CLI (oracle/agreement-lifecycle-job.mjs),
// never a side effect of GET.

import { PublicKey } from '@solana/web3.js';
import fs from 'node:fs';
import { isCid } from '../cid.js';
import { AGREEMENT_EVENT_TYPES, AGREEMENT_LIFECYCLE_EVENT_TYPE } from '../oracle/agreement-lifecycle.js';
import { landEventParcelCondition, validParcelUid } from '../oracle/parcel-history.js';
import {
    buildCourtParcelOperationRecipe,
    buildCourtParcelOperationRecipeV2,
    COURT_RECIPE_ID,
    COURT_RECIPE_V2_ID,
    COURT_SCHEMA_V2,
    externalMarketAddress
} from '../oracle/court-parcel-operation.js';

// ?type= of GET /oracle/events; the agreement's terminal event is the default.
const EVENT_TYPES = AGREEMENT_EVENT_TYPES;

const RECIPE_SCHEMA = JSON.parse(fs.readFileSync(new URL('../oracle/recipe.schema.json', import.meta.url), 'utf8'));

function limitOf(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 25;
}

function validAddress(value) {
    try { return new PublicKey(String(value)).toBase58(); } catch { return null; }
}

function eventFromRow(row) {
    return {
        id: row.event_id,
        eventType: row.event_type,
        subject: { type: row.subject_type, id: row.subject_id },
        outcome: row.outcome,
        observedAt: row.source_observed_at,
        recordedAt: row.created_at,
        attester: { kind: 'solana_program', address: row.attester },
        source: {
            url: row.source_url,
            hash: row.source_hash,
            transaction: row.transaction_signature,
            ...(row.evidence?.source || {})
        },
        evidence: row.evidence || {}
    };
}

export function setupLandEventsRoute(app, pool) {
    app.get('/oracle/recipe.schema.json', (_req, res) => res.json(RECIPE_SCHEMA));

    app.get('/oracle/public-records/summary', async (_req, res) => {
        try {
            const { rows } = await pool.query(`
                WITH filtered AS (
                    SELECT schema_id, parcel_uid, decision_uuid, created_at
                    FROM court.attestation
                    WHERE chain = 'solana-devnet'
                ), by_schema AS (
                    SELECT schema_id, count(*)::int AS attestations,
                           max(created_at) AS latest_attestation_at
                    FROM filtered
                    GROUP BY schema_id
                )
                SELECT count(*)::int AS attestations,
                       count(DISTINCT parcel_uid)::int AS parcels,
                       count(DISTINCT decision_uuid)::int AS decisions,
                       min(schema_id) AS schema_id,
                       max(created_at) AS latest_attestation_at,
                       (SELECT COALESCE(json_agg(json_build_object(
                           'schemaId', schema_id,
                           'attestations', attestations,
                           'latestAttestationAt', latest_attestation_at
                       ) ORDER BY schema_id), '[]'::json) FROM by_schema) AS schemas
                FROM filtered
            `);
            const row = rows[0] || {};
            const schemaId = row.schema_id || null;
            const schemas = Array.isArray(row.schemas) ? row.schemas : [];
            const v2Row = schemas.find(item => item.schemaId === COURT_SCHEMA_V2);
            return res.json({
                source: 'Croatian judiciary e-Oglasna archive',
                evidence: 'parcel-level court-decision attestations',
                privacy: 'aggregate-only; decision identifiers, parties, quotes and parcel identifiers are not republished here',
                chain: 'solana:devnet',
                schemaId,
                schemaUrl: schemaId
                    ? `https://explorer.solana.com/address/${encodeURIComponent(schemaId)}?cluster=devnet`
                    : null,
                schemas,
                v2: {
                    status: v2Row ? 'live_devnet' : 'awaiting_first_attestation',
                    schemaId: COURT_SCHEMA_V2,
                    schemaUrl: `https://explorer.solana.com/address/${COURT_SCHEMA_V2}?cluster=devnet`,
                    attestations: Number(v2Row?.attestations || 0),
                    sourceTimestamped: true
                },
                attestations: Number(row.attestations || 0),
                parcels: Number(row.parcels || 0),
                decisions: Number(row.decisions || 0),
                latestAttestationAt: row.latest_attestation_at || null,
                marketIntegration: 'recipe-bound market verifier, V1 settlement and source-timed V2 attestations are live on devnet'
            });
        } catch (error) {
            console.error('GET /oracle/public-records/summary failed', error);
            return res.status(500).json({ error: 'Failed to read public-record oracle summary' });
        }
    });

    // ?type= (agreement_lifecycle by default, or agreement_executed), ?subject=<agreement account> (the
    // subject of agreement_lifecycle events), ?agreement=<cid>, ?parcelUid= (agreement_executed: the
    // parcel's own; agreement_lifecycle: agreements whose inputs list it), ?limit=.
    app.get('/oracle/events', async (req, res) => {
        try {
            const limit = limitOf(req.query.limit);
            const subject = req.query.subject ? validAddress(req.query.subject) : null;
            if (req.query.subject && !subject) return res.status(400).json({ error: 'subject must be a Solana address' });
            const eventType = req.query.type ? String(req.query.type) : AGREEMENT_LIFECYCLE_EVENT_TYPE;
            if (!EVENT_TYPES.includes(eventType)) return res.status(400).json({ error: `type must be one of ${EVENT_TYPES.join(', ')}` });
            const params = [eventType];
            let where = 'event_type = $1';
            if (subject) { params.push(subject); where += ` AND subject_id = $${params.length}`; }
            const agreement = req.query.agreement !== undefined ? String(req.query.agreement) : null;
            if (agreement !== null && !isCid(agreement)) return res.status(400).json({ error: 'agreement must be an agreement CID' });
            if (agreement) { params.push(agreement); where += ` AND evidence->>'agreementCid' = $${params.length}`; }
            const parcelUid = req.query.parcelUid !== undefined ? validParcelUid(String(req.query.parcelUid)) : null;
            if (req.query.parcelUid !== undefined && !parcelUid) return res.status(400).json({ error: 'parcelUid must be 1-128 printable characters' });
            if (parcelUid) { params.push(parcelUid); where += ` AND ${landEventParcelCondition(params.length)}`; }
            params.push(limit);
            const { rows } = await pool.query(`
                SELECT event_id, event_type, subject_type, subject_id, outcome, source_url,
                       source_hash, source_observed_at, attester, transaction_signature,
                       evidence, created_at
                FROM consensus.land_event
                WHERE ${where}
                ORDER BY source_observed_at DESC
                LIMIT $${params.length}
            `, params);
            const events = rows.map(eventFromRow);
            return res.json({ events, count: events.length, eventType, ...(agreement ? { agreement } : {}), ...(parcelUid ? { parcelUid } : {}) });
        } catch (error) {
            console.error('GET /oracle/events failed', error);
            return res.status(500).json({ error: 'Failed to read land events' });
        }
    });

    app.get(`/oracle/recipes/${COURT_RECIPE_ID}`, (req, res) => {
        try {
            const recipe = buildCourtParcelOperationRecipe({
                parcelUid: req.query.parcelUid,
                yesOperation: req.query.yesOperation,
                noOperation: req.query.noOperation,
                closesAt: req.query.closesAt
            });
            return res.json({ recipe, marketAccount: externalMarketAddress(recipe.hash) });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });

    app.get(`/oracle/recipes/${COURT_RECIPE_V2_ID}`, (req, res) => {
        try {
            const recipe = buildCourtParcelOperationRecipeV2({
                parcelUid: req.query.parcelUid,
                yesOperation: req.query.yesOperation,
                noOperation: req.query.noOperation,
                closesAt: req.query.closesAt,
                schema: req.query.schema
            });
            return res.json({ recipe, marketAccount: externalMarketAddress(recipe.hash) });
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
    });
}

export { eventFromRow, limitOf, validAddress };
