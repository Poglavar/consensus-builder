// Standalone parcel purchase/sale offer index.  It intentionally has no dependency on plans,
// designs or agreement/v1.  Chain settlement is recorded separately by the caller after the
// property-offer program has accepted the exact offer CID.
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { isPlainObject } from '../utils/request-validation.js';
import { normalizeCityCode } from '../utils/city-code.js';
import { createOfferChain, mirrorOfferAccount, client } from '../property-offers/onchain.js';
import rateLimit from 'express-rate-limit';

const require = createRequire(import.meta.url);
const PropertyOfferRecord = require('../../frontend/js/property-offer-record.js');
export const PROPERTY_OFFER_TABLE = 'consensus.property_offer';

const iso = value => value instanceof Date ? value.toISOString() : value ?? null;
const limitOf = value => value === undefined ? 20 : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 100 ? Number(value) : null;
const offsetOf = value => value === undefined ? 0 : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 1000000 ? Number(value) : null;
const parcelKey = parcel => JSON.stringify([parcel.sourceId, parcel.id, parcel.snapshotId || null]);

export function serializePropertyOffer(row) {
    return { cid: row.cid, content: row.content, createdAt: iso(row.created_at), onchain: row.onchain ?? null,
        acceptance: row.acceptance ?? null };
}

export async function loadPropertyOffer(db, cid) {
    const { rows } = await db.query(`SELECT cid, content, created_at, onchain, acceptance FROM ${PROPERTY_OFFER_TABLE} WHERE cid = $1`, [cid]);
    return rows[0] ? serializePropertyOffer(rows[0]) : null;
}

export function validatePropertyOfferContent(content, { now = Date.now() } = {}) {
    const problem = PropertyOfferRecord.validate(content, { now });
    if (problem) return { ok: false, status: 400, ...problem };
    if (Date.parse(content.expiresAt) <= now) return { ok: false, status: 422, code: 'expired-offer', message: 'Offer expiry must be in the future.' };
    return { ok: true };
}

export function setupPropertyOffersRoute(app, { pool, now = () => Date.now(), propertyOfferChain = createOfferChain } = {}) {
    const one = cid => loadPropertyOffer(pool, cid);
    const limiter = () => rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
    app.post('/property-offers', limiter(), async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['cid', 'content'].includes(key)) || !isCid(body.cid) || !isPlainObject(body.content)) {
            return res.status(400).json({ code: 'bad-request', error: 'Body must be { cid, content } with a valid CID and property-offer/v1 content.' });
        }
        let bytes;
        try { bytes = canonicalBytes(body.content); } catch (error) { return res.status(400).json({ code: 'invalid-property-offer', error: error.message }); }
        const computedCid = cidOf(bytes);
        if (computedCid !== body.cid) return res.status(400).json({ code: 'cid-mismatch', error: `The content is ${computedCid}, not ${body.cid}.`, computedCid });
        const checked = validatePropertyOfferContent(body.content, { now: now() });
        if (!checked.ok) return res.status(checked.status).json({ code: checked.code, error: checked.message });
        if (cidOf(canonicalBytes(PropertyOfferRecord.published(body.content))) !== body.cid) return res.status(400).json({ code: 'noncanonical-offer', error: 'Publish normalized property-offer terms.' });
        try {
            const existing = await one(body.cid);
            if (existing) return res.status(409).json(existing);
            const content = PropertyOfferRecord.published(body.content, { now: now() });
            const keys = content.parcels.map(parcelKey);
            await pool.query(`INSERT INTO ${PROPERTY_OFFER_TABLE}
                (cid, city, title, direction, proposer, buyer, seller, lens, parcel_refs, parcel_keys, price_lamports, expires_at, content)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)`, [body.cid, normalizeCityCode(content.city), content.title || null,
                content.direction, content.proposer, content.buyer, content.seller, content.lens, JSON.stringify(content.parcels), keys,
                content.priceLamports, content.expiresAt, JSON.stringify(content)]);
            return res.status(201).json(await one(body.cid));
        } catch (error) { console.error('[property-offers] POST failed:', error); return res.status(503).json({ code: 'property-offer-unavailable', error: 'The property offer could not be saved. Please retry.' }); }
    });
    app.get('/property-offers', async (req, res) => {
        const city = req.query.city === undefined ? null : normalizeCityCode(req.query.city);
        const limit = limitOf(req.query.limit), offset = offsetOf(req.query.offset);
        if ((req.query.city !== undefined && !city) || limit === null || offset === null) return res.status(400).json({ code: 'bad-request', error: 'city, limit or offset is invalid.' });
        try {
            const { rows } = await pool.query(`SELECT cid, content, created_at, onchain, acceptance FROM ${PROPERTY_OFFER_TABLE}
                WHERE ($1::text IS NULL OR city = $1) ORDER BY created_at DESC, cid LIMIT $2 OFFSET $3`, [city, limit + 1, offset]);
            const hasMore = rows.length > limit, propertyOffers = rows.slice(0, limit).map(serializePropertyOffer);
            return res.json({ propertyOffers, hasMore, nextOffset: hasMore ? offset + propertyOffers.length : null });
        } catch (error) { console.error('[property-offers] list failed:', error); return res.status(503).json({ code: 'property-offer-unavailable', error: 'Property offers could not be loaded. Please retry.' }); }
    });
    app.post('/property-offers/:cid/onchain', limiter(), async (req, res) => {
        if (!isCid(req.params.cid) || !isPlainObject(req.body) || req.body.chain !== 'solana') return res.status(400).json({ error: 'A Solana offer reference is required.' });
        try {
            const row = await one(req.params.cid);
            if (!row) return res.status(404).json({ error: 'Property offer was not found.' });
            if (row.onchain && row.onchain.cluster !== req.body.cluster) return res.status(409).json({ error: 'The offer is already indexed on another network.' });
            if (req.body.account !== client.getOfferPda(row.cid, row.content.proposer)[0].toBase58()) return res.status(422).json({ error: 'Account differs from the expected offer address.' });
            const account = await propertyOfferChain(req.body.cluster).read(row);
            const { onchain, acceptance } = mirrorOfferAccount(row, account, req.body.cluster);
            await pool.query(`UPDATE ${PROPERTY_OFFER_TABLE} SET onchain=$2::jsonb, acceptance=$3::jsonb, updated_at=now() WHERE cid=$1`, [row.cid, JSON.stringify(onchain), JSON.stringify(acceptance)]);
            return res.json({ ...row, onchain, acceptance });
        } catch (error) { return res.status(error.status || 503).json({ code: error.code || 'chain-unavailable', error: error.message }); }
    });
    app.get('/property-offers/:cid', async (req, res) => {
        if (!isCid(req.params.cid)) return res.status(400).json({ code: 'invalid-cid', error: 'Invalid property offer CID.' });
        try { const row = await one(req.params.cid); return row ? res.json(row) : res.status(404).json({ code: 'not-found', error: 'Property offer was not found.' }); }
        catch (error) { console.error('[property-offers] get failed:', error); return res.status(503).json({ code: 'property-offer-unavailable', error: 'Property offer could not be loaded. Please retry.' }); }
    });
}
