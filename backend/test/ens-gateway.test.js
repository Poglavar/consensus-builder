import { describe, it, expect } from 'vitest';
import {
    AbiCoder, Wallet, dnsEncode, namehash,
    recoverAddress, keccak256, solidityPackedKeccak256, getAddress,
} from 'ethers';
import { resolveQuery, SELECTOR } from '../ens/gateway.js';

const abi = AbiCoder.defaultAbiCoder();

// Build the wrapper calldata the OffchainResolver forwards: resolve(name, data).
function makeCallData(name, innerData) {
    return SELECTOR.RESOLVE + abi.encode(['bytes', 'bytes'], [dnsEncode(name), innerData]).slice(2);
}
function textQuery(name, key) {
    return SELECTOR.TEXT + abi.encode(['bytes32', 'string'], [namehash(name), key]).slice(2);
}
function addrQuery(name) {
    return SELECTOR.ADDR + abi.encode(['bytes32'], [namehash(name)]).slice(2);
}

const wallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SENDER = getAddress('0x1111111111111111111111111111111111111111');
const OWNER = getAddress('0x2222222222222222222222222222222222222222');

const record = {
    parcel_id: 'US-NY-1234', city_code: 'ny', city_name: 'New York',
    lat: 40.7, lon: -74.0, area_m2: 123.4, token_id: '5', image_url: 'https://img/x.png',
};
const lookupSlug = async (slug) => (slug === 'us-ny-1234' ? record : null);
const resolveOwner = async () => OWNER;

const config = {
    parentLabels: ['parcels', 'urbangametheory', 'eth'],
    publicBaseUrl: 'https://urbangametheory.xyz',
    ttlSeconds: 300,
    signingKey: wallet.privateKey,
    apexAddress: null,
    now: () => 1_000_000,
};

function decodeResp(data) {
    const [result, expires, signature] = abi.decode(['bytes', 'uint64', 'bytes'], data);
    return { result, expires, signature };
}
// Re-derive the SignatureVerifier hash and recover the signer.
function recoverSigner(expires, callData, result, signature) {
    const hash = solidityPackedKeccak256(
        ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
        ['0x1900', SENDER, expires, keccak256(callData), keccak256(result)],
    );
    return recoverAddress(hash, signature);
}

describe('resolveQuery — text(url)', () => {
    it('returns the deep-link url and a signature recoverable to the signer', async () => {
        const name = 'us-ny-1234.parcels.urbangametheory.eth';
        const callData = makeCallData(name, textQuery(name, 'url'));
        const data = await resolveQuery({ sender: SENDER, callData, lookupSlug, resolveOwner, config });

        const { result, expires, signature } = decodeResp(data);
        expect(recoverSigner(expires, callData, result, signature)).toBe(wallet.address);
        expect(expires).toBe(1_000_300n);
        const [url] = abi.decode(['string'], result);
        expect(url).toBe('https://urbangametheory.xyz/parcel/US-NY-1234');
    });

    it('does not url-encode the slash in Zagreb parcel ids', async () => {
        const zagreb = { ...record, parcel_id: 'HR-335258-4341/2', city_name: 'Zagreb' };
        const lookup = async () => zagreb;
        const name = 'hr-335258-4341-2.parcels.urbangametheory.eth';
        const callData = makeCallData(name, textQuery(name, 'url'));
        const data = await resolveQuery({ sender: SENDER, callData, lookupSlug: lookup, resolveOwner, config });
        const [url] = abi.decode(['string'], decodeResp(data).result);
        expect(url).toBe('https://urbangametheory.xyz/parcel/HR-335258-4341/2');
    });
});

describe('resolveQuery — other records', () => {
    const name = 'us-ny-1234.parcels.urbangametheory.eth';

    it('text(description) includes id, city and area', async () => {
        const callData = makeCallData(name, textQuery(name, 'description'));
        const data = await resolveQuery({ sender: SENDER, callData, lookupSlug, resolveOwner, config });
        const [desc] = abi.decode(['string'], decodeResp(data).result);
        expect(desc).toContain('US-NY-1234');
        expect(desc).toContain('New York');
        expect(desc).toContain('123');
    });

    it('text(geo) returns lat,lon', async () => {
        const callData = makeCallData(name, textQuery(name, 'geo'));
        const data = await resolveQuery({ sender: SENDER, callData, lookupSlug, resolveOwner, config });
        const [geo] = abi.decode(['string'], decodeResp(data).result);
        expect(geo).toBe('40.7,-74');
    });

    it('addr(node) returns the owner', async () => {
        const callData = makeCallData(name, addrQuery(name));
        const data = await resolveQuery({ sender: SENDER, callData, lookupSlug, resolveOwner, config });
        const [addr] = abi.decode(['address'], decodeResp(data).result);
        expect(addr).toBe(OWNER);
    });
});

describe('resolveQuery — edge cases', () => {
    it('unknown slug → empty record, still signed', async () => {
        const name = 'zz-does-not-exist.parcels.urbangametheory.eth';
        const callData = makeCallData(name, textQuery(name, 'url'));
        const data = await resolveQuery({ sender: SENDER, callData, lookupSlug, resolveOwner, config });
        const { result, expires, signature } = decodeResp(data);
        expect(recoverSigner(expires, callData, result, signature)).toBe(wallet.address);
        const [url] = abi.decode(['string'], result);
        expect(url).toBe('');
    });

    it('apex name resolves the contract address + base url', async () => {
        const apexConfig = { ...config, apexAddress: OWNER };
        const name = 'parcels.urbangametheory.eth';
        const addrCall = makeCallData(name, addrQuery(name));
        const addrData = await resolveQuery({ sender: SENDER, callData: addrCall, lookupSlug, resolveOwner, config: apexConfig });
        const [addr] = abi.decode(['address'], decodeResp(addrData).result);
        expect(addr).toBe(OWNER);

        const urlCall = makeCallData(name, textQuery(name, 'url'));
        const urlData = await resolveQuery({ sender: SENDER, callData: urlCall, lookupSlug, resolveOwner, config: apexConfig });
        const [url] = abi.decode(['string'], decodeResp(urlData).result);
        expect(url).toBe('https://urbangametheory.xyz');
    });

    it('rejects a name not under the parent', async () => {
        const name = 'foo.bar.eth';
        const callData = makeCallData(name, textQuery(name, 'url'));
        await expect(resolveQuery({ sender: SENDER, callData, lookupSlug, resolveOwner, config }))
            .rejects.toThrow(/not under the configured parent/);
    });
});
