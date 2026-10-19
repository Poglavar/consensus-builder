// Covers the shared proposal donation/pledge instruction and account codec.
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
const proposal = web3.Keypair.generate().publicKey;
const wallet = web3.Keypair.generate().publicKey;
const beneficiary = web3.Keypair.generate().publicKey;
const donationId = Uint8Array.from({ length: 32 }, (_, index) => index);

function instruction(name) { return IDL.instructions.find(ix => ix.name === name); }
function flags(name) { return instruction(name).accounts.map(account => ({ name: account.name, signer: Boolean(account.signer), writable: Boolean(account.writable) })); }
function actual(ix, name) { return ix.keys.map((account, index) => ({ name: flags(name)[index].name, signer: account.isSigner, writable: account.isWritable })); }
function discriminator(prefix, name) { return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8)); }

afterEach(() => support.configure({ web3, programId: null }));

describe('proposal support codec', () => {
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

    it('parses USDC without floating-point arithmetic', () => {
        expect(support.parseUsdc('0.000001')).toBe(1n);
        expect(support.formatUsdc(12500000n)).toBe('12.5');
        expect(() => support.parseUsdc('0.0000001')).toThrow(/at most 6/);
        expect(() => support.buildSetPledgeIx({ proposal, pledger: wallet, amount: 0n })).toThrow(/positive/);
    });
});
