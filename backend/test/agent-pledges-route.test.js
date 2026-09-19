// Covers the read-only API projection of proposal pledge escrow state.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { setupAgentPledgesRoute } from '../routes/agent-pledges.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/pledge-client.js');
client.configure({ web3 });

function appFor(connection) {
    const app = express();
    setupAgentPledgesRoute(app, { connection });
    return app;
}
function escrowAccount(proposal) {
    const beneficiary = web3.Keypair.generate().publicKey;
    const [escrow] = client.getEscrowPda(proposal);
    const vault = client.getAssociatedTokenAddress(escrow, client.constants.USDC_DEVNET_MINT);
    const data = Buffer.alloc(client.ESCROW_SIZE);
    Buffer.from(client.ACCOUNT_DISCRIMINATORS.Escrow).copy(data, 0);
    proposal.toBuffer().copy(data, 8);
    beneficiary.toBuffer().copy(data, 40);
    new web3.PublicKey(client.constants.USDC_DEVNET_MINT).toBuffer().copy(data, 72);
    vault.toBuffer().copy(data, 104);
    data.writeBigUInt64LE(1500000n, 136);
    data.writeBigUInt64LE(0n, 144);
    data.writeBigUInt64LE(250000n, 152);
    data.writeBigUInt64LE(4n, 160);
    data.writeBigUInt64LE(3n, 168);
    data.writeUInt8(0, 176);
    data.writeUInt8(255, 177);
    return { data };
}

describe('GET /agent/pledges/:proposal', () => {
    it('rejects a non-address and returns the deterministic empty escrow for a valid proposal', async () => {
        const app = appFor({ getAccountInfo: async () => null });
        expect((await request(app).get('/agent/pledges/nope')).status).toBe(400);
        const proposal = web3.Keypair.generate().publicKey;
        const response = await request(app).get(`/agent/pledges/${proposal}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            exists: false,
            proposal: proposal.toBase58(),
            escrow: client.getEscrowPda(proposal)[0].toBase58()
        });
    });

    it('returns exact string amounts and backer counts from Solana state', async () => {
        const proposal = web3.Keypair.generate().publicKey;
        const app = appFor({ getAccountInfo: async () => escrowAccount(proposal) });
        const response = await request(app).get(`/agent/pledges/${proposal}`);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            exists: true,
            proposal: proposal.toBase58(),
            totalPledgedAtomic: '1500000',
            totalPledgedUsdc: '1.5',
            totalRefundedAtomic: '250000',
            pledgeCount: '4',
            backerCount: '3',
            released: false
        });
    });
});
