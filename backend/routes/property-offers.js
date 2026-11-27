// Index of standalone property-offer/v2 records: one plot or one flat bought or sold for SOL or devnet
// USDC (docs/property-offers.md). It has no dependency on plans, designs or agreement/v1. The chain is
// the source of truth: an offer's state (status, counterparty, lenses, confirmations) is only what
// the server read itself from its Solana account (property-offers/onchain.js), never a client's claim.
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, isCid } from '../cid.js';
import { isPlainObject } from '../utils/request-validation.js';
import { normalizeCityCode } from '../utils/city-code.js';
import { createOfferChain, mirrorOfferAccount, client } from '../property-offers/onchain.js';
import rateLimit from 'express-rate-limit';

const require = createRequire(import.meta.url);
const PropertyOfferRecord = require('../../frontend/js/property-offer-record.js');
const LensCore = require('../../frontend/js/lens-core.js');
export const PROPERTY_OFFER_TABLE = 'consensus.property_offer';
export const OFFER_STATUSES = Object.freeze(['unminted', 'open', 'committed', 'settled', 'cancelled', 'expired']);
const COLUMNS = 'cid, content, created_at, onchain, status';

const iso = value => value instanceof Date ? value.toISOString() : value ?? null;
export const limitOf = value => value === undefined ? 20 : typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number(value) <= 100 ? Number(value) : null;
export const offsetOf = value => value === undefined ? 0 : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 1000000 ? Number(value) : null;
const isKey = value => typeof value === 'string' && LensCore.isBase58Pubkey(value) && value.trim() === value;
const badRequest = message => Object.assign(new Error(message), { status: 400 });

/** "lat,lng,zoom" → { lat, lng } of an asset's map location. */
export function assetPoint(asset) {
    const [lat, lng] = String(asset.at).split(',').map(Number);
    return { lat, lng };
}

export function serializePropertyOffer(row) {
    return { cid: row.cid, content: row.content, createdAt: iso(row.created_at), onchain: row.onchain ?? null, status: row.status };
}

export async function loadPropertyOffer(db, cid) {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM ${PROPERTY_OFFER_TABLE} WHERE cid = $1`, [cid]);
    return rows[0] ? serializePropertyOffer(rows[0]) : null;
}

export function validatePropertyOfferContent(content, { now = Date.now() } = {}) {
    const problem = PropertyOfferRecord.validate(content, { now });
    if (problem) return { ok: false, status: 400, ...problem };
    if (Date.parse(content.expiresAt) <= now) return { ok: false, status: 422, code: 'expired-offer', message: 'Offer expiry must be in the future.' };
    return { ok: true };
}

/**
 * GET /property-offers query → SQL conditions and parameters (throws a 400 on a malformed filter).
 * Without `status` the list is the live market: open or committed offers not past their expiry.
 */
export function offerListQuery(query) {
    const where = [], params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
    const one = name => { const value = query[name]; if (value !== undefined && typeof value !== 'string') throw badRequest(`${name} must be given once.`); return value; };
    const city = one('city');
    if (city !== undefined) { if (!normalizeCityCode(city)) throw badRequest('city is invalid.'); add('city = ?', normalizeCityCode(city)); }
    const kind = one('kind');
    if (kind !== undefined) { if (!['parcel', 'flat'].includes(kind)) throw badRequest('kind is parcel or flat.'); add('asset_kind = ?', kind); }
    const direction = one('direction');
    if (direction !== undefined) { if (!['buy', 'sell'].includes(direction)) throw badRequest('direction is buy or sell.'); add('direction = ?', direction); }
    const currency = one('currency');
    if (currency !== undefined) { if (!['SOL', 'USDC'].includes(currency)) throw badRequest('currency is SOL or USDC.'); add('currency = ?', currency); }
    const asset = one('asset');
    if (asset !== undefined) { if (!/^[0-9a-f]{64}$/.test(asset)) throw badRequest('asset is an asset hash (64 hex characters).'); add('asset_hash = ?', asset); }
    const maker = one('maker');
    if (maker !== undefined) { if (!isKey(maker)) throw badRequest('maker is a Solana public key.'); add('proposer = ?', maker); }
    const member = one('member');
    if (member !== undefined) { if (!isKey(member)) throw badRequest('member is a Solana public key.'); add('? = ANY(lens_members)', member); }
    const bbox = one('bbox');
    if (bbox !== undefined) {
        const box = bbox.split(',').map(part => (/^-?\d+(?:\.\d+)?$/.test(part.trim()) ? Number(part) : NaN));
        const [west, south, east, north] = box;
        if (box.length !== 4 || box.some(n => !Number.isFinite(n)) || west > east || south > north || Math.abs(south) > 90 || Math.abs(north) > 90 || Math.abs(west) > 180 || Math.abs(east) > 180) {
            throw badRequest('bbox is west,south,east,north in degrees.');
        }
        add('lng >= ?', west); add('lat >= ?', south); add('lng <= ?', east); add('lat <= ?', north);
    }
    const status = one('status');
    if (status === undefined) {
        where.push(`status IN ('open', 'committed')`, 'expires_at > now()');
    } else {
        const statuses = status.split(',').map(s => s.trim());
        if (!statuses.length || statuses.some(s => !OFFER_STATUSES.includes(s))) throw badRequest(`status is a comma list of ${OFFER_STATUSES.join(', ')}.`);
        add('status = ANY(?::text[])', [...new Set(statuses)]);
    }
    return { where, params };
}

export function setupPropertyOffersRoute(app, { pool, now = () => Date.now(), propertyOfferChain = createOfferChain } = {}) {
    const one = cid => loadPropertyOffer(pool, cid);
    const limiter = () => rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
    const unavailable = (res, what, error) => { console.error(`[${new Date().toISOString()}] [property-offers] ${what} failed:`, error); return res.status(503).json({ code: 'property-offer-unavailable', error: 'Property offers could not be read or saved. Please retry.' }); };
    const page = async (req, res, where, params) => {
        const limit = limitOf(req.query.limit), offset = offsetOf(req.query.offset);
        if (limit === null || offset === null) return res.status(400).json({ code: 'bad-request', error: 'limit or offset is invalid.' });
        const n = params.length;
        const { rows } = await pool.query(`SELECT ${COLUMNS} FROM ${PROPERTY_OFFER_TABLE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
            ORDER BY created_at DESC, cid LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit + 1, offset]);
        const hasMore = rows.length > limit, propertyOffers = rows.slice(0, limit).map(serializePropertyOffer);
        return res.json({ propertyOffers, hasMore, nextOffset: hasMore ? offset + propertyOffers.length : null });
    };

    app.post('/property-offers', limiter(), async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['cid', 'content'].includes(key)) || !isCid(body.cid) || !isPlainObject(body.content)) {
            return res.status(400).json({ code: 'bad-request', error: 'Body must be { cid, content } with a valid CID and property-offer/v2 content.' });
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
            const { lat, lng } = assetPoint(content.asset);
            await pool.query(`INSERT INTO ${PROPERTY_OFFER_TABLE}
                (cid, city, title, direction, proposer, currency, price, asset_kind, asset_hash, asset_key, lat, lng, expires_at, content, status, lens_members)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'unminted',$15) ON CONFLICT (cid) DO NOTHING`, [body.cid, normalizeCityCode(content.city),
                content.title || null, content.direction, content.proposer, content.currency, content.price, content.asset.kind,
                PropertyOfferRecord.assetHash(content.asset), PropertyOfferRecord.assetKey(content.asset), lat, lng, content.expiresAt,
                JSON.stringify(content), content.lens.members]);
            return res.status(201).json(await one(body.cid));
        } catch (error) { return unavailable(res, 'POST', error); }
    });

    app.get('/property-offers', async (req, res) => {
        let filters;
        try { filters = offerListQuery(req.query); } catch (error) { return res.status(400).json({ code: 'bad-request', error: error.message }); }
        try { return await page(req, res, filters.where, filters.params); } catch (error) { return unavailable(res, 'list', error); }
    });

    // The "Lens requests" screen: committed offers waiting for this lens member's confirmation, as
    // last mirrored from chain (a member in either lens that has not confirmed yet).
    app.get('/property-offers/awaiting', async (req, res) => {
        const member = req.query.member;
        if (!isKey(member)) return res.status(400).json({ code: 'bad-request', error: 'member must be a Solana public key.' });
        const waiting = side => `(onchain->'${side}'->'members' ? $1 AND NOT (onchain->'${side}'->'confirmed' ? $1))`;
        try {
            return await page(req, res, [`status = 'committed'`, 'expires_at > now()', '$1 = ANY(lens_members)', `(${waiting('buyerLens')} OR ${waiting('sellerLens')})`], [member]);
        } catch (error) { return unavailable(res, 'awaiting', error); }
    });

    app.post('/property-offers/:cid/onchain', limiter(), async (req, res) => {
        const body = req.body;
        // Anything else a client sends about the account (status, signature, …) is ignored: the server reads it.
        if (!isCid(req.params.cid) || !isPlainObject(body) || body.chain !== 'solana' || typeof body.cluster !== 'string' || typeof body.account !== 'string') {
            return res.status(400).json({ code: 'bad-request', error: 'Body must be { chain: "solana", cluster, account }.' });
        }
        try {
            const row = await one(req.params.cid);
            if (!row) return res.status(404).json({ code: 'not-found', error: 'Property offer was not found.' });
            if (row.onchain && row.onchain.cluster !== body.cluster) return res.status(409).json({ code: 'other-network', error: 'The offer is already indexed on another network.' });
            if (body.account !== client.getOfferPda(row.cid, row.content.proposer)[0].toBase58()) return res.status(422).json({ code: 'wrong-account', error: 'Account differs from the expected offer address.' });
            const account = await propertyOfferChain(body.cluster).read(row);
            const { onchain, status, lensMembers } = mirrorOfferAccount(row, account, body.cluster);
            await pool.query(`UPDATE ${PROPERTY_OFFER_TABLE} SET onchain=$2::jsonb, status=$3, lens_members=$4, updated_at=now() WHERE cid=$1`,
                [row.cid, JSON.stringify(onchain), status, lensMembers]);
            return res.json({ ...row, onchain, status });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ code: error.code || 'offer-chain-mismatch', error: error.message });
            console.error(`[${new Date().toISOString()}] [property-offers] chain read failed:`, error);
            return res.status(503).json({ code: 'chain-unavailable', error: 'The Solana account could not be read. Please retry.' });
        }
    });

    app.get('/property-offers/:cid', async (req, res) => {
        if (!isCid(req.params.cid)) return res.status(400).json({ code: 'invalid-cid', error: 'Invalid property offer CID.' });
        try { const row = await one(req.params.cid); return row ? res.json(row) : res.status(404).json({ code: 'not-found', error: 'Property offer was not found.' }); }
        catch (error) { return unavailable(res, 'get', error); }
    });
}
