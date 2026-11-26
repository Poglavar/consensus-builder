// The node signer adapters behind the MCP's agreement, refund and parcel-anchor tools
// (agents/chain-actions.js): the instructions each sends, read against the codecs the browser uses,
// and the refusals and replays that sign nothing.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { anchorParcels, cancelAgreement, confirmAsLensMember, refundContributions } from '../agents/chain-actions.js';
import { agreementAccountOf } from '../agents/agreement-minter.js';
import { cidOfObject } from '../cid.js';
import { agreementAccountBytes, AGREEMENT_PROGRAM_ID } from './fixtures/agreement-account.js';
import { donationEscrowAccount, donationPositionAccount } from './helpers/agent-chain-fakes.js';

const require = createRequire(import.meta.url);
const agreementClient = require('../../frontend/js/solana/agreement-client.js');
const pledgeClient = require('../../frontend/js/solana/pledge-client.js');
const parcelClient = require('../../frontend/js/solana/parcel-client.js');

const NOW = Math.floor(Date.now() / 1000);
const disc = (bytes, name, table) => Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from(table[name]));

// A connection holding `accounts` (address → { owner, data }), with the chain clock at NOW.
function chain(accounts = new Map()) {
    const info = address => {
        const row = accounts.get(new PublicKey(address).toBase58());
        return row ? { owner: new PublicKey(row.owner), data: Buffer.from(row.data), lamports: 1, executable: false } : null;
    };
    return {
        accounts,
        getAccountInfo: vi.fn(async address => info(address)),
        getMultipleAccountsInfo: vi.fn(async keys => keys.map(info)),
        // dataSize and 32-byte (public key) memcmp filters, as the pledge client lists positions.
        getProgramAccounts: vi.fn(async (program, { filters = [] } = {}) => [...accounts.entries()]
            .filter(([, row]) => row.owner === new PublicKey(program).toBase58())
            .filter(([, row]) => filters.every(filter => (filter.dataSize === undefined || row.data.length === filter.dataSize)
                && (!filter.memcmp || Buffer.from(row.data).subarray(filter.memcmp.offset, filter.memcmp.offset + 32).equals(new PublicKey(filter.memcmp.bytes).toBuffer()))))
            .map(([address, row]) => ({ pubkey: new PublicKey(address), account: { owner: new PublicKey(row.owner), data: Buffer.from(row.data) } }))),
        getSlot: vi.fn(async () => 1),
        getBlockTime: vi.fn(async () => NOW)
    };
}

function agreementOn(accounts, { sponsor, cid, ...fields }) {
    const account = agreementAccountOf(cid, sponsor);
    accounts.set(account, { owner: AGREEMENT_PROGRAM_ID, data: agreementAccountBytes({ cid, authority: sponsor, deadline: NOW + 86_400, ...fields }) });
    return account;
}

const recorder = () => {
    const sent = [];
    const sendAndConfirm = vi.fn(async (_connection, transaction, signers) => {
        sent.push({ instructions: transaction.instructions, signers: signers.map(s => s.publicKey.toBase58()) });
        return `sig-${sent.length}`;
    });
    return { sent, sendAndConfirm };
};

describe('cancel', () => {
    it('lets the sponsor withdraw a pending agreement, replays a cancelled one and refuses after the decision', async () => {
        const sponsor = Keypair.generate(), cid = cidOfObject({ cancel: 1 });
        const accounts = new Map();
        const account = agreementOn(accounts, { sponsor: sponsor.publicKey.toBase58(), cid, escrowLamports: 5000 });
        const { sent, sendAndConfirm } = recorder();
        const result = await cancelAgreement({ connection: chain(accounts), sponsorKeypair: sponsor, cid, sendAndConfirm });
        expect(result).toMatchObject({ replayed: false, signature: 'sig-1', account, status: 'Cancelled', refundedLamports: '5000' });
        const [ix] = sent[0].instructions;
        expect(ix.programId.toBase58()).toBe(AGREEMENT_PROGRAM_ID);
        expect(disc(ix.data, 'cancel', agreementClient.IX_DISCRIMINATORS)).toBe(true);
        expect(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner])).toEqual([[account, false], [sponsor.publicKey.toBase58(), true]]);

        agreementOn(accounts, { sponsor: sponsor.publicKey.toBase58(), cid, status: 2 });
        expect(await cancelAgreement({ connection: chain(accounts), sponsorKeypair: sponsor, cid, sendAndConfirm })).toMatchObject({ replayed: true, signature: null });
        agreementOn(accounts, { sponsor: sponsor.publicKey.toBase58(), cid, decision: 1 });
        await expect(cancelAgreement({ connection: chain(accounts), sponsorKeypair: sponsor, cid, sendAndConfirm })).rejects.toMatchObject({ code: 'cannot-cancel' });
        expect(sent).toHaveLength(1);
    });
});

describe('confirm as lens member', () => {
    const investorAgreement = (cid, sponsor, lens) => ({ cid, onchain: null, content: { sponsor, deadline: null,
        rule: { electorate: 'investors', binding: true, lens: [lens], lensThreshold: 1 } } });

    it('issues the member\'s decision, records it and executes when it completes the lens, in one transaction', async () => {
        const sponsor = Keypair.generate().publicKey.toBase58(), member = Keypair.generate(), cid = cidOfObject({ confirm: 1 });
        const accounts = new Map();
        const account = agreementOn(accounts, { sponsor, cid, lenses: [member.publicKey.toBase58()], lensThreshold: 1 });
        const { sent, sendAndConfirm } = recorder();
        const result = await confirmAsLensMember({ connection: chain(accounts), memberKeypair: member, agreement: investorAgreement(cid, sponsor, member.publicKey.toBase58()), sendAndConfirm });
        expect(result).toMatchObject({ replayed: false, account, executed: true, released: false });
        // credential and schema (first decision), attestation, attest, execute
        const programs = sent[0].instructions.map(ix => ix.programId.toBase58());
        const sas = agreementClient.constants.SAS_PROGRAM_ID;
        expect(programs).toEqual([sas, sas, sas, AGREEMENT_PROGRAM_ID, AGREEMENT_PROGRAM_ID]);
        expect(disc(sent[0].instructions[3].data, 'attest', agreementClient.IX_DISCRIMINATORS)).toBe(true);
        expect(disc(sent[0].instructions[4].data, 'execute', agreementClient.IX_DISCRIMINATORS)).toBe(true);
        expect(sent[0].instructions[3].keys[1].pubkey.toBase58()).toBe(result.attestation);
        expect(sent[0].signers).toEqual([member.publicKey.toBase58()]);
    });

    it('refuses a key outside the lens, replays a recorded confirmation and counts an owners\' agreement\'s decisions first', async () => {
        const sponsor = Keypair.generate().publicKey.toBase58(), member = Keypair.generate(), cid = cidOfObject({ confirm: 2 });
        const accounts = new Map();
        const other = Keypair.generate().publicKey.toBase58();
        agreementOn(accounts, { sponsor, cid, lenses: [other], lensThreshold: 1 });
        const { sent, sendAndConfirm } = recorder();
        const agreement = investorAgreement(cid, sponsor, member.publicKey.toBase58());
        await expect(confirmAsLensMember({ connection: chain(accounts), memberKeypair: member, agreement, sendAndConfirm })).rejects.toMatchObject({ code: 'not-lens-member' });
        agreementOn(accounts, { sponsor, cid, lenses: [member.publicKey.toBase58(), other], lensThreshold: 2, lensConfirmed: [member.publicKey.toBase58()] });
        expect(await confirmAsLensMember({ connection: chain(accounts), memberKeypair: member, agreement, sendAndConfirm })).toMatchObject({ replayed: true, signature: null });
        agreementOn(accounts, { sponsor, cid, lenses: [member.publicKey.toBase58()], lensThreshold: 1 });
        const owners = { ...agreement, content: { ...agreement.content, inputs: { parcels: [{ parcelId: 'p1' }] },
            rule: { electorate: 'owners', binding: true, lens: [member.publicKey.toBase58()], lensThreshold: 1 } } };
        await expect(confirmAsLensMember({ connection: chain(accounts), memberKeypair: member, agreement: owners, sendAndConfirm })).rejects.toMatchObject({ code: 'decisions-unavailable' });
        await expect(confirmAsLensMember({ connection: chain(accounts), memberKeypair: member, agreement: owners, receipts: [], sendAndConfirm })).rejects.toMatchObject({ code: 'member-refused' });
        expect(sent).toHaveLength(0);
    });
});

describe('refund contributions', () => {
    it('takes back this wallet\'s open donations only once the agreement is cancelled or expired', async () => {
        const sponsor = Keypair.generate().publicKey.toBase58(), donor = Keypair.generate(), cid = cidOfObject({ refund: 1 });
        const accounts = new Map();
        const account = agreementOn(accounts, { sponsor, cid });
        const agreement = { cid, content: { sponsor, rule: { electorate: 'owners', binding: true } } };
        const { sent, sendAndConfirm } = recorder();
        await expect(refundContributions({ connection: chain(accounts), donorKeypair: donor, agreement, sendAndConfirm })).rejects.toMatchObject({ code: 'not-refundable' });
        agreementOn(accounts, { sponsor, cid, status: 2 });
        const escrow = donationEscrowAccount({ agreement: account, beneficiary: sponsor, totalDonated: 30n });
        accounts.set(escrow.address, escrow);
        for (const [seed, refunded] of [[1, false], [2, true]]) {
            const position = donationPositionAccount({ agreement: account, owner: donor.publicKey.toBase58(), donationId: Buffer.alloc(32, seed), amount: 10n, refunded });
            accounts.set(position.address, position);
        }
        const result = await refundContributions({ connection: chain(accounts), donorKeypair: donor, agreement, sendAndConfirm });
        expect(result).toMatchObject({ replayed: false, refunded: 1, remaining: 0 });
        expect(sent[0].instructions).toHaveLength(1);
        expect(disc(sent[0].instructions[0].data, 'refund_donation', pledgeClient.IX_DISCRIMINATORS)).toBe(true);
    });
});

describe('parcel anchors', () => {
    const uri = id => `https://urbangametheory.xyz/parcel/${id}`;
    it('skips existing anchors and packs the rest several to a transaction, within the size limit', async () => {
        const payer = Keypair.generate();
        const accounts = new Map();
        const [existing] = parcelClient.getParcelPda('HR-1-1');
        accounts.set(existing.toBase58(), { owner: parcelClient.constants.PARCEL_NFT_PROGRAM_ID, data: new Uint8Array(40) });
        const ids = ['HR-1-1', ...Array.from({ length: 20 }, (_, i) => `HR-335754-${1000 + i}/2`)];
        const { sent, sendAndConfirm } = recorder();
        const connection = chain(accounts);
        const result = await anchorParcels({ connection, payerKeypair: payer, sendAndConfirm,
            parcels: ids.map(anchorId => ({ anchorId, metadataUri: uri(anchorId) })) });
        expect(connection.getAccountInfo).not.toHaveBeenCalled();
        expect(result.parcels[0]).toEqual({ anchorId: 'HR-1-1', anchor: existing.toBase58(), alreadyAnchored: true, signature: null });
        // 20 new anchors fit in fewer transactions than anchors, each within 1232 bytes, in order.
        expect(sent.length).toBe(result.transactions);
        expect(sent.length).toBeGreaterThan(1);
        expect(sent.length).toBeLessThan(5);
        const sentIds = sent.flatMap(tx => tx.instructions.map(ix => ix.keys[0].pubkey.toBase58()));
        expect(sentIds).toEqual(ids.slice(1).map(id => parcelClient.getParcelPda(id)[0].toBase58()));
        for (const tx of sent) {
            const probe = new Transaction({ feePayer: payer.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(...tx.instructions);
            expect(probe.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThanOrEqual(1232);
        }
        const [first] = sent[0].instructions;
        expect(Buffer.from(first.data).equals(Buffer.from(parcelClient.encodeMintParcelData(ids[1], uri(ids[1]))))).toBe(true);
        expect(first.keys[1].pubkey.toBase58()).toBe(payer.publicKey.toBase58());
        expect(result.parcels.slice(1).every(row => row.alreadyAnchored === false && /^sig-\d$/.test(row.signature))).toBe(true);
    });

    it('signs nothing for anchored parcels or a parcel without a URI, and reports what was done when a transaction fails', async () => {
        const payer = Keypair.generate();
        const [existing] = parcelClient.getParcelPda('HR-1-1');
        const accounts = new Map([[existing.toBase58(), { owner: parcelClient.constants.PARCEL_NFT_PROGRAM_ID, data: new Uint8Array(40) }]]);
        const { sent, sendAndConfirm } = recorder();
        expect(await anchorParcels({ connection: chain(accounts), payerKeypair: payer, sendAndConfirm, parcels: [{ anchorId: 'HR-1-1', metadataUri: uri('HR-1-1') }] }))
            .toEqual({ parcels: [{ anchorId: 'HR-1-1', anchor: existing.toBase58(), alreadyAnchored: true, signature: null }], transactions: 0 });
        await expect(anchorParcels({ connection: chain(new Map()), payerKeypair: payer, sendAndConfirm, parcels: [{ anchorId: 'HR-1-3', metadataUri: '' }] }))
            .rejects.toMatchObject({ code: 'uri-required' });
        expect(sent).toHaveLength(0);
        const refused = vi.fn(async () => { throw new Error('refused'); });
        await expect(anchorParcels({ connection: chain(accounts), payerKeypair: payer, sendAndConfirm: refused,
            parcels: [{ anchorId: 'HR-1-1', metadataUri: uri('HR-1-1') }, { anchorId: 'HR-1-2', metadataUri: uri('HR-1-2') }] }))
            .rejects.toMatchObject({ message: 'refused', parcels: [{ anchorId: 'HR-1-1', alreadyAnchored: true }] });
    });
});
