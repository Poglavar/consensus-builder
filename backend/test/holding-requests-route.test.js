// Holding requests: the server builds the exact property-holding-request/v1 text the browser signs,
// stores a request only with the claimant's valid ed25519 signature over it, answers a repeat with the
// stored row, and lists requests by lens member, asset, claimant and city as SQL parameters.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import { Keypair } from '@solana/web3.js';
import { setupHoldingRequestsRoute } from '../routes/holding-requests.js';
import { signMessageBytes } from '../agents/lens-ownership-client.js';
import { migrate, discover } from '../scripts/migrate-property-offers-v2.mjs';

const require = createRequire(import.meta.url);
const HoldingRequest = require('../../frontend/js/holding-request.js');
const Offer = require('../../frontend/js/property-offer-record.js');
const LensCore = require('../../frontend/js/lens-core.js');
const [claimantKp, otherKp] = [81, 82].map(n => Keypair.fromSeed(new Uint8Array(32).fill(n)));
const [memberA, memberB] = [83, 84].map(n => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58());
const claimant = claimantKp.publicKey.toBase58();
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const FLAT = { kind: 'flat', xrayBuilding: 'zagreb::gdi-3d::148972', unit: '6::4', at: '45.7665,15.9722,19' };
const raw = (patch = {}) => ({ city: 'zagreb', asset: FLAT, claimant, lensMembers: [memberB, memberA], note: 'Bought in 2004', createdAt: '2026-11-27T11:59:00.000Z', ...patch });
const sign = (keypair, message) => LensCore.base58Encode(new Uint8Array(signMessageBytes({ secretKey: keypair.secretKey, message })));

function fakePool() {
    const rows = [], calls = [];
    return { rows, calls, query: vi.fn(async (sql, params = []) => {
        calls.push({ sql, params });
        if (/INSERT INTO consensus\.holding_request/.test(sql)) {
            const [city, asset, assetHash, assetKey, who, lensMembers, note, message, signature, requestedAt, lat, lng] = params;
            if (rows.some(r => r.asset_hash === assetHash && r.claimant === who && r.message === message)) return { rows: [] };
            const row = { id: `id-${rows.length}`, city, asset: JSON.parse(asset), asset_hash: assetHash, asset_key: assetKey, claimant: who, lens_members: lensMembers, note, message, signature,
                requested_at: new Date(requestedAt), lat, lng, created_at: new Date(NOW) };
            rows.push(row);
            return { rows: [row] };
        }
        if (/WHERE asset_hash = \$1 AND claimant = \$2 AND message = \$3/.test(sql)) return { rows: rows.filter(r => r.asset_hash === params[0] && r.claimant === params[1] && r.message === params[2]) };
        return { rows };
    }) };
}
function app(pool = fakePool()) {
    const server = express(); server.use(express.json());
    setupHoldingRequestsRoute(server, { pool, now: () => NOW });
    return { server, pool };
}

describe('the holding request message', () => {
    it('is the canonical array with sorted lens members, the asset key and an empty note when none', () => {
        expect(HoldingRequest.message(raw())).toBe(JSON.stringify(['property-holding-request/v1', Offer.assetKey(FLAT), claimant, [memberA, memberB].sort(), '2026-11-27T11:59:00.000Z', 'Bought in 2004']));
        expect(JSON.parse(HoldingRequest.message(raw({ note: undefined }))).at(-1)).toBe('');
        expect(HoldingRequest.message(raw({ lensMembers: [memberA, memberB] }))).toBe(HoldingRequest.message(raw()));
    });
    it('refuses unknown fields, a missing lens, duplicate members, a bad asset or a non-ISO time', () => {
        for (const patch of [{ extra: 1 }, { lensMembers: [] }, { lensMembers: [memberA, memberA] }, { asset: { kind: 'house', at: FLAT.at } }, { createdAt: '2026-11-27' }, { claimant: 'x' }])
            expect(() => HoldingRequest.normalize(raw(patch))).toThrow();
    });
});

describe('POST /holding-requests', () => {
    it('stores a request signed by its claimant, with the asset hash, location and the signed text; a repeat returns it', async () => {
        const { server, pool } = app();
        const message = HoldingRequest.message(raw());
        const body = { request: raw(), signature: sign(claimantKp, message) };
        const created = await request(server).post('/holding-requests').send(body);
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ request: { city: 'zagreb', asset: FLAT, claimant, lensMembers: [memberA, memberB].sort(), note: 'Bought in 2004', createdAt: raw().createdAt }, message });
        expect(pool.rows[0]).toMatchObject({ asset_hash: Offer.assetHash(FLAT), asset_key: Offer.assetKey(FLAT), lat: 45.7665, lng: 15.9722, message });
        const again = await request(server).post('/holding-requests').send(body);
        expect(again.status).toBe(200);
        expect(pool.rows).toHaveLength(1);
    });
    it('refuses another wallet’s signature, a signature over other text, and a request dated in the future', async () => {
        const { server, pool } = app();
        const message = HoldingRequest.message(raw());
        expect((await request(server).post('/holding-requests').send({ request: raw(), signature: sign(otherKp, message) })).status).toBe(401);
        expect((await request(server).post('/holding-requests').send({ request: raw({ note: 'other' }), signature: sign(claimantKp, message) })).status).toBe(401);
        expect((await request(server).post('/holding-requests').send({ request: raw(), signature: 'not-base58!' })).status).toBe(401);
        const future = raw({ createdAt: '2026-11-28T00:00:00.000Z' });
        expect((await request(server).post('/holding-requests').send({ request: future, signature: sign(claimantKp, HoldingRequest.message(future)) })).status).toBe(422);
        expect((await request(server).post('/holding-requests').send({ request: raw() })).status).toBe(400);
        expect(pool.rows).toHaveLength(0);
    });
});

describe('GET /holding-requests', () => {
    it('filters by member, claimant, asset and city as parameters, newest first', async () => {
        const { server, pool } = app();
        const hash = Offer.assetHash(FLAT);
        expect((await request(server).get(`/holding-requests?member=${memberA}&claimant=${claimant}&asset=${hash}&city=Zagreb&limit=10`)).status).toBe(200);
        const { sql, params } = pool.calls.at(-1);
        expect(sql).toContain('WHERE $1 = ANY(lens_members) AND claimant = $2 AND asset_hash = $3 AND city = $4');
        expect(sql).toMatch(/ORDER BY created_at DESC, id LIMIT \$5 OFFSET \$6/);
        expect(params).toEqual([memberA, claimant, hash, 'zagreb', 11, 0]);
        expect((await request(server).get('/holding-requests?member=nope')).status).toBe(400);
    });
});

describe('migrate-property-offers-v2', () => {
    // A scripted client: answers the discovery queries, records the rest.
    function client({ present, v2 = false, dependents = [] }) {
        const sent = [];
        return { sent, query: vi.fn(async (sql, params) => {
            sent.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
            if (sql.includes('to_regclass')) return { rows: present.map((name, i) => ({ name, oid: 100 + i })) };
            if (sql.includes("attname = 'asset_hash'")) return { rows: v2 ? [{}] : [] };
            if (sql.startsWith('SELECT count(*)')) return { rows: [{ n: 3 }] };
            if (sql.includes('pg_rewrite')) return { rows: dependents };
            return { rows: [] };
        }) };
    }
    const OLD = ['consensus.property_offer_transfer', 'consensus.property_offer_acceptance', 'consensus.property_offer'];
    it('drops the v1 tables children first, without CASCADE, and applies the DDL in one transaction', async () => {
        const c = client({ present: OLD });
        expect(await migrate(c, { ddl: 'CREATE TABLE x ();' })).toBe('migrated');
        expect(c.sent.filter(s => /^(BEGIN|COMMIT|DROP|CREATE)/.test(s))).toEqual(['BEGIN', 'DROP TABLE consensus.property_offer_transfer', 'DROP TABLE consensus.property_offer_acceptance', 'DROP TABLE consensus.property_offer', 'CREATE TABLE x', 'COMMIT']);
    });
    it('leaves a v2 table alone and refuses when something else depends on the old tables', async () => {
        const v2 = client({ present: ['consensus.property_offer'], v2: true });
        expect(await migrate(v2, { ddl: 'CREATE TABLE x ();' })).toBe('already-v2');
        expect(v2.sent.some(s => s.startsWith('DROP'))).toBe(false);
        const blocked = client({ present: OLD, dependents: [{ kind: 'view or rule', object: 'public.offer_view' }] });
        expect((await discover(blocked)).dependents).toHaveLength(1);
        await expect(migrate(blocked, { ddl: '' })).rejects.toThrow(/refused/);
        expect(blocked.sent.some(s => s.startsWith('DROP'))).toBe(false);
        expect(blocked.sent.at(-1)).toBe('ROLLBACK');
    });
});
