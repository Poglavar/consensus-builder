// Covers the agent signer adapters for funded donations and unfunded pledges (agents/donor.js,
// agents/pledger.js): their subject is the agreement's chain account, and a repeated call reads the
// chain first so it replays instead of signing twice.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { ensurePledgeBookAndSet } from '../agents/pledger.js';
import { donationIdBytes, ensureDonationEscrowAndDonate } from '../agents/donor.js';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/pledge-client.js');
client.configure({ web3 });
const agreementAccount = web3.Keypair.generate().publicKey;
const PROGRAM = new web3.PublicKey(client.constants.PROGRAM_ID);

function recorder() {
    const sent = [];
    return { sent, sendAndConfirm: async (_connection, transaction) => { sent.push(transaction); return `signature-${sent.length}`; } };
}

// A connection answering the given accounts (address → data), owned by the pledge program.
function chain(accounts = new Map()) {
    return {
        getAccountInfo: async key => {
            const data = accounts.get(key.toBase58());
            return data ? { data, owner: PROGRAM, lamports: 1, executable: false } : null;
        }
    };
}

function pledgeCommitment(owner, { amount, status }) {
    const data = Buffer.alloc(client.PLEDGE_COMMITMENT_SIZE);
    data.set(client.ACCOUNT_DISCRIMINATORS.PledgeCommitment);
    const [book] = client.getPledgeBookPda(agreementAccount);
    // book, subject (the agreement account), owner, amount, status, initialized (pledge-client decodePledgeCommitment).
    book.toBuffer().copy(data, 8);
    agreementAccount.toBuffer().copy(data, 40);
    owner.toBuffer().copy(data, 72);
    data.writeBigUInt64LE(amount, 104);
    data[112] = status;
    data[113] = 1;
    return data;
}

describe('donations on an agreement account', () => {
    it('creates the escrow and donates in one transaction, keyed by the agreement account', async () => {
        const signer = web3.Keypair.generate(); const { sent, sendAndConfirm } = recorder();
        const result = await ensureDonationEscrowAndDonate({
            connection: chain(), donorKeypair: signer, subject: agreementAccount,
            amountAtomic: 500000n, operationId: 'agent:run-1:agreement-7', sendAndConfirm
        });
        const [escrow] = client.getDonationEscrowPda(agreementAccount);
        expect(result).toMatchObject({ created: true, replayed: false, signature: 'signature-1', escrowPda: escrow.toBase58() });
        expect(sent[0].instructions.map(ix => Array.from(ix.data.slice(0, 8)))).toEqual([
            client.IX_DISCRIMINATORS.create_donation_escrow, client.IX_DISCRIMINATORS.donate
        ]);
        for (const ix of sent[0].instructions) expect(ix.keys[1].pubkey.equals(agreementAccount)).toBe(true);
        expect(Buffer.from(donationIdBytes('agent:run-1:agreement-7'))).toEqual(Buffer.from(sent[0].instructions[1].data.subarray(8, 40)));
    });

    it('refuses a missing subject or operation id before signing', async () => {
        const signer = web3.Keypair.generate(); const { sent, sendAndConfirm } = recorder();
        const base = { connection: chain(), donorKeypair: signer, amountAtomic: 1n, operationId: 'once', sendAndConfirm };
        await expect(ensureDonationEscrowAndDonate({ ...base, subject: null })).rejects.toThrow(/subject \(the agreement account\) is required/);
        await expect(ensureDonationEscrowAndDonate({ ...base, subject: agreementAccount, operationId: ' ' })).rejects.toThrow(/operationId is required/);
        expect(sent).toHaveLength(0);
    });
});

describe('soft pledges on an agreement account', () => {
    it('creates the book and sets the pledge without a token transfer', async () => {
        const signer = web3.Keypair.generate(); const { sent, sendAndConfirm } = recorder();
        const result = await ensurePledgeBookAndSet({
            connection: chain(), pledgerKeypair: signer, subject: agreementAccount, amountAtomic: 10000000n, sendAndConfirm
        });
        expect(result).toMatchObject({ created: true, replayed: false, signature: 'signature-1' });
        expect(sent[0].instructions.map(ix => Array.from(ix.data.slice(0, 8)))).toEqual([
            client.IX_DISCRIMINATORS.create_pledge_book, client.IX_DISCRIMINATORS.set_pledge
        ]);
        const setPledge = sent[0].instructions[1];
        expect(setPledge.keys).toHaveLength(5);
        expect(setPledge.keys[1].pubkey.equals(agreementAccount)).toBe(true);
        expect(setPledge.keys.some(key => key.pubkey.toBase58() === client.constants.TOKEN_PROGRAM_ID)).toBe(false);
    });

    it('replays an equal active pledge, and refuses to change a fulfilled one', async () => {
        const signer = web3.Keypair.generate(); const { sent, sendAndConfirm } = recorder();
        const [book] = client.getPledgeBookPda(agreementAccount);
        const [commitment] = client.getPledgeCommitmentPda(book, signer.publicKey);
        const active = chain(new Map([[commitment.toBase58(), pledgeCommitment(signer.publicKey, { amount: 50000n, status: client.constants.PLEDGE_ACTIVE })]]));
        expect(await ensurePledgeBookAndSet({ connection: active, pledgerKeypair: signer, subject: agreementAccount, amountAtomic: 50000n, sendAndConfirm }))
            .toMatchObject({ replayed: true, signature: null, commitmentPda: commitment.toBase58() });
        const fulfilled = chain(new Map([[commitment.toBase58(), pledgeCommitment(signer.publicKey, { amount: 50000n, status: client.constants.PLEDGE_FULFILLED })]]));
        await expect(ensurePledgeBookAndSet({ connection: fulfilled, pledgerKeypair: signer, subject: agreementAccount, amountAtomic: 70000n, sendAndConfirm }))
            .rejects.toThrow(/fulfilled pledge cannot be changed/);
        expect(sent).toHaveLength(0);
    });
});
