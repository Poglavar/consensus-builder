// HTTP face of the reference lens member: status, challenge, x402-priced ownership attestation,
// operator-only verdicts and the list of issued attestations. Every refusal the member can make
// (unknown parcel, wrong signature, missing source time) happens before the payment gate.

import { timingSafeEqual, createHash } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { LensError, lensLog } from './errors.js';
import { LENS_OWNERSHIP_PATH, describePricing } from './pricing.js';

export const OPERATOR_TOKEN_HEADER = 'x-lens-operator-token';

function isPubkey(value) {
    try {
        return typeof value === 'string' && new PublicKey(value).toBase58() === value;
    } catch {
        return false;
    }
}

function requireString(body, name) {
    const value = body?.[name];
    if (typeof value !== 'string' || !value.trim()) throw new LensError(400, 'bad_request', `${name} is required`);
    return value.trim();
}

// Unix seconds or an ISO timestamp -> Unix seconds.
function sourceTimeOf(value) {
    if (Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && value.trim()) {
        const ms = Date.parse(value);
        if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    }
    throw new LensError(400, 'bad_request', 'sourceObservedAt is required (Unix seconds or ISO 8601)');
}

function tokensEqual(a, b) {
    const digest = value => createHash('sha256').update(String(value)).digest();
    return timingSafeEqual(digest(a), digest(b));
}

function publicRecord(record) {
    const { reused, ...rest } = record;
    return rest;
}

const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * @param {{ member: ReturnType<import('./member.js').createLensMember>, pricing: object, operatorToken?: string|null }} options
 */
export function createLensMemberApp({ member, pricing, operatorToken = null, corsOrigin = '*' }) {
    if (!member) throw new Error('createLensMemberApp: member is required');
    if (!pricing) throw new Error('createLensMemberApp: pricing is required');
    const identity = member.identity;
    const app = express();
    // A lens member is a public service: owners call it from any site's browser and agents from
    // anywhere, so CORS is open by default (no credentials). Response headers are exposed so an
    // x402 402 challenge and the attestation headers reach browser clients.
    app.use(cors({ origin: corsOrigin, methods: ['GET', 'POST', 'OPTIONS'], credentials: false, exposedHeaders: '*' }));
    app.use(express.json({ limit: '32kb' }));
    app.use((req, res, next) => {
        const started = Date.now();
        res.on('finish', () => lensLog(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started} ms)`));
        next();
    });

    app.get('/lens/status', wrap(async (_req, res) => {
        res.json({ ...(await member.status()), pricing: { ownership: describePricing(pricing) } });
    }));

    app.post('/lens/challenge', wrap(async (req, res) => {
        const parcelUid = requireString(req.body, 'parcelUid');
        const owner = requireString(req.body, 'owner');
        if (!isPubkey(owner)) throw new LensError(400, 'bad_request', 'owner must be a base58 public key');
        res.status(201).json(await identity.issueChallenge({ parcelUid, owner }));
    }));

    // Free prechecks: body, wallet signature over the challenge, the member's own plan (unknown
    // parcel, missing source time, inconsistent registry). An owner already attested gets the stored
    // record back without paying twice.
    const ownershipPrecheck = wrap(async (req, res, next) => {
        const parcelUid = requireString(req.body, 'parcelUid');
        const owner = requireString(req.body, 'owner');
        const signature = requireString(req.body, 'signature');
        const challenge = requireString(req.body, 'challenge');
        if (!isPubkey(owner)) throw new LensError(400, 'bad_request', 'owner must be a base58 public key');
        await identity.verifyOwner({ parcelUid, owner, signature, challenge });
        const plan = await member.planOwnership({ parcelUid, owner });
        if (plan.existing) {
            identity.consume(challenge);
            return res.status(200).json({ ...publicRecord(plan.existing), reused: true, pricing: describePricing(pricing) });
        }
        req.lensOwnership = { parcelUid, owner, challenge };
        next();
    });

    const ownershipPricing = pricing.enabled
        ? pricing.gate
        : pricing.mode === 'dry-run'
            ? (_req, _res, next) => next()
            : (_req, res) => res.status(503).json({ error: 'Paid ownership attestations are not configured on this lens member.', missing: pricing.missing ?? [] });

    app.post(LENS_OWNERSHIP_PATH, ownershipPrecheck, ownershipPricing, wrap(async (req, res) => {
        if (pricing.enabled && !req.lensPayment?.transaction) {
            // Fail closed: the gate did not stamp a settlement.
            return res.status(402).json({ error: 'Payment was not settled for this request.' });
        }
        const { parcelUid, owner, challenge } = req.lensOwnership;
        const record = await member.attestOwnership({ parcelUid, owner, payment: req.lensPayment ?? null });
        identity.consume(challenge);
        res.status(record.reused ? 200 : 201).json({ ...publicRecord(record), reused: record.reused, pricing: describePricing(pricing) });
    }));

    app.post('/lens/verdict', wrap(async (req, res) => {
        if (!operatorToken) throw new LensError(503, 'operator_not_configured', 'LENS_OPERATOR_TOKEN is not set on this lens member');
        const supplied = req.get(OPERATOR_TOKEN_HEADER);
        if (!supplied || !tokensEqual(supplied, operatorToken)) throw new LensError(401, 'operator_only', 'verdicts require the operator token');
        const proposalAccount = requireString(req.body, 'proposalAccount');
        const verdict = requireString(req.body, 'verdict');
        const evidenceRef = typeof req.body.evidenceRef === 'string' ? req.body.evidenceRef : '';
        const sourceObservedAt = sourceTimeOf(req.body.sourceObservedAt);
        const record = await member.attestVerdict({ proposalAccount, verdict, evidenceRef, sourceObservedAt });
        res.status(record.reused ? 200 : 201).json({ ...publicRecord(record), reused: record.reused });
    }));

    app.get('/lens/attestations', wrap(async (req, res) => {
        const text = name => (typeof req.query[name] === 'string' && req.query[name].trim() ? req.query[name].trim() : null);
        const kind = text('kind');
        if (kind && !['ownership', 'verdict'].includes(kind)) throw new LensError(400, 'bad_request', 'kind must be ownership or verdict');
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 500);
        const attestations = await member.listAttestations({
            parcelUid: text('parcelUid'), proposalAccount: text('proposalAccount'), owner: text('owner'), kind, limit
        });
        res.json({ attestations: attestations.map(publicRecord) });
    }));

    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, _next) => {
        if (error instanceof LensError) {
            lensLog(`${req.method} ${req.originalUrl} refused: ${error.code} ${error.message}`);
            return res.status(error.status).json({ error: error.code, message: error.message });
        }
        if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request', message: 'body is not valid JSON' });
        console.error(`[${new Date().toISOString()}] [lens-member] ${req.method} ${req.originalUrl} failed:`, error);
        return res.status(500).json({ error: 'internal_error', message: error.message });
    });
    return app;
}
