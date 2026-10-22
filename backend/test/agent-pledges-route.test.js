// The read-only API projection of the funded donations and soft pledges backing an agreement
// (routes/agent-pledges.js): GET /agent/pledges/:agreementAccount reads the escrow and pledge book whose
// subject is the agreement's chain account, as exact strings, and never answers from a failed read.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { setupAgentPledgesRoute } from '../routes/agent-pledges.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/pledge-client.js');
client.configure({ web3 });

function accountData(size, discriminator) { const data = Buffer.alloc(size); Buffer.from(discriminator).copy(data); return data; }
function accountInfo(data) { return { data, owner: new web3.PublicKey(client.constants.PROGRAM_ID) }; }
function appFor(connection) { const app = express(); setupAgentPledgesRoute(app, { connection }); return app; }

describe('GET /agent/pledges/:agreementAccount', () => {
    it('rejects an address that is no public key and returns an empty combined view', async () => {
        const app = appFor({ getAccountInfo: async () => null });
        const bad = await request(app).get('/agent/pledges/nope');
        expect(bad.status).toBe(400);
        expect(bad.body.error).toMatch(/agreement account must be a Solana public key/);
        const account = web3.Keypair.generate().publicKey;
        expect((await request(app).get(`/agent/pledges/${account}`)).body).toEqual({
            exists: false, agreementAccount: account.toBase58(), donations: null, pledges: null
        });
    });

    it('returns exact string amounts for both ledgers of the agreement account', async () => {
        const account = web3.Keypair.generate().publicKey; const beneficiary = web3.Keypair.generate().publicKey;
        const [escrow] = client.getDonationEscrowPda(account); const [book] = client.getPledgeBookPda(account);
        const donation = accountData(client.DONATION_ESCROW_SIZE, client.ACCOUNT_DISCRIMINATORS.DonationEscrow);
        account.toBuffer().copy(donation, 8); beneficiary.toBuffer().copy(donation, 40);
        new web3.PublicKey(client.constants.USDC_DEVNET_MINT).toBuffer().copy(donation, 72);
        client.getAssociatedTokenAddress(escrow, client.constants.USDC_DEVNET_MINT).toBuffer().copy(donation, 104);
        donation.writeBigUInt64LE(1500000n, 136); donation.writeBigUInt64LE(250000n, 152); donation.writeBigUInt64LE(4n, 160); donation.writeBigUInt64LE(3n, 168);
        const pledge = accountData(client.PLEDGE_BOOK_SIZE, client.ACCOUNT_DISCRIMINATORS.PledgeBook);
        account.toBuffer().copy(pledge, 8); beneficiary.toBuffer().copy(pledge, 40);
        new web3.PublicKey(client.constants.USDC_DEVNET_MINT).toBuffer().copy(pledge, 72);
        pledge.writeBigUInt64LE(10000000n, 104); pledge.writeBigUInt64LE(2000000n, 112); pledge.writeBigUInt64LE(500000n, 120);
        pledge.writeBigUInt64LE(5n, 128); pledge.writeBigUInt64LE(2n, 136); pledge.writeBigUInt64LE(1n, 144);
        const app = appFor({ getAccountInfo: async address => address.equals(escrow) ? accountInfo(donation) : address.equals(book) ? accountInfo(pledge) : null });
        const response = await request(app).get(`/agent/pledges/${account}`);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            exists: true, agreementAccount: account.toBase58(),
            donations: { escrow: escrow.toBase58(), beneficiary: beneficiary.toBase58(), totalAtomic: '1500000', totalUsdc: '1.5', refundedAtomic: '250000', donationCount: '4', donorCount: '3' },
            pledges: { book: book.toBase58(), activeAtomic: '10000000', activeUsdc: '10', fulfilledAtomic: '2000000', activeCount: '2' }
        });
    });

    it('answers 502 when the chain cannot be read, and refuses an escrow of another agreement', async () => {
        const account = web3.Keypair.generate().publicKey;
        const offline = appFor({ getAccountInfo: async () => { throw new Error('RPC offline'); } });
        const down = await request(offline).get(`/agent/pledges/${account}`);
        expect(down.status).toBe(502);
        expect(down.body).toEqual({ error: 'Solana pledge state is unavailable' });
        // An escrow at this agreement's PDA that names another subject is not this agreement's support.
        const other = web3.Keypair.generate().publicKey;
        const [escrow] = client.getDonationEscrowPda(account);
        const donation = accountData(client.DONATION_ESCROW_SIZE, client.ACCOUNT_DISCRIMINATORS.DonationEscrow);
        other.toBuffer().copy(donation, 8);
        new web3.PublicKey(client.constants.USDC_DEVNET_MINT).toBuffer().copy(donation, 72);
        const mixed = appFor({ getAccountInfo: async address => (address.equals(escrow) ? accountInfo(donation) : null) });
        expect((await request(mixed).get(`/agent/pledges/${account}`)).status).toBe(502);
    });
});
