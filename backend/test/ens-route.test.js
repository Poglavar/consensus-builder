import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import {
    AbiCoder, Wallet, dnsEncode, namehash,
    recoverAddress, keccak256, solidityPackedKeccak256, getAddress,
} from 'ethers';
import { setupEnsRoute } from '../routes/ens.js';
import { SELECTOR } from '../ens/gateway.js';
import { createRouteApp } from './helpers/create-route-app.js';
import { createMockPool } from './helpers/mock-pool.js';

const abi = AbiCoder.defaultAbiCoder();
const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SENDER = getAddress('0x1111111111111111111111111111111111111111');

function textCallData(name, key) {
    const inner = SELECTOR.TEXT + abi.encode(['bytes32', 'string'], [namehash(name), key]).slice(2);
    return SELECTOR.RESOLVE + abi.encode(['bytes', 'bytes'], [dnsEncode(name), inner]).slice(2);
}
const textUrlCallData = name => textCallData(name, 'url');
const addrCallData = name => SELECTOR.RESOLVE + abi.encode(['bytes', 'bytes'], [dnsEncode(name), SELECTOR.ADDR + abi.encode(['bytes32'], [namehash(name)]).slice(2)]).slice(2);
// The address an addr(bytes32) answer carries.
const addrOf = res => abi.decode(['address'], abi.decode(['bytes', 'uint64', 'bytes'], res.body.data)[0])[0];
// The text record a signed gateway answer carries.
const textOf = res => abi.decode(['string'], abi.decode(['bytes', 'uint64', 'bytes'], res.body.data)[0])[0];
const AGREEMENT_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const DESIGN_CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';

let pool;
let app;

beforeEach(() => {
    process.env.ENS_GATEWAY_SIGNER_KEY = wallet.privateKey;
    process.env.ENS_PARENT_NAME = 'parcels.urbangametheory.eth';
    process.env.ENS_PROPOSALS_PARENT_NAME = 'proposals.urbangametheory.eth';
    process.env.ENS_PUBLIC_BASE_URL = 'https://urbangametheory.xyz';
    delete process.env.ENS_ADDR_RPC_URL;
    delete process.env.ENS_PARCEL_NFT_ADDRESS;
    delete process.env.ENS_PROPOSAL_NFT_ADDRESS;
    pool = createMockPool();
    app = createRouteApp(setupEnsRoute, pool);
});

describe('GET /ens/:sender/:data', () => {
    it('resolves text(url) with a signed, recoverable response', async () => {
        pool.setResult({
            rows: [{ slug: 'us-ny-1234', parcel_id: 'US-NY-1234', city_code: 'ny', lat: null, lon: null, area_m2: null, token_id: null, image_url: null }],
            rowCount: 1,
        });
        const name = 'us-ny-1234.parcels.urbangametheory.eth';
        const callData = textUrlCallData(name);

        const res = await request(app).get(`/ens/${SENDER}/${callData}.json`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatch(/^0x/);

        const [result, expires, signature] = abi.decode(['bytes', 'uint64', 'bytes'], res.body.data);
        const hash = solidityPackedKeccak256(
            ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
            ['0x1900', SENDER, expires, keccak256(callData), keccak256(result)],
        );
        expect(recoverAddress(hash, signature)).toBe(wallet.address);
        const [url] = abi.decode(['string'], result);
        expect(url).toBe('https://urbangametheory.xyz/parcel/US-NY-1234');
    });

    it('rejects a malformed sender', async () => {
        const res = await request(app).get('/ens/notanaddress/0xabcd.json');
        expect(res.status).toBe(400);
    });

    it('returns 503 when the signer key is not configured', async () => {
        delete process.env.ENS_GATEWAY_SIGNER_KEY;
        const unconfiguredApp = createRouteApp(setupEnsRoute, pool);
        const res = await request(unconfiguredApp).get(`/ens/${SENDER}/0xabcd.json`);
        expect(res.status).toBe(503);
    });

    // The CCIP-Read gateway is public — browser resolvers (app.ens.domains)
    // fetch it cross-origin, so it must return Access-Control-Allow-Origin: *
    // even though that origin is not in the allowlist. Mirrors index.js order:
    // the permissive /ens CORS runs before the credentialed allowlist CORS.
    it('returns permissive CORS for a disallowed origin', async () => {
        const corsApp = express();
        corsApp.use('/ens', cors({ origin: '*', methods: ['GET', 'OPTIONS'], credentials: false }));
        corsApp.use(cors({ origin: (_o, cb) => cb(null, false), credentials: true }));
        corsApp.use(express.json());
        setupEnsRoute(corsApp, pool);

        pool.setResult({
            rows: [{ slug: 'us-ny-1234', parcel_id: 'US-NY-1234', city_code: 'ny', lat: null, lon: null, area_m2: null, token_id: null, image_url: null }],
            rowCount: 1,
        });
        const callData = textUrlCallData('us-ny-1234.parcels.urbangametheory.eth');
        const res = await request(corsApp)
            .get(`/ens/${SENDER}/${callData}.json`)
            .set('Origin', 'https://app.ens.domains');

        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    // Published records are named by CID (plan-design-agreement.md M2): an agreement first, then a design.
    it('resolves a CID label to the published agreement it names, with its title and thumbnail', async () => {
        pool.setResult({ rows: [{ cid: AGREEMENT_CID, title: 'Riverside deal', screenshot_url: 'https://api.example/uploads/images/agreement.png' }], rowCount: 1 });
        const name = `${AGREEMENT_CID}.proposals.urbangametheory.eth`;
        const res = await request(app).get(`/ens/${SENDER}/${textUrlCallData(name)}.json`);
        expect(res.status).toBe(200);
        expect(textOf(res)).toBe(`https://urbangametheory.xyz/agreements/${AGREEMENT_CID}`);
        expect(pool.getCalls()[0].sql).toMatch(/FROM consensus\.agreement WHERE cid = \$1/);
        expect(pool.getCalls()[0].params).toEqual([AGREEMENT_CID]);

        pool.setResult({ rows: [{ cid: AGREEMENT_CID, title: 'Riverside deal', screenshot_url: 'https://api.example/uploads/images/agreement.png' }] });
        expect(textOf(await request(app).get(`/ens/${SENDER}/${textCallData(name, 'description')}.json`))).toBe('Riverside deal');
        pool.setResult({ rows: [{ cid: AGREEMENT_CID, title: null, screenshot_url: 'https://api.example/uploads/images/agreement.png' }] });
        expect(textOf(await request(app).get(`/ens/${SENDER}/${textCallData(name, 'avatar')}.json`))).toBe('https://api.example/uploads/images/agreement.png');
    });

    it('resolves a CID label to a design when no agreement has it, and to nothing when neither does', async () => {
        pool.setResults([{ rows: [] }, { rows: [{ cid: DESIGN_CID, title: null, screenshot_url: null }] }]);
        const name = `${DESIGN_CID}.proposals.urbangametheory.eth`;
        const design = await request(app).get(`/ens/${SENDER}/${textUrlCallData(name)}.json`);
        expect(textOf(design)).toBe(`https://urbangametheory.xyz/designs/${DESIGN_CID}`);
        expect(pool.getCalls().map(call => call.sql.match(/consensus\.(\w+)/)[1])).toEqual(['agreement', 'design']);

        // The default description of an untitled design is its kind.
        pool.reset();
        pool.setResults([{ rows: [] }, { rows: [{ cid: DESIGN_CID, title: null, screenshot_url: null }] }]);
        expect(textOf(await request(app).get(`/ens/${SENDER}/${textCallData(name, 'description')}.json`))).toBe('Design');

        pool.reset();
        expect(textOf(await request(app).get(`/ens/${SENDER}/${textUrlCallData(name)}.json`))).toBe('');
        expect(pool.getCalls()).toHaveLength(2);
    });

    it('fails closed when the index cannot be read, and logs why', async () => {
        pool.query = async () => { throw new Error('relation "consensus.agreement" does not exist'); };
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app).get(`/ens/${SENDER}/${textUrlCallData(`${AGREEMENT_CID}.proposals.urbangametheory.eth`)}.json`);
        expect(res.status).toBe(200);
        expect(textOf(res)).toBe('');
        expect(logged).toHaveBeenCalledWith(expect.stringContaining(`looking up ${AGREEMENT_CID} failed`), expect.any(Error));
        logged.mockRestore();
    });

    it('no longer resolves row numbers or plan slugs, and does not even look them up', async () => {
        // A row number, two plan slugs and a truncated CID.
        for (const label of ['51', 'harbor-plan', 'candlestick-plan', AGREEMENT_CID.slice(0, 58)]) {
            pool.reset();
            pool.setResult({ rows: [{ proposal_id: '51', slug: label, title: 'Riverside Lane', screenshot_url: null }] });
            const res = await request(app).get(`/ens/${SENDER}/${textUrlCallData(`${label}.proposals.urbangametheory.eth`)}.json`);
            expect(res.status, label).toBe(200);
            expect(textOf(res), label).toBe('');
            expect(pool.getCalls(), label).toEqual([]);
        }
        // The namespace apex still answers its own records.
        expect(textOf(await request(app).get(`/ens/${SENDER}/${textUrlCallData('proposals.urbangametheory.eth')}.json`))).toBe('https://urbangametheory.xyz');
    });

    it('no longer resolves chain-qualified mirror names, and does not look them up (M3: agreements are named by CID)', async () => {
        pool.setResult({ rows: [{ proposal_id: `chain_${'a'.repeat(64)}`, title: 'Riverside Lane', chain_ref: { chainType: 'evm', chainId: '84532', contract: '0x1234567890123456789012345678901234567890', tokenId: '9' } }] });
        const res = await request(app).get(`/ens/${SENDER}/${textUrlCallData(`chain-${'a'.repeat(48)}.proposals.urbangametheory.eth`)}.json`);
        expect(res.status).toBe(200);
        expect(textOf(res)).toBe('');
        expect(pool.getCalls()).toEqual([]);
    });

    it('gives the proposals namespace no apex address, while the parcels apex keeps its contract', async () => {
        // A stale NFT address in the environment no longer names the apex: agreements and designs are not NFTs.
        process.env.ENS_PROPOSAL_NFT_ADDRESS = '0x2222222222222222222222222222222222222222';
        process.env.ENS_PARCEL_NFT_ADDRESS = '0x3333333333333333333333333333333333333333';
        const configured = createRouteApp(setupEnsRoute, pool);
        const proposalsApex = await request(configured).get(`/ens/${SENDER}/${addrCallData('proposals.urbangametheory.eth')}.json`);
        expect(proposalsApex.status).toBe(200);
        expect(addrOf(proposalsApex)).toBe('0x0000000000000000000000000000000000000000');
        const parcelsApex = await request(configured).get(`/ens/${SENDER}/${addrCallData('parcels.urbangametheory.eth')}.json`);
        expect(addrOf(parcelsApex)).toBe('0x3333333333333333333333333333333333333333');
        // A named agreement has no owner address either.
        pool.setResult({ rows: [{ cid: AGREEMENT_CID, title: 'Riverside deal', screenshot_url: null }] });
        const agreement = await request(configured).get(`/ens/${SENDER}/${addrCallData(`${AGREEMENT_CID}.proposals.urbangametheory.eth`)}.json`);
        expect(addrOf(agreement)).toBe('0x0000000000000000000000000000000000000000');
        expect(pool.getCalls()[0].params).toEqual([AGREEMENT_CID]);
    });
});
