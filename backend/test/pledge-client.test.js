// Covers the shared proposal_pledge instruction and account codec.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const pledge = require('../../frontend/js/solana/pledge-client.js');
pledge.configure({ web3 });

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/proposal_pledge.json'), 'utf8'));
const proposal = web3.Keypair.generate().publicKey;
const wallet = web3.Keypair.generate().publicKey;
const beneficiary = web3.Keypair.generate().publicKey;
const pledgeId = Uint8Array.from({ length: 32 }, (_, i) => i);

function instruction(name) { return IDL.instructions.find(ix => ix.name === name); }
function flags(name) {
    return instruction(name).accounts.map(account => ({
        name: account.name, signer: Boolean(account.signer), writable: Boolean(account.writable)
    }));
}
function actual(ix, name) {
    return ix.keys.map((account, i) => ({
        name: flags(name)[i].name, signer: account.isSigner, writable: account.isWritable
    }));
}
function discriminator(prefix, name) {
    return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8));
}

afterEach(() => pledge.configure({ web3, programId: null }));

describe('proposal pledge codec', () => {
    it('pins every discriminator and the program id to the generated IDL', () => {
        expect(pledge.constants.PROGRAM_ID).toBe(IDL.address);
        for (const ix of IDL.instructions) {
            expect(Array.from(pledge.IX_DISCRIMINATORS[ix.name])).toEqual(ix.discriminator);
            expect(ix.discriminator).toEqual(discriminator('global', ix.name));
        }
        for (const account of IDL.accounts) {
            expect(Array.from(pledge.ACCOUNT_DISCRIMINATORS[account.name])).toEqual(account.discriminator);
            expect(account.discriminator).toEqual(discriminator('account', account.name));
        }
    });

    it('derives escrow, position and backer PDAs from the documented seeds', () => {
        const [escrow] = pledge.getEscrowPda(proposal);
        const [expectedEscrow] = web3.PublicKey.findProgramAddressSync(
            [Buffer.from('escrow'), proposal.toBytes()], new web3.PublicKey(IDL.address)
        );
        expect(escrow.toBase58()).toBe(expectedEscrow.toBase58());
        expect(pledge.getPositionPda(escrow, wallet, pledgeId)[0].toBase58()).toBe(
            web3.PublicKey.findProgramAddressSync(
                [Buffer.from('pledge'), escrow.toBytes(), wallet.toBytes(), pledgeId],
                new web3.PublicKey(IDL.address)
            )[0].toBase58()
        );
        expect(pledge.getBackerPda(escrow, wallet)[0].toBase58()).toBe(
            web3.PublicKey.findProgramAddressSync(
                [Buffer.from('backer'), escrow.toBytes(), wallet.toBytes()],
                new web3.PublicKey(IDL.address)
            )[0].toBase58()
        );
    });

    it('builds all instructions in IDL account order with exact signer/writable flags', () => {
        const builders = {
            create_escrow: pledge.buildCreateEscrowIx({ proposal, creator: wallet }),
            pledge: pledge.buildPledgeIx({ proposal, pledger: wallet, pledgeId, amount: 250000n }),
            release: pledge.buildReleaseIx({ proposal, beneficiary, releaser: wallet }),
            refund: pledge.buildRefundIx({ proposal, pledger: wallet, pledgeId })
        };
        for (const [name, ix] of Object.entries(builders)) {
            expect(ix.programId.toBase58(), name).toBe(IDL.address);
            expect(actual(ix, name), name).toEqual(flags(name));
            expect(Array.from(ix.data.slice(0, 8)), name).toEqual(pledge.IX_DISCRIMINATORS[name]);
        }
        expect(Array.from(builders.pledge.data.slice(8, 40))).toEqual(Array.from(pledgeId));
        expect(Buffer.from(builders.pledge.data).readBigUInt64LE(40)).toBe(250000n);
    });

    it('decodes totals and exact bigint counts from an Escrow account', () => {
        const [escrow] = pledge.getEscrowPda(proposal);
        const vault = pledge.getAssociatedTokenAddress(escrow, pledge.constants.USDC_DEVNET_MINT);
        const data = Buffer.alloc(pledge.ESCROW_SIZE);
        Buffer.from(pledge.ACCOUNT_DISCRIMINATORS.Escrow).copy(data, 0);
        proposal.toBuffer().copy(data, 8);
        beneficiary.toBuffer().copy(data, 40);
        new web3.PublicKey(pledge.constants.USDC_DEVNET_MINT).toBuffer().copy(data, 72);
        vault.toBuffer().copy(data, 104);
        data.writeBigUInt64LE(1250000n, 136);
        data.writeBigUInt64LE(0n, 144);
        data.writeBigUInt64LE(250000n, 152);
        data.writeBigUInt64LE(3n, 160);
        data.writeBigUInt64LE(2n, 168);
        data.writeUInt8(0, 176);
        data.writeUInt8(254, 177);
        expect(pledge.decodeEscrow(data)).toMatchObject({
            proposal: proposal.toBase58(), beneficiary: beneficiary.toBase58(),
            totalPledged: 1250000n, totalRefunded: 250000n,
            pledgeCount: 3n, backerCount: 2n, released: false, bump: 254
        });
    });

    it('parses and formats USDC without floating-point arithmetic', () => {
        expect(pledge.parseUsdc('0.000001')).toBe(1n);
        expect(pledge.parseUsdc('12.5')).toBe(12500000n);
        expect(pledge.formatUsdc(12500000n)).toBe('12.5');
        expect(() => pledge.parseUsdc('0.0000001')).toThrow(/at most 6/);
        expect(() => pledge.buildPledgeIx({ proposal, pledger: wallet, pledgeId, amount: 0n })).toThrow(/positive/);
    });
});
