// Covers the donation/pledge instruction and account codec (frontend/js/solana/pledge-client.js) on
// agreements: its `proposal` option, argument and decoded field are the agreement account, the subject
// the proposal_pledge program checks (the program keeps its proposal names until a deploy renames it).
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const support = require('../../frontend/js/solana/pledge-client.js');
support.configure({ web3 });
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/proposal_pledge.json'), 'utf8'));
// The subject: an agreement account, which the codec takes as `proposal`.
const proposal = web3.Keypair.generate().publicKey;
const wallet = web3.Keypair.generate().publicKey;
const beneficiary = web3.Keypair.generate().publicKey;
const other = web3.Keypair.generate().publicKey;
const donationId = Uint8Array.from({ length: 32 }, (_, index) => index);
const program = new web3.PublicKey(support.constants.PROGRAM_ID);
const mint = new web3.PublicKey(support.constants.USDC_DEVNET_MINT);

function instruction(name) { return IDL.instructions.find(ix => ix.name === name); }
function flags(name) { return instruction(name).accounts.map(account => ({ name: account.name, signer: Boolean(account.signer), writable: Boolean(account.writable) })); }
function actual(ix, name) { return ix.keys.map((account, index) => ({ name: flags(name)[index].name, signer: account.isSigner, writable: account.isWritable })); }
function discriminator(prefix, name) { return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8)); }
function account(name, size) {
    const data = Buffer.alloc(size);
    Buffer.from(support.ACCOUNT_DISCRIMINATORS[name]).copy(data, 0);
    return data;
}
function escrowData({ proposal: proposalKey = proposal, mint: mintKey = mint } = {}) {
    const data = account('DonationEscrow', support.DONATION_ESCROW_SIZE);
    proposalKey.toBuffer().copy(data, 8); beneficiary.toBuffer().copy(data, 40); mintKey.toBuffer().copy(data, 72);
    support.getAssociatedTokenAddress(support.getDonationEscrowPda(proposal)[0], mint).toBuffer().copy(data, 104);
    return data;
}
function pledgeBookData({ proposal: proposalKey = proposal, mint: mintKey = mint } = {}) {
    const data = account('PledgeBook', support.PLEDGE_BOOK_SIZE);
    proposalKey.toBuffer().copy(data, 8); beneficiary.toBuffer().copy(data, 40); mintKey.toBuffer().copy(data, 72);
    return data;
}
function commitmentData({ book: bookKey, proposal: proposalKey = proposal, owner: ownerKey = wallet } = {}) {
    const data = account('PledgeCommitment', support.PLEDGE_COMMITMENT_SIZE);
    bookKey.toBuffer().copy(data, 8); proposalKey.toBuffer().copy(data, 40); ownerKey.toBuffer().copy(data, 72);
    data.writeBigUInt64LE(900000n, 104); data.writeUInt8(support.constants.PLEDGE_ACTIVE, 112);
    data.writeUInt8(1, 113); data.writeUInt8(253, 114);
    return data;
}
function donationPositionData({ escrow: escrowKey, owner: ownerKey = wallet } = {}) {
    const data = account('DonationPosition', support.DONATION_POSITION_SIZE);
    escrowKey.toBuffer().copy(data, 8); ownerKey.toBuffer().copy(data, 40); Buffer.from(donationId).copy(data, 72);
    data.writeBigUInt64LE(125000n, 104); data.writeUInt8(0, 112); data.writeUInt8(254, 113);
    return data;
}
function accountInfo(data, owner = program) { return { data, owner }; }

afterEach(() => support.configure({ web3, programId: null }));

describe('agreement support codec (proposal_pledge)', () => {
    it('pins every discriminator and program id to the generated IDL', () => {
        expect(support.constants.PROGRAM_ID).toBe(IDL.address);
        for (const ix of IDL.instructions) {
            expect(Array.from(support.IX_DISCRIMINATORS[ix.name])).toEqual(ix.discriminator);
            expect(ix.discriminator).toEqual(discriminator('global', ix.name));
        }
        for (const account of IDL.accounts) {
            expect(Array.from(support.ACCOUNT_DISCRIMINATORS[account.name])).toEqual(account.discriminator);
            expect(account.discriminator).toEqual(discriminator('account', account.name));
        }
    });

    it('derives independent donation and pledge PDAs', () => {
        const program = new web3.PublicKey(IDL.address);
        const [escrow] = support.getDonationEscrowPda(proposal);
        expect(escrow.equals(web3.PublicKey.findProgramAddressSync([Buffer.from('donation_escrow'), proposal.toBytes()], program)[0])).toBe(true);
        expect(support.getDonationPositionPda(escrow, wallet, donationId)[0].equals(
            web3.PublicKey.findProgramAddressSync([Buffer.from('donation'), escrow.toBytes(), wallet.toBytes(), donationId], program)[0]
        )).toBe(true);
        const [book] = support.getPledgeBookPda(proposal);
        expect(book.equals(web3.PublicKey.findProgramAddressSync([Buffer.from('pledge_book'), proposal.toBytes()], program)[0])).toBe(true);
        expect(support.getPledgeCommitmentPda(book, wallet)[0].equals(
            web3.PublicKey.findProgramAddressSync([Buffer.from('pledge'), book.toBytes(), wallet.toBytes()], program)[0]
        )).toBe(true);
    });

    it('builds every instruction in IDL account order with exact flags', () => {
        const builders = {
            create_donation_escrow: support.buildCreateDonationEscrowIx({ proposal, creator: wallet }),
            donate: support.buildDonateIx({ proposal, donor: wallet, donationId, amount: 250000n }),
            release_donations: support.buildReleaseDonationsIx({ proposal, beneficiary, releaser: wallet }),
            refund_donation: support.buildRefundDonationIx({ proposal, donor: wallet, donationId }),
            create_pledge_book: support.buildCreatePledgeBookIx({ proposal, creator: wallet }),
            set_pledge: support.buildSetPledgeIx({ proposal, pledger: wallet, amount: 750000n }),
            revoke_pledge: support.buildRevokePledgeIx({ proposal, pledger: wallet }),
            fulfill_pledge: support.buildFulfillPledgeIx({ proposal, pledger: wallet, beneficiary }),
            void_pledge: support.buildVoidPledgeIx({ proposal, pledger: wallet })
        };
        for (const [name, ix] of Object.entries(builders)) {
            expect(ix.programId.toBase58(), name).toBe(IDL.address);
            expect(actual(ix, name), name).toEqual(flags(name));
            expect(Array.from(ix.data.slice(0, 8)), name).toEqual(support.IX_DISCRIMINATORS[name]);
        }
        expect(Buffer.from(builders.donate.data).readBigUInt64LE(40)).toBe(250000n);
        expect(Buffer.from(builders.set_pledge.data).readBigUInt64LE(8)).toBe(750000n);
    });

    it('decodes funded donation totals and a soft pledge commitment', () => {
        const [escrow] = support.getDonationEscrowPda(proposal);
        const vault = support.getAssociatedTokenAddress(escrow, support.constants.USDC_DEVNET_MINT);
        const data = Buffer.alloc(support.DONATION_ESCROW_SIZE);
        Buffer.from(support.ACCOUNT_DISCRIMINATORS.DonationEscrow).copy(data, 0);
        proposal.toBuffer().copy(data, 8); beneficiary.toBuffer().copy(data, 40);
        new web3.PublicKey(support.constants.USDC_DEVNET_MINT).toBuffer().copy(data, 72); vault.toBuffer().copy(data, 104);
        data.writeBigUInt64LE(1250000n, 136); data.writeBigUInt64LE(0n, 144); data.writeBigUInt64LE(250000n, 152);
        data.writeBigUInt64LE(3n, 160); data.writeBigUInt64LE(2n, 168); data.writeUInt8(0, 176); data.writeUInt8(254, 177);
        expect(support.decodeDonationEscrow(data)).toMatchObject({ totalDonated: 1250000n, totalRefunded: 250000n, donationCount: 3n, donorCount: 2n, released: false });

        const [book] = support.getPledgeBookPda(proposal);
        const commitment = Buffer.alloc(support.PLEDGE_COMMITMENT_SIZE);
        Buffer.from(support.ACCOUNT_DISCRIMINATORS.PledgeCommitment).copy(commitment, 0);
        book.toBuffer().copy(commitment, 8); proposal.toBuffer().copy(commitment, 40); wallet.toBuffer().copy(commitment, 72);
        commitment.writeBigUInt64LE(900000n, 104); commitment.writeUInt8(support.constants.PLEDGE_ACTIVE, 112);
        commitment.writeUInt8(1, 113); commitment.writeUInt8(253, 114);
        expect(support.decodePledgeCommitment(commitment)).toMatchObject({ amount: 900000n, status: 0, initialized: true, bump: 253 });
    });

    it('reads donation escrow and pledge book only when program, proposal, and devnet USDC match', async () => {
        const [escrow] = support.getDonationEscrowPda(proposal);
        const [book] = support.getPledgeBookPda(proposal);
        const infos = new Map([
            [escrow.toBase58(), accountInfo(escrowData())],
            [book.toBase58(), accountInfo(pledgeBookData())]
        ]);
        const connection = { getAccountInfo: async address => infos.get(address.toBase58()) || null };

        expect(await support.readDonationEscrow(connection, proposal)).toMatchObject({ proposal: proposal.toBase58(), mint: mint.toBase58() });
        expect(await support.readPledgeBook(connection, proposal)).toMatchObject({ proposal: proposal.toBase58(), mint: mint.toBase58() });

        const failures = [
            ['wrong owner program', accountInfo(escrowData(), other), /belongs to another program/],
            ['wrong proposal', accountInfo(escrowData({ proposal: other })), /different proposal/],
            ['wrong mint', accountInfo(escrowData({ mint: other })), /different mint/]
        ];
        for (const [label, info, expected] of failures) {
            await expect(support.readDonationEscrow({ getAccountInfo: async () => info }, proposal), label).rejects.toThrow(expected);
        }
        const bookFailures = [
            ['wrong owner program', accountInfo(pledgeBookData(), other), /belongs to another program/],
            ['wrong proposal', accountInfo(pledgeBookData({ proposal: other })), /different proposal/],
            ['wrong mint', accountInfo(pledgeBookData({ mint: other })), /different mint/]
        ];
        for (const [label, info, expected] of bookFailures) {
            await expect(support.readPledgeBook({ getAccountInfo: async () => info }, proposal), label).rejects.toThrow(expected);
        }
    });

    it('checks a pledge commitment against the program, derived book, proposal, and owner', async () => {
        const [book] = support.getPledgeBookPda(proposal);
        const [address] = support.getPledgeCommitmentPda(book, wallet);
        const valid = accountInfo(commitmentData({ book }));
        const connection = { getAccountInfo: async key => key.equals(address) ? valid : null };
        expect(await support.readPledgeCommitment(connection, proposal, wallet)).toMatchObject({
            book: book.toBase58(), proposal: proposal.toBase58(), owner: wallet.toBase58(), amount: 900000n
        });

        const failures = [
            ['wrong owner program', accountInfo(commitmentData({ book }), other), /belongs to another program/],
            ['wrong book', accountInfo(commitmentData({ book: other })), /different book/],
            ['wrong proposal', accountInfo(commitmentData({ book, proposal: other })), /different proposal/],
            ['wrong owner', accountInfo(commitmentData({ book, owner: other })), /different owner/]
        ];
        for (const [label, info, expected] of failures) {
            await expect(support.readPledgeCommitment({ getAccountInfo: async () => info }, proposal, wallet), label).rejects.toThrow(expected);
        }
    });

    it('validates both single and listed donation positions against their escrow and owner', async () => {
        const [escrow] = support.getDonationEscrowPda(proposal);
        const [position] = support.getDonationPositionPda(escrow, wallet, donationId);
        const valid = accountInfo(donationPositionData({ escrow }));
        const single = { getAccountInfo: async key => key.equals(position) ? valid : null };
        const listed = { getProgramAccounts: async () => [{ pubkey: position, account: valid }] };

        expect(await support.readDonationPosition(single, proposal, wallet, donationId)).toMatchObject({ escrow: escrow.toBase58(), owner: wallet.toBase58(), amount: 125000n });
        expect(await support.listDonationPositions(listed, proposal, wallet)).toHaveLength(1);
        await expect(support.listDonationPositions({ getProgramAccounts: async () => [{ pubkey: position, account: {} }] }, proposal, wallet))
            .rejects.toThrow('data is unavailable');

        for (const field of ['escrow', 'owner']) {
            const badInfo = accountInfo(donationPositionData({
                escrow: field === 'escrow' ? other : escrow,
                owner: field === 'owner' ? other : wallet
            }));
            await expect(support.readDonationPosition({ getAccountInfo: async () => badInfo }, proposal, wallet, donationId))
                .rejects.toThrow(`different ${field}`);
            await expect(support.listDonationPositions({ getProgramAccounts: async () => [{ pubkey: position, account: badInfo }] }, proposal, wallet))
                .rejects.toThrow(`different ${field}`);
        }
    });

    it('parses USDC without floating-point arithmetic', () => {
        expect(support.parseUsdc('0.000001')).toBe(1n);
        expect(support.formatUsdc(12500000n)).toBe('12.5');
        expect(() => support.parseUsdc('0.0000001')).toThrow(/at most 6/);
        expect(() => support.buildSetPledgeIx({ proposal, pledger: wallet, amount: 0n })).toThrow(/positive/);
    });
});
