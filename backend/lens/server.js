// HTTP face of the reference lens member: status, challenge, x402-priced ownership attestation,
// operator-only agreement decisions and market evidence, the list of issued attestations and, with a
// rights registry, the signed rights/authority facts for abstract agreement approval. Every refusal the
// member can make (unknown parcel, wrong signature, missing source time, a rule not met) happens before
// anything is paid for or issued.

import { timingSafeEqual, createHash } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { isCid, canonicalBytes } from '../cid.js';
import { LENS_SCHEMA_KINDS } from '../oracle/lens-schemas.js';
import { countAgreementDecisions, planAgreementDecision } from './agreement-decision.js';
import { LensError, lensLog } from './errors.js';
import { systemClock } from './member.js';
import { planPropertyOfferDecision } from './property-offer-decision.js';
import { planApartmentReservationQualification } from './apartment-reservation-qualification.js';
import { readOwnership } from '../property-offers/ownership.js';
import { ownershipTransferBasis } from '../property-offers/ownership-transfers.js';
import rateLimit from 'express-rate-limit';
import { createRequire } from 'node:module';
import { verifyWalletSignature } from './identity/devnet-registry.js';
const PropertyOfferConsent = createRequire(import.meta.url)('../../frontend/js/property-offer-consent.js');
const PropertyOfferRecord = createRequire(import.meta.url)('../../frontend/js/property-offer-record.js');
import { LENS_OWNERSHIP_PATH, describePricing } from './pricing.js';

export const OPERATOR_TOKEN_HEADER = 'x-lens-operator-token';
export const APPROVAL_PATH_PREFIX = '/lens/approval/';

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

// Unix seconds only. An ISO date without a zone would be read as UTC midnight, the very shift the
// evidence adapters avoid by reading source dates in the source's own time zone.
function unixSecondsOf(body, name) {
    const value = body?.[name];
    if (!Number.isSafeInteger(value)) throw new LensError(400, 'bad_request', `${name} must be Unix seconds (an integer)`);
    return value;
}

// Hash-committed text is passed on byte for byte, never trimmed; the member refuses padded text.
function exactString(body, name) {
    const value = body?.[name];
    if (typeof value !== 'string' || !value.trim()) throw new LensError(400, 'bad_request', `${name} is required`);
    return value;
}

function tokensEqual(a, b) {
    const digest = value => createHash('sha256').update(String(value)).digest();
    return timingSafeEqual(digest(a), digest(b));
}

function requireOperator(req, operatorToken, refusal) {
    if (!operatorToken) throw new LensError(503, 'operator_not_configured', 'LENS_OPERATOR_TOKEN is not set on this lens member');
    const supplied = req.get(OPERATOR_TOKEN_HEADER);
    if (!supplied || !tokensEqual(supplied, operatorToken)) throw new LensError(401, 'operator_only', refusal);
}

function publicRecord(record) {
    const { reused, ...rest } = record;
    return rest;
}

const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/**
 * @param {{ member: ReturnType<import('./member.js').createLensMember>, pricing: object, operatorToken?: string|null,
 *   approvalAttester?: ReturnType<import('./approval.js').createApprovalAttester>|null,
 *   agreements?: { load(cid: string): Promise<object|null>, decisions(cid: string): Promise<object[]> }|null,
 *   clock?: { nowSeconds(): number } }} options
 *   agreements reads the agreement index: an agreement as GET /agreements/:cid serves it, and the owner
 *   decisions its relay admitted (lens/run.mjs builds it over DATABASE_URL); without it agreement
 *   decisions answer 503.
 */
export function createLensMemberApp({ member, pricing, operatorToken = null, corsOrigin = '*', approvalAttester = null, agreements = null, propertyOffers = null, fundingChain = null, clock = systemClock }) {
    if (!member) throw new Error('createLensMemberApp: member is required');
    if (!pricing) throw new Error('createLensMemberApp: pricing is required');
    // One member, one key: approval facts must be signed by the key agreements list in their lens.
    if (approvalAttester && approvalAttester.member !== member.authority) {
        throw new Error(`createLensMemberApp: approval attester signs as ${approvalAttester.member} but the member key is ${member.authority}`);
    }
    const identity = member.identity;
    const app = express();
    // A lens member is a public service: owners call it from any site's browser and agents from
    // anywhere, so CORS is open by default (no credentials). Response headers are exposed so an
    // x402 402 challenge and the attestation headers reach browser clients.
    app.use(cors({ origin: corsOrigin, methods: ['GET', 'POST', 'OPTIONS'], credentials: false, exposedHeaders: '*' }));
    // An approval context carries the agreement's whole rights snapshot (the browser caps uploads at 1 MiB).
    const smallJson = express.json({ limit: '32kb' });
    const approvalJson = express.json({ limit: '2mb' });
    app.use((req, res, next) => (req.path.startsWith(APPROVAL_PATH_PREFIX) ? approvalJson : smallJson)(req, res, next));
    app.use((req, res, next) => {
        const started = Date.now();
        res.on('finish', () => lensLog(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started} ms)`));
        next();
    });

    app.get('/lens/status', wrap(async (_req, res) => {
        res.json({
            ...(await member.status()),
            pricing: { ownership: describePricing(pricing) },
            approval: approvalAttester ? await approvalAttester.status() : null,
            decisions: { operatorToken: Boolean(operatorToken), agreementIndex: Boolean(agreements) }
        });
    }));

    // Pre-mint check for the named member and its property policy. The browser checks the on-chain
    // credential/schema account with RPC before publishing or minting anything.
    app.post('/lens/property-offers/check', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), wrap(async (req, res) => {
        if (!propertyOffers?.load || !propertyOffers?.account) throw new LensError(503, 'property_offers_not_configured', 'This lens needs a property-offer index and chain reader.');
        const status = await member.status();
        if (status?.dryRun === true) throw new LensError(503, 'dry_run_member', 'A dry-run lens member cannot preflight property offers.');
        if (!member.credential || !member.schemas?.propertyOffer) throw new LensError(503, 'property_offer_schema_not_configured', 'This lens member has no property-offer credential or schema identifier.');
        if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'content')) throw new LensError(400, 'bad_request', 'Supply exactly one canonical content object.');
        const content = req.body.content;
        const invalid = (code, message, details) => { throw new LensError(422, code, message, details); };
        const validation = PropertyOfferRecord.validate(content);
        if (validation) invalid('invalid_offer', validation.message);
        let canonical;
        try { canonical = PropertyOfferRecord.published(content); }
        catch (error) { invalid('invalid_offer', error.message); }
        if (!Buffer.from(canonicalBytes(canonical)).equals(Buffer.from(canonicalBytes(content)))) invalid('noncanonical_offer', 'Offer content must exactly match property-offer/v1 canonical form.');
        if (Date.parse(content.expiresAt) <= clock.nowSeconds() * 1000) invalid('expired_offer', 'Offer expiry must be in the future.');
        if (content.lens !== member.authority) invalid('wrong_lens', 'The offer names another lens.');
        if (content.apartment) {
            return res.json({ key: member.authority, credential: member.credential, schema: member.schemas.propertyOffer, qualification: 'selected-lens' });
        }
        if (!identity?.ownerSets || propertyOffers.parcelDecisions === false) throw new LensError(503, 'property_offers_not_configured', 'This lens is not configured for parcel offers.');
        const sets = await readOwnership(content.parcels, identity);
        const observedOwners = new Set();
        const parcels = [];
        const missing = [], incomplete = [];
        for (const ref of content.parcels) {
            const rows = sets.get(PropertyOfferRecord.parcelUid(ref)) || [];
            if (!rows.length) { missing.push(ref); parcels.push({ ref, owners: [] }); continue; }
            const distinct = new Set(rows.map(row => row.owner));
            const valid = rows.every(row => isPubkey(row.owner) && Number.isSafeInteger(row.ownerCount)
                && row.ownerCount === rows.length && Number.isSafeInteger(row.establishedAt)
                && row.establishedAt >= 0 && row.establishedAt <= clock.nowSeconds());
            if (!valid || distinct.size !== rows.length) incomplete.push({ ref, rowCount: rows.length, declaredOwnerCounts: [...new Set(rows.map(row => row.ownerCount))] });
            rows.forEach(row => observedOwners.add(row.owner));
            parcels.push({ ref, owners: rows.map(({ owner, ownerCount, establishedAt }) => ({ owner, ownerCount, establishedAt })) });
        }
        if (missing.length) invalid('ownership_missing', 'No ownership evidence exists for one or more parcels.', { parcels: missing });
        if (incomplete.length) invalid('ownership_incomplete', 'The registry does not contain a valid complete distinct owner set for every parcel.', { parcels: incomplete });
        if (observedOwners.size > PropertyOfferRecord.MAX_PAYOUTS) invalid('too_many_owners', 'The offer exceeds the supported payout-recipient limit.', { ownerCount: observedOwners.size, limit: PropertyOfferRecord.MAX_PAYOUTS });
        if (content.direction === 'sell') {
            if (!observedOwners.has(content.proposer)) invalid('seller_not_owner', 'The sale proposer must be one of the current owners.');
            const recipients = new Set(content.payouts.map(row => row.recipient));
            if (recipients.size !== observedOwners.size || [...observedOwners].some(owner => !recipients.has(owner))) {
                invalid('payout_ownership_mismatch', 'Sale payout recipients must exactly match the current owner set.', { owners: [...observedOwners], recipients: [...recipients] });
            }
        }
        const { ownershipHash } = ownershipTransferBasis(content.parcels, sets, propertyOffers.transfers?.network);
        res.json({ key: member.authority, credential: member.credential, schema: member.schemas?.propertyOffer, parcels, ownershipHash });
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

    // AgreementDecision-v1 `satisfied` for an indexed agreement (programs/agreement/README.md).
    // Operator-only, and the operator supplies nothing but the CID: whether the rule is met comes from
    // the published rule and its owner receipts or finalized USDC deposits. A decision already issued
    // for the agreement is final here as on chain: asked again it is answered as stored.
    // → 201 issued, 200 already issued (`reused`), each with the tally.
    app.post('/lens/agreements/:cid/decision', wrap(async (req, res) => {
        requireOperator(req, operatorToken, 'agreement decisions require the operator token');
        if (!agreements) throw new LensError(503, 'agreements_not_configured', 'this lens member has no agreement index (it reads it through DATABASE_URL)');
        const cid = String(req.params.cid || '');
        if (!isCid(cid)) throw new LensError(400, 'bad_request', 'cid must be an agreement CID (bafkrei…)');
        const agreement = await agreements.load(cid);
        if (!agreement) throw new LensError(404, 'agreement_not_found', `agreement ${cid} is not in the index`);
        const count = agreement.content?.rule?.electorate === 'investors' ? null
            : countAgreementDecisions(agreement, await agreements.decisions(cid));
        const sponsor = agreement.content?.sponsor;
        const existing = typeof sponsor === 'string' ? await member.findDecision({ agreementCid: cid, sponsor }) : null;
        if (existing) return res.status(200).json({ ...publicRecord(existing), reused: true, tally: count?.tally ?? null, counted: count?.counted.length ?? 0 });
        const plan = await planAgreementDecision({ agreement, count, lensKey: member.authority, nowSeconds: clock.nowSeconds(), chain: fundingChain });
        const record = await member.attestDecision(plan.fields);
        res.status(record.reused ? 200 : 201).json({ ...publicRecord(record), reused: record.reused, tally: plan.tally, counted: plan.counted });
    }));

    async function apartmentQualification(cid, unitId, buyer) {
        if (!agreements || !fundingChain) throw new LensError(503, 'agreements_not_configured', 'This lens has no agreement funding reader.');
        if (!isCid(cid) || typeof unitId !== 'string' || !unitId || !isPubkey(buyer)) throw new LensError(400, 'bad_request', 'cid, unitId and buyer are required.');
        const agreement = await agreements.load(cid);
        if (!agreement) throw new LensError(404, 'agreement_not_found', `agreement ${cid} is not in the index`);
        return planApartmentReservationQualification({ agreement, unitId, buyer, lensKey: member.authority, nowSeconds: clock.nowSeconds(), chain: fundingChain });
    }

    app.post('/lens/agreements/:cid/apartments/:unitId/qualify', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), wrap(async (req, res) => {
        requireOperator(req, operatorToken, 'Only this lens operator can qualify an apartment counterparty.');
        if (!req.body || Object.keys(req.body).length !== 1 || !isPubkey(req.body.buyer)) throw new LensError(400, 'bad_request', 'Supply exactly one buyer wallet.');
        const fields = await apartmentQualification(req.params.cid, req.params.unitId, req.body.buyer);
        const existing = await member.findPropertyOfferQualification(fields);
        const record = existing || await member.attestPropertyOfferDecision({ ...fields, counterpartyQualified: 1, sourceObservedAt: clock.nowSeconds() });
        res.status(existing || record.reused ? 200 : 201).json({ ...publicRecord(record), reused: Boolean(existing || record.reused) });
    }));

    app.get('/lens/agreements/:cid/apartments/:unitId/qualification', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }), wrap(async (req, res) => {
        const fields = await apartmentQualification(req.params.cid, req.params.unitId, req.query.buyer);
        const record = await member.findPropertyOfferQualification(fields);
        if (!record) throw new LensError(409, 'qualification_pending', 'The selected lens has yet to qualify this counterparty for these terms.');
        res.json({ ...publicRecord(record), reused: true });
    }));

    async function loadOfferForDecision(cid) {
        if (!propertyOffers?.load || !propertyOffers?.account) throw new LensError(503, 'property_offers_not_configured', 'This lens needs a property-offer index and chain reader.');
        if (!isCid(cid)) throw new LensError(400, 'bad_request', 'cid must be a property offer CID');
        const offer = await propertyOffers.load(cid);
        if (!offer) throw new LensError(404, 'property_offer_not_found', `property offer ${cid} is not in the index`);
        if (offer.content.lens !== member.authority) throw new LensError(422, 'wrong_lens', 'The offer names another lens.');
        return offer;
    }
    async function propertyDecision(offer, candidate) {
        const account = await propertyOffers.account(offer), nowSeconds = clock.nowSeconds();
        if (offer.content.apartment) return { fields: await planPropertyOfferDecision({ offer, account, candidate, nowSeconds }) };
        if (!identity?.ownerSets || propertyOffers.parcelDecisions === false) throw new LensError(503, 'property_offers_not_configured', 'This lens is not configured for parcel offers.');
        const sets = await readOwnership(offer.content.parcels, identity);
        const basis = ownershipTransferBasis(offer.content.parcels, sets, propertyOffers.transfers?.network);
        const fields = await planPropertyOfferDecision({ offer, account, candidate, nowSeconds, ownerSets: async () => sets, ownershipHash: basis.ownershipHash });
        return { fields, basis };
    }

    // The operator expresses this member's qualification under its own policy, for precisely these terms.
    app.post('/lens/property-offers/:cid/qualify', wrap(async (req, res) => {
        requireOperator(req, operatorToken, 'Only this lens operator can qualify an apartment counterparty.');
        const offer = await loadOfferForDecision(req.params.cid);
        if (!offer.content.apartment) throw new LensError(422, 'apartment_offer_required', 'Choose an apartment offer.');
        if (!req.body || Object.keys(req.body).some(k => !['buyer', 'seller', 'payouts'].includes(k))) throw new LensError(400, 'bad_request', 'Supply the buyer, seller and payout schedule.');
        const { fields } = await propertyDecision(offer, req.body);
        const existing = await member.findPropertyOfferQualification(fields);
        const record = existing || await member.attestPropertyOfferDecision({ ...fields, counterpartyQualified: 1, sourceObservedAt: clock.nowSeconds() });
        res.status(existing || record.reused ? 200 : 201).json({ ...publicRecord(record), reused: Boolean(existing || record.reused) });
    }));
    app.post('/lens/property-offers/:cid/decision', rateLimit({ windowMs: 60000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }), wrap(async (req, res) => {
        const offer = await loadOfferForDecision(req.params.cid);
        const { fields, basis } = await propertyDecision(offer, req.body || {});
        const requester = offer.content.direction === 'buy' ? fields.seller : fields.buyer;
        const message = PropertyOfferConsent.requestMessage({ ...fields, consents: req.body.consents });
        if (req.body.requester !== requester || !verifyWalletSignature({ owner: requester, message, signature: req.body.signature })) {
            throw new LensError(401, 'invalid_request_signature', 'The accepting counterparty must sign this exact decision request.');
        }
        if (offer.content.apartment) {
            const record = await member.findPropertyOfferQualification(fields);
            if (!record) throw new LensError(409, 'qualification_pending', 'The selected lens has yet to qualify this counterparty for these terms.');
            return res.json({ ...publicRecord(record), reused: true });
        }
        const beforeIssue = propertyOffers.transfers && (decision => propertyOffers.transfers.reserve({
            offer, fields, basis, identity, consents: req.body.consents, decision
        }));
        const record = await member.attestPropertyOfferDecision(fields, { beforeIssue });
        res.status(record.reused ? 200 : 201).json({ ...publicRecord(record), reused: record.reused });
    }));

    app.get('/lens/property-offers/:cid/transfer', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }), wrap(async (req, res) => {
        if (!isCid(req.params.cid)) throw new LensError(400, 'bad_request', 'cid must be a property offer CID');
        if (!propertyOffers?.transfers) throw new LensError(503, 'transfers_not_configured', 'This lens does not publish ownership transfers.');
        const evidence = await propertyOffers.transfers.evidence(req.params.cid);
        if (!evidence) throw new LensError(404, 'transfer_not_final', 'No finalized ownership transfer is available for this offer.');
        res.json(evidence);
    }));

    // Operator-only, like agreement decisions: the operator runs a source adapter
    // (scripts/check-permit-evidence.mjs for the DBI permits dataset) and posts the fact it found for the recipe.
    app.post('/lens/market-evidence', wrap(async (req, res) => {
        requireOperator(req, operatorToken, 'market evidence requires the operator token');
        const recipe = { recipeHash: exactString(req.body, 'recipeHash'), subject: exactString(req.body, 'subject') };
        const fact = {
            value: exactString(req.body, 'value'),
            eventTime: unixSecondsOf(req.body, 'eventTime'),
            sourceObservedAt: unixSecondsOf(req.body, 'sourceObservedAt'),
            sourceRef: exactString(req.body, 'sourceRef')
        };
        const record = await member.issueMarketEvidence({ recipe, fact });
        res.status(record.reused ? 200 : 201).json({ ...publicRecord(record), reused: record.reused });
    }));

    // Abstract agreement approval (backend/lens/approval.js): free, signed off-chain facts, checked
    // against the member's registry as it reads at the request (approval.js registry sources).
    const attester = () => {
        if (!approvalAttester) throw new LensError(503, 'approval_not_configured', 'this lens member has no registry for agreement approval');
        return approvalAttester;
    };
    app.post(`${APPROVAL_PATH_PREFIX}rights`, wrap(async (req, res) => {
        res.status(201).json({ rights: await attester().attestRights(req.body) });
    }));
    app.post(`${APPROVAL_PATH_PREFIX}challenge`, wrap(async (req, res) => {
        res.status(201).json(await attester().issueChallenge({ wallet: req.body?.wallet, contextHash: req.body?.contextHash }));
    }));
    app.post(`${APPROVAL_PATH_PREFIX}authority`, wrap(async (req, res) => {
        res.status(201).json(await attester().attestAuthority(req.body || {}));
    }));

    app.get('/lens/attestations', wrap(async (req, res) => {
        const text = name => (typeof req.query[name] === 'string' && req.query[name].trim() ? req.query[name].trim() : null);
        const kind = text('kind');
        const address = text('address');
        if (kind && !LENS_SCHEMA_KINDS.includes(kind)) throw new LensError(400, 'bad_request', `kind must be one of ${LENS_SCHEMA_KINDS.join(', ')}`);
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 200, 1), 500);
        const attestations = await member.listAttestations({
            address, parcelUid: text('parcelUid'), agreementCid: text('agreementCid'), owner: text('owner'), recipeHash: text('recipeHash'), kind, limit
        });
        res.json({ attestations: attestations.map(publicRecord) });
    }));

    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, _next) => {
        if (error instanceof LensError) {
            lensLog(`${req.method} ${req.originalUrl} refused: ${error.code} ${error.message}`);
            return res.status(error.status).json({ ...(error.details || {}), error: error.code, message: error.message });
        }
        if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request', message: 'body is not valid JSON' });
        if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'request body is too large' });
        console.error(`[${new Date().toISOString()}] [lens-member] ${req.method} ${req.originalUrl} failed:`, error);
        return res.status(500).json({ error: 'internal_error', message: error.message });
    });
    return app;
}
