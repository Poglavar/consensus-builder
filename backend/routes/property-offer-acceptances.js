// Shared acceptance HTTP endpoints verify each participant signature before storing terms or consent.
import rateLimit from 'express-rate-limit';
import { isCid } from '../cid.js';
import { prepareAcceptance, verifyConsent, verifySessionAuthor, serializeAcceptance, createAcceptanceStore } from '../property-offers/acceptance.js';
export function setupPropertyOfferAcceptances(app, { pool, load, now = Date.now, store = createAcceptanceStore(pool) }) {
    const limit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
    const wrap = fn => async (req,res) => { try { await fn(req,res); } catch (error) { res.status(error.status || 422).json({ error: error.message }); } };
    const offer = async (req, active = true) => {
        if (!isCid(req.params.cid)) throw new Error('Invalid offer CID.');
        const row = await load(req.params.cid);
        if (!row) throw Object.assign(new Error('Offer not found.'), { status:404 });
        if (active && Date.parse(row.content.expiresAt) <= now()) throw new Error('This offer has expired.');
        return row;
    };
    const read = async req => {
        if (!/^[a-f0-9]{64}$/.test(req.params.id || '')) throw new Error('Invalid acceptance ID.');
        const row = await store.get(req.params.cid,req.params.id);
        if (!row) throw Object.assign(new Error('Acceptance not found.'), {status:404});
        return row;
    };
    app.post('/property-offers/:cid/acceptances', limit, wrap(async(req,res) => {
        const row = await offer(req);
        const {id,candidate} = prepareAcceptance(row,req.body?.candidate);
        verifySessionAuthor(id,candidate,req.body);
        res.status(201).json(serializeAcceptance(await store.create(row.cid,id,candidate)));
    }));
    app.get('/property-offers/:cid/acceptances/:id', wrap(async(req,res) => {
        await offer(req,false); res.json(serializeAcceptance(await read(req)));
    }));
    app.post('/property-offers/:cid/acceptances/:id/consents', limit, wrap(async(req,res) => {
        await offer(req); const row = await read(req);
        const consent = verifyConsent(row.candidate, req.body);
        res.json(serializeAcceptance(await store.addConsent(req.params.cid,req.params.id,consent)));
    }));
}
