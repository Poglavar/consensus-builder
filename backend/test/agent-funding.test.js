import { describe, expect, it, vi } from 'vitest';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { ensureBotSolFunding } from '../agents/funding.js';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const sourceWallet = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const recipientWallet = 'FoPmPhKE6bykLoumQSvygZCSJYLkxBfsqjE3ybMvSjYs';

function connectionWithBalances({ recipient = 0, source = 1 * LAMPORTS_PER_SOL, afterRecipient, afterSource, genesisHash = DEVNET_GENESIS_HASH } = {}) {
    const reads = new Map();
    const balances = new Map([
        [recipientWallet, [recipient, afterRecipient ?? recipient]],
        [sourceWallet, [source, afterSource ?? source]]
    ]);
    return {
        getGenesisHash: vi.fn(async () => genesisHash),
        getBalance: vi.fn(async (address) => {
            const key = address.toBase58();
            const sequence = balances.get(key) ?? [0];
            const index = reads.get(key) ?? 0;
            reads.set(key, index + 1);
            return sequence[Math.min(index, sequence.length - 1)];
        })
    };
}

describe('ensureBotSolFunding', () => {
    it('is a no-op unless enabled explicitly or by environment', async () => {
        const connection = connectionWithBalances({ recipient: 0 });
        const loadFunder = vi.fn();
        const sendAndConfirm = vi.fn();

        const receipt = await ensureBotSolFunding({
            connection, persona: { name: 'supporter-01', wallet: recipientWallet }, enabled: false, loadFunder, sendAndConfirm
        });

        expect(receipt).toEqual({ status: 'skipped', reason: 'disabled' });
        expect(connection.getBalance).not.toHaveBeenCalled();
        expect(loadFunder).not.toHaveBeenCalled();
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('does nothing when a configured bot already has enough SOL', async () => {
        const connection = connectionWithBalances({ recipient: 0.1 * LAMPORTS_PER_SOL });
        const loadFunder = vi.fn();
        const sendAndConfirm = vi.fn();

        const receipt = await ensureBotSolFunding({
            connection, persona: { name: 'supporter-01', wallet: recipientWallet }, enabled: true, loadFunder, sendAndConfirm
        });

        expect(receipt).toMatchObject({ status: 'skipped', reason: 'sufficient-balance', wallet: recipientWallet });
        expect(loadFunder).not.toHaveBeenCalled();
        expect(sendAndConfirm).not.toHaveBeenCalled();
        expect(connection.getGenesisHash).not.toHaveBeenCalled();
    });

    it('tops a configured wallet up to 0.2 SOL with the exact shortfall', async () => {
        const connection = connectionWithBalances({
            recipient: 0.01 * LAMPORTS_PER_SOL,
            source: 1 * LAMPORTS_PER_SOL,
            afterRecipient: 0.2 * LAMPORTS_PER_SOL,
            afterSource: 0.8 * LAMPORTS_PER_SOL
        });
        const funder = { publicKey: new PublicKey(sourceWallet) };
        const loadFunder = vi.fn(async () => funder);
        const sendAndConfirm = vi.fn(async (_connection, transaction, signers, options) => {
            expect(transaction.instructions).toHaveLength(1);
            expect(transaction.instructions[0].keys[0].pubkey.toBase58()).toBe(sourceWallet);
            expect(transaction.instructions[0].keys[1].pubkey.toBase58()).toBe(recipientWallet);
            expect(transaction.instructions[0].data.readBigUInt64LE(4)).toBe(190_000_000n);
            expect(signers).toEqual([funder]);
            expect(options).toEqual({ commitment: 'confirmed' });
            return 'signature-example';
        });

        const receipt = await ensureBotSolFunding({
            connection, persona: { name: 'supporter-01', wallet: recipientWallet }, enabled: true, loadFunder, sendAndConfirm
        });

        expect(loadFunder).toHaveBeenCalledTimes(1);
        expect(sendAndConfirm).toHaveBeenCalledTimes(1);
        expect(connection.getGenesisHash).toHaveBeenCalledTimes(1);
        expect(connection.getBalance).toHaveBeenCalledTimes(4);
        expect(receipt).toMatchObject({
            status: 'funded', wallet: recipientWallet, sourceWallet, amountLamports: 190_000_000,
            signature: 'signature-example', balanceLamports: 0.2 * LAMPORTS_PER_SOL
        });
    });

    it('refuses a top-up that would breach the source reserve without loading its signer', async () => {
        const connection = connectionWithBalances({ recipient: 0.01 * LAMPORTS_PER_SOL, source: 0.6 * LAMPORTS_PER_SOL });
        const loadFunder = vi.fn();
        const sendAndConfirm = vi.fn();

        await expect(ensureBotSolFunding({
            connection, persona: { name: 'supporter-01', wallet: recipientWallet }, enabled: true, loadFunder, sendAndConfirm
        })).rejects.toThrow(sourceWallet);

        expect(loadFunder).not.toHaveBeenCalled();
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('requires the exact devnet genesis before loading or sending', async () => {
        const connection = connectionWithBalances({ recipient: 0.01 * LAMPORTS_PER_SOL, genesisHash: 'not-devnet' });
        const loadFunder = vi.fn();
        const sendAndConfirm = vi.fn();

        await expect(ensureBotSolFunding({
            connection, persona: { name: 'supporter-01', wallet: recipientWallet }, enabled: true, loadFunder, sendAndConfirm
        })).rejects.toThrow(/restricted to Solana devnet/);

        expect(loadFunder).not.toHaveBeenCalled();
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('rejects unknown personas and wallet mismatches without sending', async () => {
        const connection = connectionWithBalances();
        const sendAndConfirm = vi.fn();
        const args = { connection, enabled: true, sendAndConfirm };

        await expect(ensureBotSolFunding({ ...args, persona: { name: 'not-a-bot', wallet: recipientWallet } }))
            .rejects.toThrow(/configured bot wallets/);
        await expect(ensureBotSolFunding({ ...args, persona: { name: 'supporter-01', wallet: sourceWallet } }))
            .rejects.toThrow(/configured bot wallets/);
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('never transfers from the source wallet to itself', async () => {
        const connection = connectionWithBalances();
        const loadFunder = vi.fn();
        const sendAndConfirm = vi.fn();

        const receipt = await ensureBotSolFunding({
            connection, persona: { name: 'densifier-01', wallet: sourceWallet }, enabled: true, loadFunder, sendAndConfirm
        });

        expect(receipt).toMatchObject({ status: 'skipped', reason: 'source-wallet', wallet: sourceWallet });
        expect(connection.getBalance).not.toHaveBeenCalled();
        expect(loadFunder).not.toHaveBeenCalled();
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('recognizes a configured lens wallet without trusting a caller-provided name', async () => {
        const connection = connectionWithBalances({ recipient: 0.1 * LAMPORTS_PER_SOL });
        await expect(ensureBotSolFunding({ connection, persona: { wallet: recipientWallet }, enabled: true }))
            .resolves.toMatchObject({ reason: 'sufficient-balance' });
        await expect(ensureBotSolFunding({ connection, persona: { wallet: 'not-configured' }, enabled: true }))
            .rejects.toThrow(/configured bot wallets/);
    });

    it('refuses missing or invalid balances before loading a signer', async () => {
        const loadFunder = vi.fn();
        const sendAndConfirm = vi.fn();
        for (const balance of [null, undefined, NaN, -1, 1.5]) {
            const connection = { getBalance: async () => balance };
            await expect(ensureBotSolFunding({ connection, persona: 'supporter-01', enabled: true, loadFunder, sendAndConfirm }))
                .rejects.toThrow(/Invalid wallet balance/);
        }
        expect(loadFunder).not.toHaveBeenCalled();
        expect(sendAndConfirm).not.toHaveBeenCalled();
    });

    it('rejects a mismatched funding signer and a missing balance readback', async () => {
        const connection = connectionWithBalances({ recipient: 0, source: 1 * LAMPORTS_PER_SOL });
        const sendAndConfirm = vi.fn(async () => 'signature-example');
        await expect(ensureBotSolFunding({ connection, persona: 'supporter-01', enabled: true,
            loadFunder: async () => ({ publicKey: new PublicKey(recipientWallet) }), sendAndConfirm }))
            .rejects.toThrow(/signer does not match/);
        expect(sendAndConfirm).not.toHaveBeenCalled();
        await expect(ensureBotSolFunding({ connection: connectionWithBalances({ recipient: 0, source: 1 * LAMPORTS_PER_SOL }),
            persona: 'supporter-01', enabled: true, loadFunder: async () => ({ publicKey: new PublicKey(sourceWallet) }), sendAndConfirm }))
            .rejects.toThrow(/confirmed, but .* remains below/);
    });
});
