// Unit tests for frontend/js/chain/solana-adapter.js (the Solana side of the chain adapter) and
// backend/chain/adapters.js (the server's dispatch by chain key): anchor batches packed by the
// transaction size, which the localnet suite checks byte for byte against a serialized transaction;
// the adapter's reads and writes over a fake connection and send; chain keys.
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair } from '@solana/web3.js';
import { normalizeChainKey, readAdapter, signingAdapter, SOLANA_CHAIN_KEYS } from '../chain/adapters.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const UgtClient = require('../../frontend/js/solana/ugt-client.js');
UgtClient.configure({ web3 });
afterAll(() => { UgtClient.configure({ web3: null }); });
const SolanaAdapter = require('../../frontend/js/chain/solana-adapter.js');

const CID = 'bafkreicubjb3aj3kvia2zucre4rs4dano5jzkf2iq6sclzm5z35e55wuwq';
const page = id => `https://urbangametheory.xyz/parcel/${id}`;
const silent = () => {};

describe('anchor batches', () => {
    it('packs at most ANCHOR_BATCH parcels per transaction, within 1232 bytes', () => {
        const ids = Array.from({ length: 20 }, (_, i) => `HR-335754-${1000 + i}`);
        const batches = SolanaAdapter.anchorBatches(ids, page);
        expect(batches.map(batch => batch.length)).toEqual([8, 8, 4]);
        for (const batch of batches) expect(SolanaAdapter.anchorTxSize(batch, batch.map(page))).toBeLessThanOrEqual(SolanaAdapter.MAX_TX_BYTES);
        expect(batches.flat()).toEqual(ids);
    });

    it('starts a new batch when long URIs would overflow the transaction', () => {
        const long = id => `https://example.org/${'x'.repeat(170)}/${id}`;
        const batches = SolanaAdapter.anchorBatches(['a', 'b', 'c', 'd', 'e', 'f'], long);
        expect(batches.length).toBeGreaterThan(1);
        for (const batch of batches) expect(SolanaAdapter.anchorTxSize(batch, batch.map(long))).toBeLessThanOrEqual(1232);
    });

    it('truncates a name on a character boundary', () => {
        expect(SolanaAdapter.truncateUtf8('ćevapi', 3)).toBe('će');
        expect(SolanaAdapter.chainKeyOf('devnet')).toBe('solana-devnet');
        expect(SolanaAdapter.clusterOf('solana-devnet')).toBe('devnet');
        expect(SolanaAdapter.clusterOf('solana-mainnet-beta')).toBeNull();
        expect(SolanaAdapter.explorerUrl('devnet', { tx: 'sig' })).toBe('https://explorer.solana.com/tx/sig?cluster=devnet');
    });
});

describe('the Solana adapter', () => {
    const wallet = Keypair.generate().publicKey.toBase58();

    function fakeConnection({ anchored = new Set(), records = new Map() } = {}) {
        return {
            async getMultipleAccountsInfo(keys) {
                return keys.map(key => {
                    const id = [...anchored].find(parcelId => UgtClient.getParcelPda(parcelId)[0].equals(key));
                    if (!id) return null;
                    const str = s => Buffer.concat([Buffer.from(Uint32Array.of(Buffer.byteLength(s)).buffer), Buffer.from(s)]);
                    const data = Buffer.concat([Buffer.from(UgtClient.ACCOUNT_DISCRIMINATORS.ParcelAnchor), Buffer.alloc(32, 1), Buffer.alloc(8), Buffer.from([255]), str(id), str(page(id))]);
                    return { owner: new web3.PublicKey(UgtClient.constants.UGT_PROGRAM_ID), data };
                });
            },
            async getAccountInfo(key) {
                return records.get(key.toBase58()) || null;
            }
        };
    }

    it('reports missing anchors in order and sends one transaction per packed batch', async () => {
        const sent = [];
        const adapter = SolanaAdapter.createAdapter({
            connection: fakeConnection({ anchored: new Set(['HR-2']) }), wallet, log: silent,
            send: async instructions => { sent.push(instructions); return `sig${sent.length}`; }
        });
        expect(await adapter.anchorsMissing(['HR-1', 'HR-2', 'HR-3', 'HR-1'])).toEqual(['HR-1', 'HR-3']);
        const progress = [];
        const ids = Array.from({ length: 10 }, (_, i) => `HR-${i}`);
        const result = await adapter.mintAnchors(ids, { metadataUriOf: page, onBatch: event => progress.push(event) });
        expect(result).toEqual({ txHashes: ['sig1', 'sig2'], anchored: 10 });
        expect(progress).toEqual([{ done: 8, total: 10, txHash: 'sig1' }, { done: 10, total: 10, txHash: 'sig2' }]);
        expect(sent[0][0].keys[0].pubkey.toBase58()).toBe(wallet);
    });

    it('mints a record named from its token metadata and refuses a CID already recorded', async () => {
        const records = new Map();
        const sent = [];
        const connection = fakeConnection({ records });
        const adapter = SolanaAdapter.createAdapter({
            connection, wallet, log: silent,
            send: async instructions => {
                sent.push(instructions[0]);
                // The program writes the record; the fake chain stores what create_record names.
                const [record] = UgtClient.getRecordPda('design', CID);
                const str = s => Buffer.concat([Buffer.from(Uint32Array.of(Buffer.byteLength(s)).buffer), Buffer.from(s)]);
                const content = Buffer.concat([Buffer.from(UgtClient.ACCOUNT_DISCRIMINATORS.Record), Buffer.from([1]), new web3.PublicKey(wallet).toBuffer(), Buffer.alloc(8, 0), Buffer.alloc(32, 2), Buffer.from([1, 1]), str(CID)]);
                records.set(record.toBase58(), { owner: new web3.PublicKey(UgtClient.constants.UGT_PROGRAM_ID), data: Buffer.concat([content, Buffer.alloc(151 - content.length)]) });
                return 'sigRecord';
            }
        });
        const tokenUri = `data:application/json;base64,${Buffer.from(JSON.stringify({ name: 'Riverside park' })).toString('base64')}`;
        const minted = await adapter.mintRecord('design', CID, tokenUri);
        expect(minted.txHash).toBe('sigRecord');
        expect(minted.record).toMatchObject({ cid: CID, kind: 'design', minter: wallet, chainId: 'solana-devnet' });
        // name and uri are the last two borsh strings of the instruction data
        expect(Buffer.from(sent[0].data).includes(Buffer.from('Riverside park'))).toBe(true);
        await expect(adapter.mintRecord('design', CID, tokenUri)).rejects.toMatchObject({ code: 'record-exists' });
    });

    it('refuses to write without a signer', async () => {
        const adapter = SolanaAdapter.createAdapter({ connection: fakeConnection(), log: silent });
        expect(adapter.canSign).toBe(false);
        await expect(adapter.mintAnchors(['HR-1'], { metadataUriOf: page })).rejects.toMatchObject({ code: 'no-signer' });
    });
});

describe('server chain keys', () => {
    it('names Solana devnet and the EVM chains, and nothing else', () => {
        expect(SOLANA_CHAIN_KEYS).toEqual(['solana-devnet']);
        expect(normalizeChainKey('solana-devnet')).toBe('solana-devnet');
        expect(normalizeChainKey('devnet')).toBe('solana-devnet');
        expect(normalizeChainKey('0x14a34')).toBe('84532');
        expect(normalizeChainKey('1')).toBeNull();
        expect(normalizeChainKey('solana-mainnet-beta')).toBeNull();
    });

    it('binds a Solana reader and a signer that sends through the injected send', async () => {
        const reader = readAdapter('solana-devnet', { connection: {}, log: silent });
        expect(reader).toMatchObject({ family: 'solana', chainId: 'solana-devnet', canSign: false });
        const keypair = Keypair.generate();
        const signer = signingAdapter('solana-devnet', { connection: {}, keypair, send: async () => 'sig', log: silent });
        expect(signer.canSign).toBe(true);
        expect(await signer.signerAddress()).toBe(keypair.publicKey.toBase58());
        expect(() => signingAdapter('solana-devnet', { connection: {}, env: {}, log: silent })).toThrow(/UGT_AGENT_KEYPAIR/);
        expect(() => readAdapter('42', { log: silent })).toThrow(/Not a supported chain/);
    });
});
