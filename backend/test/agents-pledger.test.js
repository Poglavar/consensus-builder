// Covers deterministic, retry-safe pledge transaction planning for Node agents.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ensureEscrowAndPledge, pledgeIdBytes } from '../agents/pledger.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/pledge-client.js');
client.configure({ web3 });

const proposal = web3.Keypair.generate().publicKey.toBase58();

function positionAccount(escrow, owner, id, amount) {
    const data = Buffer.alloc(client.POSITION_SIZE);
    Buffer.from(client.ACCOUNT_DISCRIMINATORS.PledgePosition).copy(data, 0);
    escrow.toBuffer().copy(data, 8);
    owner.toBuffer().copy(data, 40);
    Buffer.from(id).copy(data, 72);
    data.writeBigUInt64LE(amount, 104);
    data.writeUInt8(0, 112);
    data.writeUInt8(255, 113);
    return { data };
}

describe('agent pledge adapter', () => {
    it('creates the escrow and pledge together when both accounts are absent', async () => {
        const signer = web3.Keypair.generate();
        const reads = [];
        const connection = { getAccountInfo: async address => { reads.push(address.toBase58()); return null; } };
        const sends = [];
        const sendAndConfirm = async (_connection, transaction, signers, options) => {
            sends.push({ transaction, signers, options });
            return 'pledge-signature';
        };
        const result = await ensureEscrowAndPledge({
            connection, pledgerKeypair: signer, proposalPda: proposal,
            amountAtomic: 500000n, operationId: 'agent:run-1:proposal-7', sendAndConfirm
        });
        expect(result).toMatchObject({ created: true, replayed: false, signature: 'pledge-signature' });
        expect(reads).toHaveLength(2);
        expect(sends).toHaveLength(1);
        expect(sends[0].transaction.instructions.map(ix => Array.from(ix.data.slice(0, 8)))).toEqual([
            client.IX_DISCRIMINATORS.create_escrow,
            client.IX_DISCRIMINATORS.pledge
        ]);
        expect(sends[0].signers).toEqual([signer]);
        expect(sends[0].options).toEqual({ commitment: 'confirmed' });
    });

    it('treats the same operation id and amount as an already-completed retry', async () => {
        const signer = web3.Keypair.generate();
        const id = pledgeIdBytes('stable-id');
        const [escrow] = client.getEscrowPda(proposal);
        const [position] = client.getPositionPda(escrow, signer.publicKey, id);
        const connection = {
            getAccountInfo: async address => address.equals(position)
                ? positionAccount(escrow, signer.publicKey, id, 250000n)
                : null
        };
        let sends = 0;
        const result = await ensureEscrowAndPledge({
            connection, pledgerKeypair: signer, proposalPda: proposal,
            amountAtomic: 250000n, operationId: 'stable-id',
            sendAndConfirm: async () => { sends += 1; }
        });
        expect(result).toMatchObject({ created: false, replayed: true, signature: null });
        expect(sends).toBe(0);

        await expect(ensureEscrowAndPledge({
            connection, pledgerKeypair: signer, proposalPda: proposal,
            amountAtomic: 500000n, operationId: 'stable-id'
        })).rejects.toThrow(/different pledge amount/);
    });
});
