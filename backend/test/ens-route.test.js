import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
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

function textUrlCallData(name) {
    const inner = SELECTOR.TEXT + abi.encode(['bytes32', 'string'], [namehash(name), 'url']).slice(2);
    return SELECTOR.RESOLVE + abi.encode(['bytes', 'bytes'], [dnsEncode(name), inner]).slice(2);
}

let pool;
let app;

beforeEach(() => {
    process.env.ENS_GATEWAY_SIGNER_KEY = wallet.privateKey;
    process.env.ENS_PARENT_NAME = 'parcels.urbangametheory.eth';
    process.env.ENS_PUBLIC_BASE_URL = 'https://urbangametheory.xyz';
    delete process.env.ENS_ADDR_RPC_URL;
    delete process.env.ENS_PARCEL_NFT_ADDRESS;
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
});
