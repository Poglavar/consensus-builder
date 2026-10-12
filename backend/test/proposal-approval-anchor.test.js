// Chain adapter for approval setups (land-readjustmend.md §20): the minted record commits the
// approval setup, decisions sign the chain identity, and a pinned bundle plus a Memo v1 pointer let a
// reader with only chain + IPFS recover and re-verify every decision.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import * as web3 from '@solana/web3.js';
import { createMemoryOwnerDecisionStore, createOwnerDecisionHandlers } from '../proposals/owner-decisions.js';
import { approvalConfig, decision, proposal as baseProposal, TERMS, wallets } from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');
const anchors = require('../../frontend/js/proposals/approval-anchor.js');
const chainRecord = require('../../frontend/js/proposals/chain-record.js');

const ACCOUNT = web3.Keypair.generate().publicKey.toBase58();
const minted = (overrides = {}) => baseProposal({
    onchain: { chainId: 'solana-devnet', proposalId: ACCOUNT, contractAddress: '3WsVS6ProgramIdPlaceholder' }, ...overrides
});
const SUBJECT = `solana:devnet:${ACCOUNT}`;
const counted = (item, approvals) => approval.validOwnerIds({ ...item, ownerApprovals: approvals }, TERMS, relay.verifyLensReceipt).sort();
const SITE = { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]] };

describe('minting an approval setup', () => {
    const record = overrides => chainRecord.authoredRecord({
        proposalId: 'portable-lr', city: 'zagreb', type: 'structure', goal: 'park', title: 'Readjustment', author: 'Guest',
        isConditional: false, lens: [baseProposal().lens[0]], site: SITE,
        binding: { coverage: 'complete', parcels: [{ parcelId: 'parcel-a', overlapM2: 100 }], toleranceM: 0 },
        cadastreSnapshot: { protocol: 'cadastre-snapshot/1', source: 'cadastre-v1', regionHasCadastre: true,
            parcels: [{ id: 'parcel-a', sourceId: 'cadastre-v1', sourceVersion: null, sourceGeometryHash: null, geometryHash: 'a'.repeat(64), geometry: SITE }] },
        structureProposal: { geometry: SITE }, cadastreParcelIds: ['parcel-a'], ...overrides
    });

    it('commits the normalized approval setup in the portable record and restores it from metadata', () => {
        const config = { ...approvalConfig, rights: { ...approvalConfig.rights, parcels: [approvalConfig.rights.parcels[0]] } };
        const minted = record({ approvalConfig: config });
        expect(minted.approvalConfig).toEqual(approval.normalizeConfig(config));
        const restored = chainRecord.fromMetadata({ properties: chainRecord.metadataProperties(minted) });
        expect(restored.approvalConfig).toEqual(minted.approvalConfig);
        // The context every decision signs is the same from the record as from the original.
        expect(approval.contextHash({ ...restored, approvalConfig: restored.approvalConfig }))
            .toBe(approval.contextHash({ cadastreParcelIds: ['parcel-a'], approvalConfig: config, lens: minted.lens }));
        expect(() => record({ approvalConfig: { schema: 'wrong' } })).toThrow(/approval setup is invalid/);
        const tampered = { properties: chainRecord.metadataProperties(minted) };
        tampered.properties.proposal.approvalConfig = { schema: 'proposal-approval/v1', rights: [], policy: { type: 'unanimous' } };
        expect(() => chainRecord.fromMetadata(tampered)).toThrow(/approval setup is invalid/);
    });

    it('decides a minted proposal under its chain account, so an off-chain receipt does not carry over', () => {
        expect(approval.subjectOf(baseProposal())).toBe('relay-proposal');
        expect(approval.subjectOf(minted())).toBe(SUBJECT);
        expect(() => approval.subjectOf(baseProposal({ onchain: { chainId: '11155111', proposalId: '7' } }))).toThrow(/only for proposals minted on Solana/);
        const onChain = decision(wallets.a, 'owner-a', { item: minted() });
        expect(relay.verifyLensReceipt(minted(), onChain)).toBe(true);
        expect(relay.verifyLensReceipt(minted(), decision(wallets.a, 'owner-a'))).toBe(false);
        expect(relay.verifyLensReceipt(minted({ onchain: { chainId: 'solana-devnet', proposalId: web3.Keypair.generate().publicKey.toBase58() } }), onChain)).toBe(false);
    });
});

describe('anchor memos and bundles', () => {
    it('parses only well-formed pointers for this subject out of RPC memo strings', () => {
        const hash = `sha256:${'b'.repeat(64)}`;
        const ours = anchors.memoText({ subject: SUBJECT, uri: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', hash });
        const memo = `[${ours.length}] ${ours}; [5] hello; [${ours.length + 1}] ${ours.replace(SUBJECT, `${SUBJECT}x`)}`;
        expect(anchors.memoTexts(memo)).toEqual([ours, 'hello', ours.replace(SUBJECT, `${SUBJECT}x`)]);
        expect(anchors.pointersIn(memo, SUBJECT)).toEqual([{ uri: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', hash }]);
        for (const bad of [ours.replace('ipfs://', 'https://'), ours.replace(hash, 'sha256:xyz'), `${ours} extra`, ours.replace('/1 ', '/2 ')]) {
            expect(anchors.pointersIn(`[${bad.length}] ${bad}`, SUBJECT)).toEqual([]);
        }
        expect(anchors.memoTexts(null)).toEqual([]);
    });

    it('builds the same bundle and hash from the same decisions in any order', () => {
        const rows = [decision(wallets.a, 'owner-a', { item: minted(), offset: 1 }), decision(wallets.c, 'owner-c', { item: minted(), offset: 2 })];
        const forward = anchors.bundleOf(minted(), rows);
        const backward = anchors.bundleOf(minted(), [...rows].reverse().concat(rows));
        expect(forward).toMatchObject({ schema: anchors.BUNDLE_SCHEMA, subject: SUBJECT, contextHash: approval.contextHash(minted()) });
        expect(forward.decisions).toHaveLength(2);
        expect(anchors.hashOf(backward)).toBe(anchors.hashOf(forward));
        expect(anchors.hashOf(forward)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('records the pointer in a Memo v1 instruction that names the lookup address unsigned', async () => {
        const sent = [];
        const payer = web3.Keypair.generate();
        const connection = {
            getLatestBlockhash: async () => ({ blockhash: web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 }),
            simulateTransaction: async () => ({ value: { err: null } }),
            sendRawTransaction: async bytes => { sent.push(web3.Transaction.from(bytes)); return 'tx-signature'; },
            confirmTransaction: async () => ({ value: { err: null } })
        };
        const provider = { publicKey: payer.publicKey, signTransaction: async tx => { tx.sign(payer); return tx; } };
        const published = { uri: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy', hash: `sha256:${'c'.repeat(64)}`, subject: SUBJECT, count: 2 };
        const result = await anchors.anchor(minted(), { publishBundle: async () => published, connection, web3, provider });
        expect(result).toMatchObject({ signature: 'tx-signature', cluster: 'devnet', uri: published.uri });
        const [instruction] = sent[0].instructions;
        expect(instruction.programId.toBase58()).toBe(anchors.MEMO_V1_PROGRAM_ID);
        expect(instruction.keys).toEqual([{ pubkey: anchors.inboxAddress(web3, ACCOUNT), isSigner: false, isWritable: false }]);
        expect(Buffer.from(instruction.data).toString('utf8')).toBe(anchors.memoText(published));
        await expect(anchors.anchor(minted(), { publishBundle: async () => ({ ...published, subject: 'solana:devnet:other' }), connection, web3, provider }))
            .rejects.toMatchObject({ code: 'bad-bundle' });
        await expect(anchors.anchor(baseProposal(), { publishBundle: async () => published, connection, web3, provider }))
            .rejects.toMatchObject({ code: 'not-minted' });
    });

    it('recovers decisions from chain + IPFS alone, rejecting bundles that do not match their memo', async () => {
        const item = minted();
        const good = anchors.bundleOf(item, [decision(wallets.a, 'owner-a', { item, offset: 1 }), decision(wallets.c, 'owner-c', { item, offset: 2 })]);
        const later = anchors.bundleOf(item, [decision(wallets.d, 'owner-d', { item, offset: 3 })]);
        const swapped = { ...later, decisions: [decision(wallets.b, 'owner-b', { item, offset: 4 })] };
        const foreign = { ...anchors.bundleOf(minted({ onchain: { chainId: 'solana-devnet', proposalId: web3.Keypair.generate().publicKey.toBase58() } }), []) };
        const files = { 'ipfs://bafkgood000000000000000000': good, 'ipfs://bafklater00000000000000000': later,
            'ipfs://bafkswap000000000000000000': swapped, 'ipfs://bafkforeign0000000000000000': foreign };
        const memo = (uri, bundle) => {
            const text = anchors.memoText({ subject: SUBJECT, uri, hash: anchors.hashOf(bundle) });
            return `[${text.length}] ${text}`;
        };
        const lookups = [];
        const connection = {
            async getSignaturesForAddress(address) {
                lookups.push(address.toBase58());
                return [
                    { signature: 's1', err: null, memo: memo('ipfs://bafkgood000000000000000000', good) },
                    // Posted before the genuine pointer: the same hash, but its URI serves other content.
                    { signature: 's3', err: null, memo: memo('ipfs://bafkswap000000000000000000', later) },
                    { signature: 's2', err: null, memo: memo('ipfs://bafklater00000000000000000', later) },
                    { signature: 's7', err: null, memo: memo('ipfs://bafklater00000000000000000', later) }, // repeated pointer
                    { signature: 's4', err: null, memo: memo('ipfs://bafkforeign0000000000000000', foreign) },
                    { signature: 's5', err: { InstructionError: [0, 'Custom'] }, memo: memo('ipfs://bafkgood000000000000000000', later) },
                    { signature: 's6', err: null, memo: null }
                ];
            }
        };
        const read = await anchors.readAnchors(item, { connection, web3, fetchJson: async uri => files[uri] });
        expect(lookups).toEqual([anchors.inboxAddress(web3, ACCOUNT).toBase58()]);
        expect(read).toMatchObject({ bundles: 2, rejected: 2, transactions: ['s1', 's2'] });
        // A fresh browser with nothing local recovers A, C and D, and counts them after its own checks.
        const reader = minted();
        expect(relay.merge(reader, read.decisions, relay.verifyLensReceipt).changed).toBe(true);
        expect(counted(reader, reader.ownerApprovals)).toEqual(['owner-a', 'owner-c', 'owner-d']);
        expect(anchors.anchoredSignatures(read).size).toBe(3);
        expect(await anchors.readAnchors(baseProposal(), { connection, web3, fetchJson: async () => null })).toBeNull();
    });
});

describe('bundle pinning route', () => {
    function app(published, pins) {
        const store = createMemoryOwnerDecisionStore();
        const server = express();
        server.use(express.json());
        const handlers = createOwnerDecisionHandlers({ store, loadProposal: async id => (id === '41' ? published : null),
            pinJson: async (bundle, name) => { pins.push({ bundle, name }); return `ipfs://bafkpinned${pins.length}${'0'.repeat(20)}`; } });
        server.post('/proposals/:id/owner-decisions', handlers.post);
        server.post('/proposals/:id/owner-decisions/bundle', handlers.bundle);
        return server;
    }

    it('pins the verified decisions of a minted proposal once and refuses what cannot be anchored', async () => {
        const pins = [];
        const item = minted();
        const server = app(item, pins);
        expect((await request(server).post('/proposals/41/owner-decisions/bundle')).body.code).toBe('nothing_to_anchor');
        for (const receipt of [decision(wallets.a, 'owner-a', { item, offset: 1 }), decision(wallets.c, 'owner-c', { item, offset: 2 })]) {
            expect((await request(server).post('/proposals/41/owner-decisions').send({ receipt })).status).toBe(201);
        }
        const first = await request(server).post('/proposals/41/owner-decisions/bundle');
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ subject: SUBJECT, count: 2, uri: expect.stringMatching(/^ipfs:\/\//) });
        expect(first.body.hash).toBe(anchors.hashOf(pins[0].bundle));
        const again = await request(server).post('/proposals/41/owner-decisions/bundle');
        expect(again.body).toEqual(first.body);
        expect(pins).toHaveLength(1);
        // What was pinned is exactly what a reader would accept for this memo.
        const read = await anchors.readAnchors(item, { web3, fetchJson: async () => pins[0].bundle, connection: {
            getSignaturesForAddress: async () => {
                const text = anchors.memoText({ subject: SUBJECT, uri: first.body.uri, hash: first.body.hash });
                return [{ signature: 'tx', err: null, memo: `[${text.length}] ${text}` }];
            }
        } });
        expect(read).toMatchObject({ bundles: 1, rejected: 0 });

        const unminted = app(baseProposal(), []);
        const notMinted = await request(unminted).post('/proposals/41/owner-decisions/bundle');
        expect(notMinted.status).toBe(409);
        expect(notMinted.body.code).toBe('not_minted');
    });
});
