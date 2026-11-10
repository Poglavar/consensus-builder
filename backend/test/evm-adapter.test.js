// Unit tests for frontend/js/chain/evm-adapter.js (docs/blockchain-flows.md, Flow 3 on EVM): chain
// ids and explorer links, the token metadata data: URI, record rows, and the adapter over a fake
// ethers: paged record listing, anchor checks, batched anchoring and minting through a signer.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EvmAdapter = require('../../frontend/js/chain/evm-adapter.js');

const ADDRESSES = { ParcelAnchor: '0xaaaa000000000000000000000000000000000001', RecordRegistry: '0xbbbb000000000000000000000000000000000002' };
const tuple = (kind, cid, createdAt, minter = '0xminter') => ({ kind, cid, minter, createdAt, tokenURI: `data:${cid}` });

// A fake ethers whose Contract answers from `registry` (records) and `anchored` (parcel ids), and
// records what it signed with.
function fakeEthers({ registry = [], anchored = new Set() } = {}) {
    const calls = [];
    class Contract {
        constructor(address, abi, runner) { this.address = address; this.abi = abi; this.runner = runner; }
        connect(signer) { const bound = new Contract(this.address, this.abi, signer); bound.signer = signer; return bound; }
        async records(offset, limit, kind) {
            calls.push(['records', offset, limit, kind]);
            return registry.slice(offset, offset + limit).map(row => (kind === 0 || row.kind === kind ? row : tuple(0, '', 0)));
        }
        async exists(cid) { return registry.some(row => row.cid === cid); }
        async recordOf(cid) { return registry.find(row => row.cid === cid); }
        async mint(kind, cid, uri) {
            if (!this.signer) throw new Error('no signer');
            calls.push(['mint', kind, cid, uri, this.signer.name]);
            registry.push(tuple(kind, cid, 1700000000, this.signer.name));
            return { hash: `0xtx${registry.length}`, wait: async () => ({}) };
        }
        async missing(ids) { calls.push(['missing', ids.length]); return ids.map(id => !anchored.has(id)); }
        async anchorBatch(ids, uris) {
            if (!this.signer) throw new Error('no signer');
            calls.push(['anchorBatch', ids, uris]);
            ids.forEach(id => anchored.add(id));
            return { hash: `0xanchor${calls.length}`, wait: async () => ({}) };
        }
    }
    return { ethers: { Contract }, calls };
}

describe('EvmAdapter pure parts', () => {
    it('spells chain ids as addresses.json does and links the explorer of the chain', () => {
        expect(EvmAdapter.normalizeChainId('0x14a34')).toBe('84532');
        expect(EvmAdapter.normalizeChainId(11155111)).toBe('11155111');
        expect(EvmAdapter.normalizeChainId(31337n)).toBe('31337');
        expect(EvmAdapter.normalizeChainId('base')).toBe(null);
        expect(EvmAdapter.chainName('0x14a34')).toBe('Base Sepolia');
        expect(EvmAdapter.explorerUrl(84532, { tx: '0xabc' })).toBe('https://sepolia.basescan.org/tx/0xabc');
        expect(EvmAdapter.explorerUrl('11155111', { address: '0xdef' })).toBe('https://sepolia.etherscan.io/address/0xdef');
        expect(EvmAdapter.explorerUrl(31337, { tx: '0xabc' })).toBe(null);
    });

    it('carries token metadata in a data: URI and reads it back', () => {
        const uri = EvmAdapter.tokenUriOf({ name: 'Riverside', description: 'A plan', externalUrl: 'https://example.org/plans/bafy' });
        expect(uri.startsWith('data:application/json;base64,')).toBe(true);
        expect(EvmAdapter.tokenMetadataOf(uri)).toEqual({ name: 'Riverside', description: 'A plan', external_url: 'https://example.org/plans/bafy' });
        expect(EvmAdapter.tokenMetadataOf('ipfs://bafy')).toBe(null);
    });

    it('shapes a record tuple as a row and drops an empty slot', () => {
        expect(EvmAdapter.recordRow(tuple(2, 'bafyplan', 1700000000, '0xm'), '0x14a34')).toEqual({
            cid: 'bafyplan', kind: 'plan', minter: '0xm', createdAt: '2023-11-14T22:13:20.000Z', tokenUri: 'data:bafyplan', chainId: '84532'
        });
        expect(EvmAdapter.recordRow([1, 'bafydesign', '0xm', 5, 'u'], 84532).kind).toBe('design');
        expect(EvmAdapter.recordRow(tuple(0, '', 0), 84532)).toBe(null);
    });
});

describe('EvmAdapter over a chain', () => {
    it('lists records newest first across pages, filtered by kind, and reads one by CID', async () => {
        const registry = Array.from({ length: 201 }, (_, i) => tuple(i % 2 ? 2 : 1, `cid${i}`, 1700000000 + i));
        const { ethers, calls } = fakeEthers({ registry });
        const adapter = EvmAdapter.createAdapter({ ethers, chainId: 84532, provider: {}, addresses: ADDRESSES });
        const designs = await adapter.listRecords('design');
        expect(calls.filter(call => call[0] === 'records')).toEqual([['records', 0, 200, 1], ['records', 200, 200, 1]]);
        expect(designs.length).toBe(101);
        expect(designs[0].cid).toBe('cid200');
        expect(designs.every(row => row.kind === 'design')).toBe(true);
        expect((await adapter.recordOf('cid3')).kind).toBe('plan');
        expect(await adapter.recordOf('nope')).toBe(null);
        await expect(adapter.listRecords('agreement')).rejects.toMatchObject({ code: 'invalid-kind' });
        expect(() => EvmAdapter.createAdapter({ ethers, chainId: 84532, provider: {}, addresses: { ParcelAnchor: '0x1' } })).toThrow(/no record registry/);
    });

    it('anchors only the missing parcels, in batches of 25, through the signer', async () => {
        const { ethers, calls } = fakeEthers({ anchored: new Set(['HR-1']) });
        const reader = EvmAdapter.createAdapter({ ethers, chainId: 84532, provider: {}, addresses: ADDRESSES });
        const ids = Array.from({ length: 31 }, (_, i) => `HR-${i}`);
        expect(await reader.anchorsMissing(ids)).toEqual(ids.filter(id => id !== 'HR-1'));
        await expect(reader.mintAnchors(['HR-2'], { metadataUriOf: () => '' })).rejects.toMatchObject({ code: 'no-signer' });
        const signer = { name: '0xsigner', getAddress: async () => '0xsigner' };
        const writer = EvmAdapter.createAdapter({ ethers, chainId: 84532, provider: {}, signer, addresses: ADDRESSES });
        const progress = [];
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const result = await writer.mintAnchors(ids.slice(1), { metadataUriOf: id => `https://example.org/parcels/${id}`, onBatch: progress.push.bind(progress) });
        info.mockRestore();
        const batches = calls.filter(call => call[0] === 'anchorBatch');
        expect(batches.map(call => call[1].length)).toEqual([25, 5]);
        // Whatever it is given is sent: the contract itself skips HR-1, which is anchored already.
        expect(batches[0][2][0]).toBe('https://example.org/parcels/HR-1');
        expect(progress.map(step => step.done)).toEqual([25, 30]);
        expect(result.txHashes.length).toBe(2);
        expect(await writer.anchorsMissing(ids)).toEqual(['HR-0']);
    });

    it('mints a record to the signer once, and refuses a CID that has one', async () => {
        const { ethers, calls } = fakeEthers({ registry: [tuple(1, 'bafytaken', 1700000000, '0xother')] });
        const signer = { name: '0xsigner', getAddress: async () => '0xsigner' };
        const adapter = EvmAdapter.createAdapter({ ethers, chainId: '0x14a34', provider: {}, signer, addresses: ADDRESSES });
        expect(adapter.name).toBe('Base Sepolia');
        expect(adapter.canSign).toBe(true);
        await expect(adapter.mintRecord('design', 'bafytaken', 'u')).rejects.toMatchObject({ code: 'record-exists', record: { minter: '0xother' } });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const minted = await adapter.mintRecord('plan', 'bafynew', 'data:x');
        info.mockRestore();
        expect(calls.find(call => call[0] === 'mint')).toEqual(['mint', 2, 'bafynew', 'data:x', '0xsigner']);
        expect(minted.txHash).toBe('0xtx2');
        expect(minted.record).toMatchObject({ cid: 'bafynew', kind: 'plan', minter: '0xsigner', chainId: '84532' });
        expect(adapter.explorerUrl({ tx: minted.txHash })).toBe('https://sepolia.basescan.org/tx/0xtx2');
    });
});
