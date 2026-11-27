// Holding requests (property-holding-request/v1): a person asks lens members to state that it holds a
// plot or a flat, with a wallet signature over the exact text frontend/js/holding-request.js builds.
// The server verifies that signature and lists the requests; whether a lens member answered is read
// from chain by clients (its PropertyHolding-v1 statement for the asset), never stored here.
import { createRequire } from 'node:module';
import rateLimit from 'express-rate-limit';
import { isPlainObject } from '../utils/request-validation.js';
import { normalizeCityCode } from '../utils/city-code.js';
import { verifyWalletSignature } from '../lens/identity/devnet-registry.js';
import { assetPoint, limitOf, offsetOf } from './property-offers.js';

const require = createRequire(import.meta.url);
const HoldingRequest = require('../../frontend/js/holding-request.js');
const PropertyOfferRecord = require('../../frontend/js/property-offer-record.js');
const LensCore = require('../../frontend/js/lens-core.js');
export const HOLDING_REQUEST_TABLE = 'consensus.holding_request';
const COLUMNS = 'id, city, asset, claimant, lens_members, note, requested_at, message, signature, created_at';
// A request dated later than this is refused: the claimant's clock, not ours, dates it.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const iso = value => value instanceof Date ? value.toISOString() : value ?? null;
const isKey = value => typeof value === 'string' && LensCore.isBase58Pubkey(value) && value.trim() === value;

export function serializeHoldingRequest(row) {
    return { id: row.id, request: { city: row.city, asset: row.asset, claimant: row.claimant, lensMembers: row.lens_members, ...(row.note ? { note: row.note } : {}), createdAt: iso(row.requested_at) },
        message: row.message, signature: row.signature, receivedAt: iso(row.created_at) };
}

export function setupHoldingRequestsRoute(app, { pool, now = () => Date.now() } = {}) {
    const limiter = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
    const unavailable = (res, what, error) => { console.error(`[${new Date().toISOString()}] [holding-requests] ${what} failed:`, error); return res.status(503).json({ code: 'holding-request-unavailable', error: 'Holding requests could not be read or saved. Please retry.' }); };

    app.post('/holding-requests', limiter, async (req, res) => {
        const body = req.body;
        if (!isPlainObject(body) || Object.keys(body).some(key => !['request', 'signature'].includes(key)) || typeof body.signature !== 'string' || body.signature.length > 128) {
            return res.status(400).json({ code: 'bad-request', error: 'Body must be { request, signature }.' });
        }
        let request, message;
        try { request = HoldingRequest.normalize(body.request); message = HoldingRequest.message(request); }
        catch (error) { return res.status(400).json({ code: 'invalid-holding-request', error: error.message }); }
        if (Date.parse(request.createdAt) > now() + FUTURE_TOLERANCE_MS) return res.status(422).json({ code: 'future-request', error: 'The request is dated in the future.' });
        let verified = false;
        try { verified = verifyWalletSignature({ owner: request.claimant, message, signature: body.signature }); } catch { verified = false; }
        if (!verified) return res.status(401).json({ code: 'invalid-signature', error: 'The claimant must sign this exact request.', message });
        const assetHash = PropertyOfferRecord.assetHash(request.asset);
        const { lat, lng } = assetPoint(request.asset);
        try {
            const inserted = await pool.query(`INSERT INTO ${HOLDING_REQUEST_TABLE}
                (city, asset, asset_hash, asset_key, claimant, lens_members, note, message, signature, requested_at, lat, lng)
                VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (asset_hash, claimant, message) DO NOTHING RETURNING ${COLUMNS}`,
            [normalizeCityCode(request.city), JSON.stringify(request.asset), assetHash, PropertyOfferRecord.assetKey(request.asset), request.claimant,
                request.lensMembers, request.note || null, message, body.signature, request.createdAt, lat, lng]);
            if (inserted.rows[0]) return res.status(201).json(serializeHoldingRequest(inserted.rows[0]));
            const { rows } = await pool.query(`SELECT ${COLUMNS} FROM ${HOLDING_REQUEST_TABLE} WHERE asset_hash = $1 AND claimant = $2 AND message = $3`, [assetHash, request.claimant, message]);
            return res.status(200).json(serializeHoldingRequest(rows[0]));
        } catch (error) { return unavailable(res, 'POST', error); }
    });

    app.get('/holding-requests', async (req, res) => {
        const where = [], params = [];
        const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
        const { member, asset, claimant, city } = req.query;
        const limit = limitOf(req.query.limit), offset = offsetOf(req.query.offset);
        if ((member !== undefined && !isKey(member)) || (claimant !== undefined && !isKey(claimant)) || (asset !== undefined && !/^[0-9a-f]{64}$/.test(String(asset)))
            || (city !== undefined && (typeof city !== 'string' || !normalizeCityCode(city))) || limit === null || offset === null) {
            return res.status(400).json({ code: 'bad-request', error: 'member, claimant (Solana keys), asset (asset hash), city, limit or offset is invalid.' });
        }
        if (member !== undefined) add('? = ANY(lens_members)', member);
        if (claimant !== undefined) add('claimant = ?', claimant);
        if (asset !== undefined) add('asset_hash = ?', asset);
        if (city !== undefined) add('city = ?', normalizeCityCode(city));
        try {
            const n = params.length;
            const { rows } = await pool.query(`SELECT ${COLUMNS} FROM ${HOLDING_REQUEST_TABLE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                ORDER BY created_at DESC, id LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit + 1, offset]);
            const hasMore = rows.length > limit, holdingRequests = rows.slice(0, limit).map(serializeHoldingRequest);
            return res.json({ holdingRequests, hasMore, nextOffset: hasMore ? offset + holdingRequests.length : null });
        } catch (error) { return unavailable(res, 'list', error); }
    });
}
