// Tests for agents/solana-send.js — HTTP-polling confirmation that does not need signatureSubscribe.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { getBase58Decoder } from '@solana/kit';
import { sendAndConfirmPolling } from '../agents/solana-send.js';


function freshTransaction(payer) {
    return new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
}

function stubConnection({ statuses, heights = [100], lastValidBlockHeight = 150, sendErrors = [] }) {
    const statusQueue = [...statuses];
    const heightQueue = [...heights];
    const calls = { sent: 0, statusPolls: 0, blockhashReads: 0, raws: [], signature: null };
    return {
        calls,
        async getLatestBlockhash() {
            calls.blockhashReads += 1;
            return { blockhash: 'EkSnNWid2cvTEVbDLv8dDhJx1VKrBadfpQVCGkPqJZKq', lastValidBlockHeight };
        },
        async sendRawTransaction(raw) {
            calls.sent += 1;
            expect(raw).toBeInstanceOf(Buffer);
            calls.raws.push(Buffer.from(raw));
            calls.signature = getBase58Decoder().decode(Transaction.from(raw).signature);
            if (sendErrors[calls.sent - 1]) throw sendErrors[calls.sent - 1];
            return calls.signature;
        },
        async getSignatureStatuses(sigs, options) {
            calls.statusPolls += 1;
            expect(sigs).toEqual([calls.signature]);
            expect(options).toEqual({ searchTransactionHistory: true });
            return { value: [statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0]] };
        },
        async getBlockHeight() {
            return heightQueue.length > 1 ? heightQueue.shift() : heightQueue[0];
        }
    };
}

describe('sendAndConfirmPolling', () => {
    it('signs, sends once and returns the signature when the status reaches confirmed', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [null, { confirmationStatus: 'processed' }, { confirmationStatus: 'confirmed' }] });

        const signature = await sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 });

        expect(signature).toBe(connection.calls.signature);
        expect(connection.calls.sent).toBe(1);
        expect(connection.calls.statusPolls).toBe(3);
    });

    it('accepts finalized as reaching confirmed', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [{ confirmationStatus: 'finalized' }] });
        const signature = await sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 });
        expect(signature).toBe(connection.calls.signature);
    });

    it('surfaces an on-chain failure instead of waiting', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }] });
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 })).rejects.toThrow(/failed on chain/);
    });

    it('reports expiry only after a final status check past the last valid block height', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [null], heights: [151], lastValidBlockHeight: 150 });
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 })).rejects.toThrow(/expired/);
        expect(connection.calls.statusPolls).toBe(2);
    });

    it('does not call a transaction expired when the last look finds it confirmed', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [null, { confirmationStatus: 'confirmed' }], heights: [151], lastValidBlockHeight: 150 });
        const signature = await sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 });
        expect(signature).toBe(connection.calls.signature);
    });

    it('gives up after maxMs with the last known status in the message', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [{ confirmationStatus: 'processed' }], heights: [100], lastValidBlockHeight: 150 });
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1, maxMs: 0 })).rejects.toThrow(/not confirmed after 0 ms \(status processed\)/);
        vi.useRealTimers();
    });

    it('refuses to send without a signer', async () => {
        const payer = Keypair.generate();
        await expect(sendAndConfirmPolling(stubConnection({ statuses: [null] }), freshTransaction(payer), [])).rejects.toThrow(/signer/);
    });

    it('recovers a lost submission response by checking the locally derived signature', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [{ confirmationStatus: 'confirmed' }],
            sendErrors: [new Error('fetch failed')] });
        const signature = await sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 });
        expect(signature).toBe(connection.calls.signature);
        expect(connection.calls.sent).toBe(1);
    });

    it('rebroadcasts identical bytes after a transient send failure, without re-signing', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [null, null, { confirmationStatus: 'confirmed' }],
            sendErrors: [new Error('503 Service Unavailable')] });
        await sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1, rebroadcastMs: 0 });
        expect(connection.calls.sent).toBe(3);
        expect(connection.calls.blockhashReads).toBe(1);
        expect(connection.calls.raws.every(raw => raw.equals(connection.calls.raws[0]))).toBe(true);
    });

    it('does not rebroadcast a processed transaction while waiting for confirmation', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [{ confirmationStatus: 'processed' }, { confirmationStatus: 'confirmed' }] });
        await sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1, rebroadcastMs: 0 });
        expect(connection.calls.sent).toBe(1);
    });

    it('fails deterministic preflight errors without resubmitting them', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [null], sendErrors: [new Error('simulation failed: insufficient funds')] });
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1, rebroadcastMs: 0 }))
            .rejects.toThrow(/insufficient funds/);
        expect(connection.calls.sent).toBe(1);
    });

    it('never mistakes an on-chain error in the last expiry check for success', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [null, { confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } }], heights: [151] });
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 }))
            .rejects.toThrow(/failed on chain/);
        expect(connection.calls.sent).toBe(1);
    });

    it('stops after the broadcast budget without refreshing the blockhash', async () => {
        let clock = 0;
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [null], sendErrors: Array(3).fill(new Error('fetch failed')) });
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], {
            pollMs: 1, rebroadcastMs: 0, maxMs: 10, now: () => clock, wait: async ms => { clock += ms; }
        })).rejects.toThrow(/not confirmed/);
        expect(connection.calls.sent).toBe(3);
        expect(connection.calls.blockhashReads).toBe(1);
    });
});
