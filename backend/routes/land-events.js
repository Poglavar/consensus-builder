// Public read API for deterministic land events and the immutable recipe consumed by the proposal
// prediction market. Event production is a separate restartable CLI, never a side effect of GET.

import { PublicKey } from '@solana/web3.js';
import fs from 'node:fs';
import { buildProposalLifecycleRecipe, EVENT_TYPE, RECIPE_ID } from '../oracle/proposal-lifecycle.js';
import {
    buildCourtParcelOperationRecipe,
    buildCourtParcelOperationRecipeV2,
    COURT_RECIPE_ID,
    COURT_RECIPE_V2_ID,
    externalMarketAddress
} from '../oracle/court-parcel-operation.js';

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
                SELECT count(*)::int AS attestations,
                       count(DISTINCT parcel_uid)::int AS parcels,
                       count(DISTINCT decision_uuid)::int AS decisions,
                       min(schema_id) AS schema_id,
                       max(created_at) AS latest_attestation_at
                FROM court.attestation
                WHERE chain = 'solana-devnet'
            `);
            const row = rows[0] || {};
            const schemaId = row.schema_id || null;
            return res.json({
                source: 'Croatian judiciary e-Oglasna archive',
                evidence: 'parcel-level court-decision attestations',
                privacy: 'aggregate-only; decision identifiers, parties, quotes and parcel identifiers are not republished here',
                chain: 'solana:devnet',
                schemaId,
                schemaUrl: schemaId
                    ? `https://explorer.solana.com/address/${encodeURIComponent(schemaId)}?cluster=devnet`
                    : null,
                attestations: Number(row.attestations || 0),
                parcels: Number(row.parcels || 0),
                decisions: Number(row.decisions || 0),
                latestAttestationAt: row.latest_attestation_at || null,
                marketIntegration: 'recipe-bound market verifier and first court-SAS settlement are live on devnet'
            });
        } catch (error) {
            console.error('GET /oracle/public-records/summary failed', error);
            return res.status(500).json({ error: 'Failed to read public-record oracle summary' });
        }
    });

    app.get('/oracle/events', async (req, res) => {
        try {
            const limit = limitOf(req.query.limit);
            const subject = req.query.subject ? validAddress(req.query.subject) : null;
            if (req.query.subject && !subject) return res.status(400).json({ error: 'subject must be a Solana address' });
            const params = [EVENT_TYPE];
            let where = 'event_type = $1';
            if (subject) { params.push(subject); where += ` AND subject_id = $${params.length}`; }
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
            return res.json({ events, count: events.length, eventType: EVENT_TYPE });
        } catch (error) {
            console.error('GET /oracle/events failed', error);
            return res.status(500).json({ error: 'Failed to read land events' });
        }
    });

    app.get(`/oracle/recipes/${RECIPE_ID}`, (req, res) => {
        const proposalAccount = validAddress(req.query.proposal);
        const marketAccount = req.query.market ? validAddress(req.query.market) : null;
        if (!proposalAccount) return res.status(400).json({ error: 'proposal must be a Solana address' });
        if (req.query.market && !marketAccount) return res.status(400).json({ error: 'market must be a Solana address' });
        return res.json({ recipe: buildProposalLifecycleRecipe({ proposalAccount, marketAccount }) });
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
