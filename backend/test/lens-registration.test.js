// Lens member self-registration: the signed message, every refusal (signature, time, chain
// accounts, the member's own status), the directory route, the JSON file store, and one end-to-end
// run where a live-shaped member announces itself and the directory really probes it over HTTP.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { deriveLensSchemaPdas, SAS_PROGRAM_ID } from '../oracle/lens-schemas.js';
import {
    announceLensMember,
    evmAddressStatement,
    registrationMessage,
    signRegistration,
    verifyRegistration
} from '../oracle/lens-registration.js';
import { setupLensesRoute } from '../routes/lenses.js';
import { createLensMember } from '../lens/member.js';
import { createFakeIssuer } from '../lens/issuers.js';
import { createFakeEvmIssuer } from '../lens/evm-issuer.js';
import { createDevnetRegistryIdentity } from '../lens/identity/devnet-registry.js';
import { createFileStore, createMemoryStore } from '../lens/store.js';
import { createLensPricing } from '../lens/pricing.js';
import { createLensMemberApp } from '../lens/server.js';

const NOW = 1790000000; // 2026-09-21
const member = Keypair.fromSeed(new Uint8Array(32).fill(7));
const KEY = member.publicKey.toBase58();
// The member's EVM key (a fixed test key, never a real one).
const evmWallet = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const CREDENTIAL_NAME = 'NotaryBorovje';
const { credential, schemas } = deriveLensSchemaPdas({ authority: KEY, credentialName: CREDENTIAL_NAME });

function vec(bytes) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, Buffer.from(bytes)]);
}

// SAS account bytes as the program lays them out (credential: 0|authority|name|signers;
// schema: 1|credential|name|description|layout|fieldNames|paused|version).
function credentialBytes(authority) {
    return Buffer.concat([Buffer.from([0]), new PublicKey(authority).toBuffer(), vec(Buffer.from(CREDENTIAL_NAME)), vec([])]);
}
function schemaBytes(credentialAddress) {
    return Buffer.concat([Buffer.from([1]), new PublicKey(credentialAddress).toBuffer(), vec(Buffer.from('S')), vec([]), vec([12]), vec([]), Buffer.from([0, 1])]);
}

function chain(overrides = {}) {
    const accounts = {
        [credential]: { owner: SAS_PROGRAM_ID, data: credentialBytes(KEY) },
        [schemas.ownership]: { owner: SAS_PROGRAM_ID, data: schemaBytes(credential) },
        [schemas.decision]: { owner: SAS_PROGRAM_ID, data: schemaBytes(credential) },
        ...overrides
    };
    return vi.fn(async addresses => addresses.map(address => accounts[address] ?? null));
}

const liveStatus = (extra = {}) => ({ key: KEY, kind: 'owner-consent', credential, credentialName: CREDENTIAL_NAME, dryRun: false, ephemeralKey: false, ...extra });

function signed(extra = {}, options = {}) {
    return signRegistration({
        credentialName: CREDENTIAL_NAME,
        kind: 'owner-consent',
        name: 'Notary office, Borovje',
        description: 'Attests registered owners from the land registry',
        serviceUrl: 'https://notary.example.test/',
        signedAt: NOW,
        ...extra
    }, member, options);
}

const verify = (body, options = {}) => verifyRegistration(body, {
    nowSeconds: NOW,
    readAccounts: chain(),
    fetchStatus: async () => liveStatus(),
    ...options
});

describe('registration message and verification', () => {
    it('signs one canonical text and verifies it against chain and status', async () => {
        const body = await signed();
        expect(registrationMessage(body).split('\n')).toEqual([
            'Urban Game Theory lens member registration v2',
            `key: ${KEY}`,
            `credentialName: ${CREDENTIAL_NAME}`,
            'kind: owner-consent',
            'name: Notary office, Borovje',
            'description: Attests registered owners from the land registry',
            'serviceUrl: https://notary.example.test',
            'evmAddress: ',
            `signedAt: ${NOW}`
        ]);
        const fetchStatus = vi.fn(async () => liveStatus());
        const readAccounts = chain();
        await expect(verify(body, { fetchStatus, readAccounts })).resolves.toMatchObject({ key: KEY, credential, serviceUrl: 'https://notary.example.test' });
        expect(fetchStatus).toHaveBeenCalledWith('https://notary.example.test');
        expect(readAccounts).toHaveBeenCalledWith([credential, schemas.ownership]);
    });

    it('refuses a tampered field, another key, and a stale or future time', async () => {
        await expect(verify({ ...(await signed()), name: 'Someone else' })).rejects.toMatchObject({ status: 401, code: 'bad_signature' });
        const other = Keypair.generate();
        await expect(verify({ ...(await signed()), key: other.publicKey.toBase58() })).rejects.toMatchObject({ code: 'bad_signature' });
        await expect(verify(await signed({ signedAt: NOW - 601 }))).rejects.toMatchObject({ code: 'stale_registration' });
        await expect(verify(await signed({ signedAt: NOW + 601 }))).rejects.toMatchObject({ code: 'stale_registration' });
    });

    it('refuses bad fields before touching the chain', async () => {
        const readAccounts = chain();
        await expect(verify({ ...(await signed()), serviceUrl: 'http://notary.example.test' }, { readAccounts })).rejects.toMatchObject({ code: 'bad_request', message: /https/ });
        await expect(verify({ ...(await signed()), kind: 'oracle' }, { readAccounts })).rejects.toMatchObject({ message: /kind must be one of/ });
        await expect(verify({ ...(await signed()), name: 'a\nb' }, { readAccounts })).rejects.toMatchObject({ message: /one line/ });
        expect(readAccounts).not.toHaveBeenCalled();
    });

    it('needs the credential under this key and the schema its kind issues', async () => {
        await expect(verify(await signed(), { readAccounts: chain({ [credential]: null }) })).rejects.toMatchObject({ status: 422, code: 'credential_missing' });
        await expect(verify(await signed(), { readAccounts: chain({ [credential]: { owner: SAS_PROGRAM_ID, data: credentialBytes(Keypair.generate().publicKey) } }) }))
            .rejects.toMatchObject({ code: 'credential_missing' });
        await expect(verify(await signed(), { readAccounts: chain({ [credential]: { owner: KEY, data: credentialBytes(KEY) } }) }))
            .rejects.toMatchObject({ code: 'credential_missing' });
        await expect(verify(await signed(), { readAccounts: chain({ [schemas.ownership]: null }) })).rejects.toMatchObject({ code: 'schema_missing', message: /ownership/ });
        // A court or lifecycle member attests agreement decisions, so it needs the AgreementDecision schema
        // and not the ownership one.
        for (const kind of ['court', 'lifecycle']) {
            const other = await signed({ kind });
            const readAccounts = chain({ [schemas.ownership]: null });
            await expect(verify(other, { readAccounts, fetchStatus: async () => liveStatus({ kind }) })).resolves.toMatchObject({ kind });
            expect(readAccounts).toHaveBeenCalledWith([credential, schemas.decision]);
            await expect(verify(other, { readAccounts: chain({ [schemas.decision]: null }), fetchStatus: async () => liveStatus({ kind }) }))
                .rejects.toMatchObject({ code: 'schema_missing', message: /decision/ });
        }
    });

    it('needs the service to answer as this live member', async () => {
        await expect(verify(await signed(), { fetchStatus: async () => { throw new Error('ECONNREFUSED'); } })).rejects.toMatchObject({ code: 'service_unreachable' });
        await expect(verify(await signed(), { fetchStatus: async () => liveStatus({ key: Keypair.generate().publicKey.toBase58() }) })).rejects.toMatchObject({ code: 'service_mismatch', message: /key/ });
        await expect(verify(await signed(), { fetchStatus: async () => liveStatus({ kind: 'court' }) })).rejects.toMatchObject({ code: 'service_mismatch', message: /kind/ });
        await expect(verify(await signed(), { fetchStatus: async () => liveStatus({ dryRun: true }) })).rejects.toMatchObject({ code: 'service_mismatch', message: /dry-run/ });
    });

    it('publishes an EVM address only with that address\'s own signature over this member and time', async () => {
        const body = await signed({}, { evmWallet });
        expect(body.evmAddress).toBe(evmWallet.address);
        expect(registrationMessage(body)).toContain(`evmAddress: ${evmWallet.address}`);
        expect(evmAddressStatement(body).split('\n')).toEqual(['Urban Game Theory lens member EVM address v1', `member: ${KEY}`, `evmAddress: ${evmWallet.address}`, `signedAt: ${NOW}`]);
        const fetchStatus = async () => liveStatus({ evmAddress: evmWallet.address.toLowerCase() });
        await expect(verify(body, { fetchStatus })).resolves.toMatchObject({ key: KEY, evmAddress: evmWallet.address });
        // Another key's signature, the address's signature for another member, and none are refused.
        const other = new ethers.Wallet(`0x${'22'.repeat(32)}`);
        await expect(verify({ ...body, evmSignature: await other.signMessage(evmAddressStatement(body)) }, { fetchStatus })).rejects.toMatchObject({ status: 401, code: 'bad_evm_signature' });
        const forAnother = await evmWallet.signMessage(evmAddressStatement({ ...body, key: Keypair.generate().publicKey.toBase58() }));
        await expect(verify({ ...body, evmSignature: forAnother }, { fetchStatus })).rejects.toMatchObject({ code: 'bad_evm_signature' });
        await expect(verify({ ...body, evmSignature: undefined }, { fetchStatus })).rejects.toMatchObject({ code: 'bad_evm_signature' });
        // The Solana key signs the address too: another address with its own valid proof breaks that signature.
        const swapped = { ...body, evmAddress: other.address, evmSignature: await other.signMessage(evmAddressStatement({ ...body, evmAddress: other.address })) };
        await expect(verify(swapped, { fetchStatus: async () => liveStatus({ evmAddress: other.address }) })).rejects.toMatchObject({ code: 'bad_signature' });
        // The running service must attest EVM decisions as this address.
        await expect(verify(body, { fetchStatus: async () => liveStatus() })).rejects.toMatchObject({ code: 'service_mismatch', message: /evmAddress/ });
        await expect(verify({ ...body, evmAddress: '0x1234' }, { fetchStatus })).rejects.toMatchObject({ code: 'bad_request', message: /evmAddress/ });
    });
});

describe('POST /agent/lenses/members', () => {
    const row = { key: KEY, kind: 'owner-consent', name: 'Notary office, Borovje', description: null, service_url: 'https://notary.example.test', registered_at: new Date(NOW * 1000), coverage: {} };

    function appWith(pool, options = {}) {
        const app = express();
        app.use(express.json());
        setupLensesRoute(app, pool, { readAccounts: chain(), fetchStatus: async () => liveStatus(), nowSeconds: () => NOW, ...options });
        return app;
    }

    it('lists a verified member with its own signed time', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [row] })) };
        const res = await request(appWith(pool)).post('/agent/lenses/members').send(await signed());
        expect(res.status).toBe(201);
        expect(res.body.member).toMatchObject({ key: KEY, serviceUrl: 'https://notary.example.test', registeredAt: '2026-09-21T14:13:20.000Z' });
        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toContain('lens_member.registered_at < EXCLUDED.registered_at');
        expect(params).toEqual([KEY, 'owner-consent', 'Notary office, Borovje', 'Attests registered owners from the land registry', 'https://notary.example.test', CREDENTIAL_NAME, NOW, null]);
        expect(res.body.member.addresses).toEqual({ solana: KEY, evm: null });
    });

    it('stores and serves the EVM address a member proved', async () => {
        const pool = { query: vi.fn(async () => ({ rows: [{ ...row, evm_address: evmWallet.address }] })) };
        const app = appWith(pool, { fetchStatus: async () => liveStatus({ evmAddress: evmWallet.address }) });
        const res = await request(app).post('/agent/lenses/members').send(await signed({}, { evmWallet }));
        expect(res.status).toBe(201);
        expect(pool.query.mock.calls[0][0]).toContain('evm_address = EXCLUDED.evm_address');
        expect(pool.query.mock.calls[0][1][7]).toBe(evmWallet.address);
        expect(res.body.member.addresses).toEqual({ solana: KEY, evm: evmWallet.address });
    });

    it('answers 409 to a replay and a readable refusal to a bad registration', async () => {
        const replay = await request(appWith({ query: vi.fn(async () => ({ rows: [] })) })).post('/agent/lenses/members').send(await signed());
        expect(replay.status).toBe(409);
        const pool = { query: vi.fn() };
        const refused = await request(appWith(pool, { readAccounts: chain({ [credential]: null }) })).post('/lenses/members').send(await signed());
        expect(refused.status).toBe(422);
        expect(refused.body).toMatchObject({ error: 'credential_missing', message: /register-lens-schemas/ });
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('rate limits registration attempts per client', async () => {
        const app = appWith({ query: vi.fn() }, { registrationLimit: 1 });
        expect((await request(app).post('/agent/lenses/members').send({})).status).toBe(400);
        expect((await request(app).post('/agent/lenses/members').send({})).status).toBe(429);
    });
});

describe('file attestation store', () => {
    it('persists every record and reloads them', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-store-'));
        const file = path.join(dir, 'attestations.json');
        const store = createFileStore(file);
        expect(store.kind).toBe('file');
        await store.record({ address: 'A1', kind: 'ownership', parcelUid: 'HR-1', owner: 'W' });
        // An AgreementDecision names its agreement in the payload.
        await store.record({ address: 'A2', kind: 'decision', parcelUid: null, payload: { agreementCid: 'bafkrei-a', sponsor: 'S', decision: 'satisfied' } });
        await expect(store.record({ address: 'A1', kind: 'ownership' })).rejects.toThrow(/already recorded/);
        const reloaded = createFileStore(file);
        expect(await reloaded.get('A2')).toMatchObject({ payload: { agreementCid: 'bafkrei-a' } });
        expect(await reloaded.counts()).toEqual({ ownership: 1, decision: 1, evidence: 0, parcels: 1, agreements: 1 });
        expect((await reloaded.list({ agreementCid: 'bafkrei-a' })).map(record => record.address)).toEqual(['A2']);
        expect(await reloaded.list({ agreementCid: 'bafkrei-b' })).toEqual([]);
        expect(fs.readdirSync(dir)).toEqual(['attestations.json']);
        fs.rmSync(dir, { recursive: true });
    });
});

describe('announce end to end', () => {
    it('a running member lists itself and the directory probes its real /lens/status', async () => {
        const clock = { nowSeconds: () => NOW };
        const lens = createLensMember({
            evmIssuer: createFakeEvmIssuer({ clock, address: evmWallet.address }),
            keypair: member,
            credentialName: CREDENTIAL_NAME,
            issuer: createFakeIssuer({ authority: KEY, clock }),
            store: createMemoryStore(),
            identity: createDevnetRegistryIdentity({ rows: [], clock, authority: KEY }),
            clock
        });
        const memberServer = createLensMemberApp({ member: lens, pricing: createLensPricing({ dryRun: true, env: {} }) }).listen(0);
        await new Promise(resolve => memberServer.once('listening', resolve));
        const publicUrl = `http://127.0.0.1:${memberServer.address().port}`;

        const pool = { query: vi.fn(async (_sql, params) => ({ rows: [{ key: params[0], kind: params[1], name: params[2], description: params[3], service_url: params[4], registered_at: new Date(params[6] * 1000), evm_address: params[7], coverage: {} }] })) };
        const directory = express();
        directory.use(express.json());
        setupLensesRoute(directory, pool, { readAccounts: chain(), nowSeconds: () => NOW, allowHttp: true });
        const directoryServer = directory.listen(0);
        await new Promise(resolve => directoryServer.once('listening', resolve));

        try {
            const listed = await announceLensMember({
                directoryUrl: `http://127.0.0.1:${directoryServer.address().port}`,
                publicUrl,
                keypair: member,
                evmWallet,
                status: await lens.status(),
                name: 'Notary office, Borovje',
                nowSeconds: NOW
            });
            expect(listed).toMatchObject({ key: KEY, addresses: { solana: KEY, evm: evmWallet.address }, kind: 'owner-consent', serviceUrl: publicUrl, registeredAt: '2026-09-21T14:13:20.000Z' });
            // A different key cannot list the same service: its status names this member.
            await expect(announceLensMember({
                directoryUrl: `http://127.0.0.1:${directoryServer.address().port}`,
                publicUrl,
                keypair: Keypair.generate(),
                status: await lens.status(),
                name: 'Impostor',
                nowSeconds: NOW
            })).rejects.toThrow(/credential_missing|service_mismatch/);
        } finally {
            memberServer.close();
            directoryServer.close();
        }
    });
});
