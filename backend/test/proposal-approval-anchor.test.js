// Chain anchor for the owner decisions on a minted agreement (approval-anchor.js): decisions sign the
// agreement's CID whether or not it is minted, and a pinned bundle plus a Memo v1 pointer let a reader
// with only chain + IPFS recover and re-verify every decision; the relay pins the bundle under the
// CID of its bytes (POST /agreements/:cid/decisions/bundle, agreements/decisions.js).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import * as web3 from '@solana/web3.js';
import { createAgreementDecisionHandlers, createMemoryAgreementDecisionStore } from '../agreements/decisions.js';
import { serializeAgreementRow } from '../routes/agreements.js';
import { AGREEMENT_CID, COUNTER_AGREEMENT_CID, DESIGN_CID, PARCEL_IDS, agreement, agreementContent, decision, wallets } from './helpers/approval-decisions.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const relay = require('../../frontend/js/proposals/approval-relay.js');
const anchors = require('../../frontend/js/proposals/approval-anchor.js');
const Cid = require('../../frontend/js/cid.js');

const ACCOUNT = web3.Keypair.generate().publicKey.toBase58();
const ONCHAIN = { chainId: 'solana-devnet', proposalId: ACCOUNT };
const minted = (overrides = {}) => agreement({ onchain: ONCHAIN, ...overrides });
// The memo subject is the CID every decision signs.
const SUBJECT = AGREEMENT_CID;
const counted = (item, approvals) => approval.validOwnerIds({ ...item, ownerApprovals: approvals }, relay.verifyLensReceipt).sort();

describe('the subject a decision signs', () => {
    it('is the agreement’s CID before and after it is minted, and never another agreement’s', () => {
        expect(approval.subjectOf(agreement())).toBe(AGREEMENT_CID);
        expect(approval.subjectOf(minted())).toBe(AGREEMENT_CID);
        expect(() => approval.subjectOf(agreement({ agreementCid: undefined }))).toThrow(/not a CID/);
        expect(() => approval.subjectOf(agreement({ agreementCid: `solana:devnet:${ACCOUNT}` }))).toThrow(/not a CID/);
        // Minting records the agreement on chain; it does not change what its owners signed.
        const offChain = decision(wallets.a, 'owner-a');
        expect(relay.verifyLensReceipt(minted(), offChain)).toBe(true);
        expect(relay.verifyLensReceipt(minted({ agreementCid: COUNTER_AGREEMENT_CID }), offChain)).toBe(false);
        expect(anchors.chainRef(minted())).toEqual({ cluster: 'devnet', account: ACCOUNT });
        expect(anchors.chainRef(agreement())).toBeNull();
        expect(anchors.chainRef(minted({ onchain: { chainId: '11155111', proposalId: '7' } }))).toBeNull();
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
        expect(anchors.pointersIn(memo, COUNTER_AGREEMENT_CID)).toEqual([]);
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
        // Decisions on a counter-agreement do not belong in this agreement's bundle.
        expect(anchors.bundleOf(minted({ agreementCid: COUNTER_AGREEMENT_CID }), rows).decisions).toEqual([]);
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
        await expect(anchors.anchor(minted(), { publishBundle: async () => ({ ...published, subject: COUNTER_AGREEMENT_CID }), connection, web3, provider }))
            .rejects.toMatchObject({ code: 'bad-bundle' });
        await expect(anchors.anchor(agreement(), { publishBundle: async () => published, connection, web3, provider }))
            .rejects.toMatchObject({ code: 'not-minted' });
        await expect(anchors.anchor(minted(), { publishBundle: async () => published, connection, web3, provider: {} }))
            .rejects.toMatchObject({ code: 'wallet-required' });
    });

    it('recovers decisions from chain + IPFS alone, rejecting bundles that do not match their memo', async () => {
        const item = minted();
        const good = anchors.bundleOf(item, [decision(wallets.a, 'owner-a', { item, offset: 1 }), decision(wallets.c, 'owner-c', { item, offset: 2 })]);
        const later = anchors.bundleOf(item, [decision(wallets.d, 'owner-d', { item, offset: 3 })]);
        const swapped = { ...later, decisions: [decision(wallets.b, 'owner-b', { item, offset: 4 })] };
        // A counter-agreement's bundle, posted under this agreement's subject.
        const foreign = anchors.bundleOf(minted({ agreementCid: COUNTER_AGREEMENT_CID }), []);
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
        expect(await anchors.readAnchors(agreement(), { connection, web3, fetchJson: async () => null })).toBeNull();
    });
});

describe('bundle pinning route', () => {
    const bundlePath = `/agreements/${AGREEMENT_CID}/decisions/bundle`;
    // The agreement as the index serves it (GET /agreements/:cid), minted when `onchain` is given.
    const indexed = onchain => serializeAgreementRow({
        cid: AGREEMENT_CID, city: 'test-city', title: 'Block readjustment', author: 'Test author', design_cids: [DESIGN_CID],
        input_parcel_ids: PARCEL_IDS, parcel_source_id: null, deadline: null, status: 'active', content: agreementContent(), onchain,
        screenshot_url: null, screenshot_before_url: null, screenshot_pair_url: null, created_at: new Date('2026-10-21T10:00:00.000Z')
    });
    function app(row, pins, { pinFailure = null } = {}) {
        const store = createMemoryAgreementDecisionStore();
        const server = express();
        server.use(express.json());
        const handlers = createAgreementDecisionHandlers({ store, loadAgreement: async cid => (cid === row.cid ? row : null),
            pinBytes: async ({ bytes, name, cid }) => {
                if (pinFailure) throw pinFailure;
                pins.push({ bytes, name, cid });
                return { cid, pinnedAt: '2026-10-21T10:05:00.000Z' };
            } });
        server.post('/agreements/:cid/decisions', handlers.post);
        server.post('/agreements/:cid/decisions/bundle', handlers.bundle);
        return { server, store };
    }
    async function decided(server, item) {
        for (const receipt of [decision(wallets.a, 'owner-a', { item, offset: 1 }), decision(wallets.c, 'owner-c', { item, offset: 2 })]) {
            expect((await request(server).post(`/agreements/${AGREEMENT_CID}/decisions`).send({ receipt })).status).toBe(201);
        }
    }

    it('pins the verified decisions of a minted agreement once, under the CID of their bytes', async () => {
        const pins = [];
        const item = minted();
        const { server } = app(indexed(ONCHAIN), pins);
        expect((await request(server).post(bundlePath)).body.code).toBe('nothing_to_anchor');
        await decided(server, item);
        const first = await request(server).post(bundlePath);
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ subject: SUBJECT, count: 2, uri: `ipfs://${first.body.cid}` });
        // The pinned bytes are the bundle a reader hashes: their CID carries the same sha256.
        const pinned = new Uint8Array(pins[0].bytes);
        const bundle = JSON.parse(Buffer.from(pinned).toString('utf8'));
        expect(Cid.cidOf(pinned)).toBe(first.body.cid);
        expect(first.body.hash).toBe(anchors.hashOf(bundle));
        expect(`sha256:${Buffer.from(Cid.parse(first.body.cid).digest).toString('hex')}`).toBe(first.body.hash);
        expect(bundle.decisions.map(row => row.ownerId)).toEqual(['owner-a', 'owner-c']);
        const again = await request(server).post(bundlePath);
        expect(again.body).toEqual(first.body);
        expect(pins).toHaveLength(1);
        // What was pinned is exactly what a reader would accept for this memo.
        const read = await anchors.readAnchors(item, { web3, fetchJson: async () => bundle, connection: {
            getSignaturesForAddress: async () => {
                const text = anchors.memoText({ subject: SUBJECT, uri: first.body.uri, hash: first.body.hash });
                return [{ signature: 'tx', err: null, memo: `[${text.length}] ${text}` }];
            }
        } });
        expect(read).toMatchObject({ bundles: 1, rejected: 0 });

        const notMinted = await request(app(indexed(null), []).server).post(bundlePath);
        expect({ status: notMinted.status, code: notMinted.body.code }).toEqual({ status: 409, code: 'not_minted' });
    });

    it('answers 503 when this server cannot pin and 502 when the pin fails, keeping the decisions', async () => {
        const unconfigured = app(indexed(ONCHAIN), [], { pinFailure: Object.assign(new Error('no keys'), { code: 'pinning-unconfigured' }) });
        await decided(unconfigured.server, minted());
        const refused = await request(unconfigured.server).post(bundlePath);
        expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 503, code: 'pinning_unconfigured' });
        expect(await unconfigured.store.list(AGREEMENT_CID)).toHaveLength(2);

        const failing = app(indexed(ONCHAIN), [], { pinFailure: new Error('gateway down') });
        await decided(failing.server, minted());
        const failed = await request(failing.server).post(bundlePath);
        expect({ status: failed.status, code: failed.body.code }).toEqual({ status: 502, code: 'pin_failed' });
    });
});
