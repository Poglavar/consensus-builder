// The server's EVM chain access (chain/evm.js): chain settings from addresses.json and the env, the
// browser's adapter bound to a provider, and the agent's signing wallet, with no network.
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { DEFAULT_RPC_URLS, chainConfig, loadAddressBook, readAdapter, signingAdapter } from '../chain/evm.js';

const BOOK = {
    '84532': { ParcelAnchor: '0x6785a94694af9455C42F49849027736ABdd1aE2D', RecordRegistry: '0xf3dAA5ea198B11E462bB7Cf0A23d89B4896eeBbF' },
    '11155111': { CityMemeToken: '0xa65E0Eb5E1A0C238A531CB6Fb6325eECa70Ff6A9' }
};
const quiet = () => {};

describe('EVM chain settings', () => {
    it('reads the record registry and parcel anchor of the checked-in address book', () => {
        const book = loadAddressBook();
        const config = chainConfig('84532', {});
        expect(config).toEqual({ chainId: '84532', name: 'Base Sepolia', rpcUrl: DEFAULT_RPC_URLS['84532'],
            addresses: { ParcelAnchor: book['84532'].ParcelAnchor, RecordRegistry: book['84532'].RecordRegistry } });
    });

    it('takes the RPC from EVM_RPC_URL_<chainId> and accepts hex and numeric chain ids', () => {
        const env = { EVM_RPC_URL_84532: 'https://rpc.example.test/base' };
        expect(chainConfig('0x14a34', env, { addressBook: BOOK }).rpcUrl).toBe('https://rpc.example.test/base');
        expect(chainConfig(84532, {}, { addressBook: BOOK }).rpcUrl).toBe('https://sepolia.base.org');
    });

    it('refuses an unknown chain and a chain without the contracts, with codes', () => {
        expect(() => chainConfig('1', {}, { addressBook: BOOK })).toThrowError(expect.objectContaining({ code: 'unknown-chain' }));
        expect(() => chainConfig('11155111', {}, { addressBook: BOOK })).toThrowError(expect.objectContaining({ code: 'no-contracts' }));
        expect(() => chainConfig('31337', {}, { addressBook: BOOK })).toThrowError(expect.objectContaining({ code: 'no-contracts' }));
    });
});

describe('EVM adapters', () => {
    it('binds a read adapter that pages the registry through the given provider', async () => {
        const provider = new ethers.JsonRpcProvider('http://127.0.0.1:1', ethers.Network.from(84532), { staticNetwork: true });
        const call = vi.spyOn(provider, 'call').mockImplementation(async () => {
            const iface = new ethers.Interface(['function records(uint256,uint256,uint8) view returns ((uint8 kind, string cid, address minter, uint64 createdAt, string tokenURI)[])']);
            return iface.encodeFunctionResult('records', [[[1, 'bafkreicubjb3aj3kvia2zucre4rs4dano5jzkf2iq6sclzm5z35e55wuwq', ethers.ZeroAddress, 1700000000, '']]]);
        });
        const adapter = readAdapter('84532', { env: {}, log: quiet, provider, addressBook: BOOK });
        expect(adapter).toMatchObject({ family: 'evm', chainId: '84532', name: 'Base Sepolia', canSign: false });
        const rows = await adapter.listRecords('design');
        expect(rows).toEqual([expect.objectContaining({ cid: 'bafkreicubjb3aj3kvia2zucre4rs4dano5jzkf2iq6sclzm5z35e55wuwq', kind: 'design', chainId: '84532' })]);
        expect(call).toHaveBeenCalledTimes(1);
        expect(call.mock.calls[0][0].to.toLowerCase()).toBe(BOOK['84532'].RecordRegistry.toLowerCase());
        await expect(adapter.mintAnchors(['HR-1-1'], { metadataUriOf: () => '' })).rejects.toMatchObject({ code: 'no-signer' });
    });

    it('signs with UGT_AGENT_EVM_PRIVATE_KEY and refuses without a valid key, never echoing it', async () => {
        const wallet = ethers.Wallet.createRandom();
        const adapter = signingAdapter('84532', { env: { UGT_AGENT_EVM_PRIVATE_KEY: wallet.privateKey }, log: quiet, addressBook: BOOK });
        expect(adapter.canSign).toBe(true);
        expect(await adapter.signerAddress()).toBe(wallet.address);
        expect(() => signingAdapter('84532', { env: {}, log: quiet, addressBook: BOOK })).toThrowError(expect.objectContaining({ code: 'no-evm-key' }));
        const bad = 'not-a-key-0123456789';
        let refusal;
        try { signingAdapter('84532', { env: { UGT_AGENT_EVM_PRIVATE_KEY: bad }, log: quiet, addressBook: BOOK }); } catch (error) { refusal = error; }
        expect(refusal).toMatchObject({ code: 'invalid-evm-key' });
        expect(refusal.message).not.toContain(bad);
    });
});
