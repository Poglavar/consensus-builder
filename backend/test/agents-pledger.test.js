// Covers agent signer adapters for funded donations and unfunded pledges.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ensurePledgeBookAndSet } from '../agents/pledger.js';
import { donationIdBytes, ensureDonationEscrowAndDonate } from '../agents/donor.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/pledge-client.js');
client.configure({ web3 });
const proposal = web3.Keypair.generate().publicKey;

describe('agent proposal support adapters', () => {
    it('creates and funds an idempotent donation', async () => {
        const signer = web3.Keypair.generate(); const sent = [];
        const result = await ensureDonationEscrowAndDonate({
            connection: { getAccountInfo: async () => null }, donorKeypair: signer, proposalPda: proposal,
            amountAtomic: 500000n, operationId: 'agent:run-1:proposal-7',
            sendAndConfirm: async (_connection, transaction) => { sent.push(transaction); return 'donation-signature'; }
        });
        expect(result).toMatchObject({ created: true, replayed: false, signature: 'donation-signature' });
        expect(sent[0].instructions.map(ix => Array.from(ix.data.slice(0, 8)))).toEqual([
            client.IX_DISCRIMINATORS.create_donation_escrow, client.IX_DISCRIMINATORS.donate
        ]);
        expect(donationIdBytes('stable')).toHaveLength(32);
    });

    it('publishes a soft pledge without a token-transfer account', async () => {
        const signer = web3.Keypair.generate(); const sent = [];
        const result = await ensurePledgeBookAndSet({
            connection: { getAccountInfo: async () => null }, pledgerKeypair: signer, proposalPda: proposal,
            amountAtomic: 10000000n,
            sendAndConfirm: async (_connection, transaction) => { sent.push(transaction); return 'pledge-signature'; }
        });
        expect(result).toMatchObject({ created: true, replayed: false, signature: 'pledge-signature' });
        expect(sent[0].instructions.map(ix => Array.from(ix.data.slice(0, 8)))).toEqual([
            client.IX_DISCRIMINATORS.create_pledge_book, client.IX_DISCRIMINATORS.set_pledge
        ]);
        const setPledge = sent[0].instructions[1];
        expect(setPledge.keys).toHaveLength(5);
        expect(setPledge.keys.some(key => key.pubkey.toBase58() === client.constants.TOKEN_PROGRAM_ID)).toBe(false);
    });
});
