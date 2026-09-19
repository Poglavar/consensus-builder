// Covers the read-only API projection of funded donations and soft pledges.
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
function appFor(connection) { const app = express(); setupAgentPledgesRoute(app, { connection }); return app; }

describe('GET /agent/pledges/:proposal', () => {
    it('rejects bad addresses and returns an empty combined view', async () => {
        const app = appFor({ getAccountInfo: async () => null });
        expect((await request(app).get('/agent/pledges/nope')).status).toBe(400);
        const proposal = web3.Keypair.generate().publicKey;
        expect((await request(app).get(`/agent/pledges/${proposal}`)).body).toEqual({
            exists: false, proposal: proposal.toBase58(), donations: null, pledges: null
        });
    });

    it('returns exact string amounts for both ledgers', async () => {
        const proposal = web3.Keypair.generate().publicKey; const beneficiary = web3.Keypair.generate().publicKey;
        const [escrow] = client.getDonationEscrowPda(proposal); const [book] = client.getPledgeBookPda(proposal);
        const donation = accountData(client.DONATION_ESCROW_SIZE, client.ACCOUNT_DISCRIMINATORS.DonationEscrow);
        proposal.toBuffer().copy(donation, 8); beneficiary.toBuffer().copy(donation, 40);
        new web3.PublicKey(client.constants.USDC_DEVNET_MINT).toBuffer().copy(donation, 72);
        client.getAssociatedTokenAddress(escrow, client.constants.USDC_DEVNET_MINT).toBuffer().copy(donation, 104);
        donation.writeBigUInt64LE(1500000n, 136); donation.writeBigUInt64LE(250000n, 152); donation.writeBigUInt64LE(4n, 160); donation.writeBigUInt64LE(3n, 168);
        const pledge = accountData(client.PLEDGE_BOOK_SIZE, client.ACCOUNT_DISCRIMINATORS.PledgeBook);
        proposal.toBuffer().copy(pledge, 8); beneficiary.toBuffer().copy(pledge, 40);
        new web3.PublicKey(client.constants.USDC_DEVNET_MINT).toBuffer().copy(pledge, 72);
        pledge.writeBigUInt64LE(10000000n, 104); pledge.writeBigUInt64LE(2000000n, 112); pledge.writeBigUInt64LE(500000n, 120);
        pledge.writeBigUInt64LE(5n, 128); pledge.writeBigUInt64LE(2n, 136); pledge.writeBigUInt64LE(1n, 144);
        const app = appFor({ getAccountInfo: async address => address.equals(escrow) ? { data: donation } : address.equals(book) ? { data: pledge } : null });
        const response = await request(app).get(`/agent/pledges/${proposal}`);
        expect(response.body).toMatchObject({
            exists: true,
            donations: { totalAtomic: '1500000', totalUsdc: '1.5', refundedAtomic: '250000', donationCount: '4', donorCount: '3' },
            pledges: { activeAtomic: '10000000', activeUsdc: '10', fulfilledAtomic: '2000000', activeCount: '2' }
        });
    });
});
