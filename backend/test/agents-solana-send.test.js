// Tests for agents/solana-send.js — HTTP-polling confirmation that does not need signatureSubscribe.
import { describe, it, expect, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { sendAndConfirmPolling } from '../agents/solana-send.js';

const SIG = '4gWNV1W4atat3eC9NQY9wWLqPMvEiKU5LsVHbyXZUNrnK5UzygpCfYbxpo7bBDT8H6oKxnph1ZwiNSt3Hcm7MT8J';

function freshTransaction(payer) {
    return new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
}

function stubConnection({ statuses, heights = [100], lastValidBlockHeight = 150 }) {
    const statusQueue = [...statuses];
    const heightQueue = [...heights];
    const calls = { sent: 0, statusPolls: 0 };
    return {
        calls,
        async getLatestBlockhash() {
            return { blockhash: 'EkSnNWid2cvTEVbDLv8dDhJx1VKrBadfpQVCGkPqJZKq', lastValidBlockHeight };
        },
        async sendRawTransaction(raw) {
            calls.sent += 1;
            expect(raw).toBeInstanceOf(Buffer);
            return SIG;
        },
        async getSignatureStatuses(sigs) {
            calls.statusPolls += 1;
            expect(sigs).toEqual([SIG]);
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

        expect(signature).toBe(SIG);
        expect(connection.calls.sent).toBe(1);
        expect(connection.calls.statusPolls).toBe(3);
    });

    it('accepts finalized as reaching confirmed', async () => {
        const payer = Keypair.generate();
        const connection = stubConnection({ statuses: [{ confirmationStatus: 'finalized' }] });
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 })).resolves.toBe(SIG);
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
        await expect(sendAndConfirmPolling(connection, freshTransaction(payer), [payer], { pollMs: 1 })).resolves.toBe(SIG);
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
});
