import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';
import { loadChainMirror, metadataReadUrl, readChainMetadata, verifyCadastreSnapshot, chainAgentStamp } from '../proposals/chain-mirror.js';
import { serializeProposalRow } from '../proposals/serializer.js';
import { setupProposalsRoute } from '../routes/proposals.js';
import { createMockPool } from './helpers/mock-pool.js';
import { insertResult, updateResult } from './helpers/fixtures.js';

const require = createRequire(import.meta.url);
const express = require('express');
const turf = require('@turf/turf');
globalThis.turf = turf;
const chainRecord = require('../../frontend/js/proposals/chain-record.js');
const siteHash = require('../../frontend/js/proposals/site-hash.js');
const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const SITE = box(15.970, 45.800, 15.972, 45.801);
const CID = `Qm${'a'.repeat(44)}`;

async function recordFor(overrides = {}) {
    const geometryHash = await siteHash.siteHashHex(SITE);
    const siteBinding = { coverage: 'complete', parcels: [{ parcelId: 'HR-1', overlapM2: 100 }], toleranceM: 0 };
    return chainRecord.authoredRecord({
        proposalId: 'minted-corridor', city: 'zagreb', type: 'road', goal: 'road-track', title: 'Minted corridor',
        description: 'An authored corridor', author: 'Guest 42', site: SITE, binding: siteBinding,
        cadastreParcelIds: ['HR-1'], lens: [], isConditional: false,
        cadastreSnapshot: { protocol: 'cadastre-snapshot/1', source: 'zagreb-cadastre', regionHasCadastre: true,
            parcels: [{ id: 'HR-1', sourceId: 'zagreb-cadastre', sourceVersion: null, sourceGeometryHash: null, geometryHash, geometry: SITE }] },
        roadProposal: { definition: { width: 12, polygon: SITE, points: [{ lat: 45.8001, lng: 15.9701 }, { lat: 45.8009, lng: 15.9719 }],
            segments: [[{ lat: 45.8001, lng: 15.9701 }, { lat: 45.8009, lng: 15.9719 }]], metadata: { ownershipAndAcquisitionStats: { source: 'minted' } } } },
        ...overrides
    });
}

async function verifiedMirror(record, chainOverrides = {}) {
    record ||= await recordFor();
    const metadataUri = `ipfs://${CID}`;
    const chain = { ref: { chainType: 'evm', chainId: '84532', contract: '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F', tokenId: '5' },
        metadataUri, cadastreParcelIds: record.cadastreParcelIds, lens: record.lens, isConditional: record.isConditional, ...chainOverrides };
    return loadChainMirror(chain.ref, { readChain: async () => chain,
        readMetadata: async () => ({ properties: chainRecord.metadataProperties(record) }), now: () => new Date('2026-10-11T00:00:00Z') });
}

const validRef = { chainType: 'evm', chainId: '84532', contract: '0x9699AcBc70a32E5a7Ff30566dD496e080a4FAE2F', tokenId: '5' };
let pool;
let app;
let warn;
let savedSigningKey;

beforeEach(() => {
    pool = createMockPool();
    app = express();
    app.use(express.json());
    setupProposalsRoute(app, pool, { loadMirror: async () => {
        const record = await recordFor();
        return verifiedMirror(record);
    } });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    savedSigningKey = process.env.PREPARE_SIGNING_KEY;
    delete process.env.PREPARE_SIGNING_KEY;
});
afterEach(() => {
    warn.mockRestore();
    if (savedSigningKey === undefined) delete process.env.PREPARE_SIGNING_KEY;
    else process.env.PREPARE_SIGNING_KEY = savedSigningKey;
});
afterAll(() => { delete globalThis.turf; });

describe('chain mirror proof verification', () => {
    it('binds a known agent claim to the actual chain signer without inventing a payment receipt', () => {
        const personas = [{ name: 'test-agent', wallet: 'actual-owner' }];
        const record = { author: 'actual-owner', agent: { persona: 'test-agent', run_id: 'run-1', controller: 'algorithm', paid: { tx: 'fake' } } };
        const chain = { owner: 'actual-owner', ref: { chainType: 'solana', tokenId: 'account' } };
        expect(chainAgentStamp(record, chain, personas)).toMatchObject({ persona: 'test-agent', wallet: 'actual-owner',
            run_id: 'run-1', verified: { method: 'chain', chainRef: chain.ref } });
        expect(chainAgentStamp(record, chain, personas)).not.toHaveProperty('paid');
        expect(() => chainAgentStamp(record, { ...chain, owner: 'impostor' }, personas)).toThrow(/signer/);
        expect(chainAgentStamp({ ...record, agent: { persona: 'unregistered' } }, chain, personas)).toBeNull();
    });

    it('accepts a chain record whose consent parcels and cadastral snapshot agree', async () => {
        const record = await recordFor();
        await expect(verifyCadastreSnapshot(record)).resolves.toBeUndefined();
        const mirror = await verifiedMirror(record);
        expect(mirror.record.roadProposal.definition.polygon).toEqual(SITE);
        expect(mirror.evidence.ref).toEqual(validRef);
        expect(mirror.proposalId).toBe((await verifiedMirror(record)).proposalId);
    });

    it('serves committed authored values while keeping the server receipt and lifecycle separate', async () => {
        const record = await recordFor({ title: '  Exact minted title  ', author: '0x1234567890abcdef1234567890abcdef12345678',
            createdAt: '2026-09-01T12:00:00Z', offer: 0, depositEnabled: true, depositPercent: 15 });
        const mirror = await verifiedMirror(record);
        const restored = serializeProposalRow({
            id: 88, proposal_id: mirror.proposalId, title: 'Exact minted title', author: null,
            created_at: new Date('2026-10-11T12:00:00Z'), lifecycle_status: 'Active',
            cadastre_parcel_ids: record.cadastreParcelIds, onchain_data: mirror.onchain,
            proposal_data: { ...record, createdAt: '2026-10-11T12:00:00Z', chainMirror: mirror.evidence }
        });
        expect(restored).toMatchObject({ ...record, proposalId: mirror.proposalId });
        expect(restored.mirroredAt).toBe('2026-10-11T12:00:00.000Z');
        expect(restored.id).toBe(88);
        expect(restored.lifecycleStatus).toBe('Active');
        expect(restored.chainMirror.record).toEqual(record);
    });

    it.each([
        ['chain consent parcel list', { cadastreParcelIds: ['HR-2'] }],
        ['site hash', { siteHash: 'f'.repeat(64) }]
    ])('rejects a mismatch in %s', async (_label, chainOverrides) => {
        await expect(verifiedMirror(await recordFor(), chainOverrides)).rejects.toMatchObject({ status: 422 });
    });

    it('rejects a snapshot that omits consent or whose parcel hash was changed', async () => {
        const record = await recordFor({ cadastreSnapshot: { protocol: 'cadastre-snapshot/1', source: 'x', regionHasCadastre: true, parcels: [] } });
        await expect(verifyCadastreSnapshot(record)).rejects.toMatchObject({ status: 422 });
        const changed = await recordFor();
        changed.cadastreSnapshot.parcels[0].geometryHash = 'f'.repeat(64);
        await expect(verifyCadastreSnapshot(changed)).rejects.toMatchObject({ status: 422 });
    });
});

describe('chain metadata gateway reads', () => {
    it('constructs gateway URLs only from immutable content identifiers', () => {
        expect(metadataReadUrl(`ipfs://${CID}/proposal.json`, { IPFS_READ_GATEWAY: 'https://gateway.example/ipfs/' }))
            .toBe(`https://gateway.example/ipfs/${CID}/proposal.json`);
        // Unset, it reads from the pinning service's gateway, the one the API is deployed with.
        expect(metadataReadUrl(`ipfs://${CID}`, {})).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
        expect(metadataReadUrl(`walrus://${'a'.repeat(43)}`, { WALRUS_AGGREGATOR_URL: 'https://walrus.example/' }))
            .toBe(`https://walrus.example/v1/blobs/${'a'.repeat(43)}`);
        for (const uri of ['https://evil.example/x', `ipfs://${CID}/../secret`, `ipfs://${CID}?redirect=https://evil.example`]) {
            expect(() => metadataReadUrl(uri)).toThrow();
        }
    });

    it('uses redirect:error and rejects oversized metadata before or during streaming', async () => {
        const retryOptions = { wait: async () => {}, log: () => {} };
        const fetchImpl = vi.fn(async (_url, options) => {
            expect(options.redirect).toBe('error');
            return { ok: true, headers: { get: () => '1' }, body: (async function* () { yield Buffer.from('{"ok":true}'); })() };
        });
        await expect(readChainMetadata(`ipfs://${CID}`, { fetchImpl, retryOptions })).resolves.toEqual({ ok: true });
        const redirect = vi.fn(async () => { throw new Error('redirect rejected'); });
        await expect(readChainMetadata(`ipfs://${CID}`, { fetchImpl: redirect, retryOptions })).rejects.toMatchObject({ status: 503 });
        const oversized = vi.fn(async () => ({ ok: true, headers: { get: () => String(2 * 1024 * 1024) }, body: { cancel: vi.fn() } }));
        await expect(readChainMetadata(`ipfs://${CID}`, { fetchImpl: oversized, retryOptions })).rejects.toMatchObject({ status: 422 });
    });
});

describe('POST /proposals/mirror', () => {
    it('reserves chain IDs for verified mirrors, so ordinary uploads cannot squat on them', async () => {
        const record = await recordFor();
        const mirror = await verifiedMirror(record);
        const response = await request(app).post('/proposals').send({ ...record, proposalId: mirror.proposalId });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('chain-mirror-required');
        expect(pool.getCalls()).toHaveLength(0);
    });

    it.each([true, false])('treats an existing row as a mirror only with matching chain evidence (%s)', async matches => {
        const mirror = await verifiedMirror();
        const violation = Object.assign(new Error('duplicate'), { code: '23505' });
        pool.setResults([{ rows: [{ id: 99, proposal_id: mirror.proposalId,
            // JSONB does not preserve object key order.
            chain_ref: matches ? { tokenId: validRef.tokenId, contract: validRef.contract,
                chainId: validRef.chainId, chainType: validRef.chainType } : null }] }]);
        vi.spyOn(pool, 'query').mockRejectedValueOnce(violation);
        const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await request(app).post('/proposals/mirror').send({ chainRef: validRef });
            expect(response.status).toBe(409);
            if (matches) expect(response.body).toMatchObject({ id: 99, proposalId: mirror.proposalId });
            else {
                expect(response.body.code).toBe('chain-mirror-conflict');
                expect(response.body).not.toHaveProperty('id');
            }
        } finally { errorLog.mockRestore(); }
    });

    it('requires only a chain location and stores the verified authored corridor without server preparation', async () => {
        pool.setResults([insertResult({ proposal_id: 'chain_mirrored' }), updateResult()]);
        const arbitrary = await request(app).post('/proposals/mirror').send({ ...validRef, site: box(0, 0, 1, 1) });
        expect(arbitrary.status).toBe(400);
        expect(pool.getCalls()).toHaveLength(0);

        const response = await request(app).post('/proposals/mirror').send({ chainRef: validRef });
        expect(response.status).toBe(201);
        expect(response.body.editToken).toBeNull();
        const insert = pool.getCalls().find(call => call.sql.includes('INSERT INTO proposal'));
        const stored = JSON.parse(insert.params[32]);
        expect(stored.roadProposal.definition.polygon).toEqual(SITE);
        expect(stored.roadProposal.definition.metadata.ownershipAndAcquisitionStats).toEqual({ source: 'minted' });
        expect(stored.chainMirror.ref).toEqual(validRef);
        expect(insert.params[24]).toBe(JSON.stringify(stored.roadProposal)); // dedicated road_proposal column
        expect(insert.params[38]).toBeNull(); // no server edit-token hash for a public mirror
        expect(insert.sql).not.toContain('prepared AS');
        expect(pool.getBindingCalls()).toHaveLength(0);
    });

    it('does not write when chain proof verification fails', async () => {
        const failing = express();
        failing.use(express.json());
        setupProposalsRoute(failing, pool, { loadMirror: async () => { throw Object.assign(new Error('bad proof'), { status: 422, code: 'chain-proof-invalid' }); } });
        const response = await request(failing).post('/proposals/mirror').send({ chainRef: validRef });
        expect(response.status).toBe(422);
        expect(pool.getCalls()).toHaveLength(0);
    });
});
