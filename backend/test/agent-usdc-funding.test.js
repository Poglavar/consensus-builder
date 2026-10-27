import { describe, expect, it, vi } from 'vitest';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { BOT_USDC_MINT, ensureBotUsdcFunding, fundBotAction } from '../agents/funding.js';

const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const source = 'G4R6RCCcQHN9fLoExvTBBfhbw8BgvTEqhJezG3A1HvEg';
const recipient = 'FoPmPhKE6bykLoumQSvygZCSJYLkxBfsqjE3ybMvSjYs';
const other = '5x8hiYo9V6kWpG8eVoyXZf4BHXnKSoCP3r7r3PyMBg4z';
const signer = { publicKey: new PublicKey(source) };

function fakePool() {
    const events = [];
    const pool = { connect: vi.fn(async () => ({
        query: vi.fn(async (sql, params) => { events.push([sql, params]); return { rows: [] }; }),
        release: vi.fn((error) => { events.push(['release', error]); })
    })) };
    return { pool, events };
}

function harness({ balances = { [recipient]: 0n, [source]: 2_000_000n }, sol = LAMPORTS_PER_SOL,
    hash = genesis, send = async () => 'signature-example' } = {}) {
    const values = new Map(Object.entries(balances));
    const readBalance = vi.fn(async (_connection, wallet) => values.get(wallet));
    const connection = {
        getGenesisHash: vi.fn(async () => hash),
        getBalance: vi.fn(async () => sol)
    };
    const loadFunder = vi.fn(async () => signer);
    const sendAndConfirm = vi.fn(async (...args) => send(...args));
    const { pool, events } = fakePool();
    const args = { connection, pool, persona: 'supporter-01', requiredAtomic: 100_000n,
        enabled: true, readBalance, loadFunder, sendAndConfirm };
    return { args, values, connection, readBalance, loadFunder, sendAndConfirm, pool, events };
}

function expectUnlocked(h) {
    expect(h.events.map(([sql]) => sql)).toEqual([
        expect.stringContaining('pg_advisory_lock('),
        expect.stringContaining('pg_advisory_unlock('),
        'release'
    ]);
    expect(h.events[0][1]).toEqual([`ugt-bot-usdc:${source}`]);
    expect(h.events[1][1]).toEqual([`ugt-bot-usdc:${source}`]);
}

describe('ensureBotUsdcFunding', () => {
    it('is disabled without reading, signing or locking', async () => {
        const h = harness();
        expect(await ensureBotUsdcFunding({ ...h.args, enabled: false })).toEqual({ status: 'skipped', reason: 'disabled' });
        expect(h.readBalance).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(h.loadFunder).not.toHaveBeenCalled();
        expect(h.sendAndConfirm).not.toHaveBeenCalled();
    });

    it('accepts only configured recipients and rejects a spoofed wallet', async () => {
        const h = harness({ balances: { [recipient]: 500_000n, [source]: 2_000_000n } });
        await expect(ensureBotUsdcFunding({ ...h.args, persona: { name: 'supporter-01', wallet: source } }))
            .rejects.toThrow(/configured bot wallets/);
        await expect(ensureBotUsdcFunding({ ...h.args, persona: 'unknown-actor' }))
            .rejects.toThrow(/configured bot wallets/);
        expect(await ensureBotUsdcFunding({ ...h.args, persona: { wallet: recipient } }))
            .toMatchObject({ status: 'skipped', reason: 'sufficient-balance', wallet: recipient });
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    it('skips the source wallet and recipients with enough USDC before locking', async () => {
        const h = harness({ balances: { [recipient]: 100_000n, [source]: 2_000_000n } });
        expect(await ensureBotUsdcFunding({ ...h.args, persona: 'densifier-01' }))
            .toMatchObject({ status: 'skipped', reason: 'source-wallet', wallet: source });
        expect(await ensureBotUsdcFunding(h.args))
            .toMatchObject({ status: 'skipped', reason: 'sufficient-balance', wallet: recipient });
        expect(h.readBalance).toHaveBeenCalledTimes(1);
        expect(h.connection.getGenesisHash).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    it('requires a positive bigint action amount no greater than 500,000 atomic units', async () => {
        const h = harness();
        for (const amount of [undefined, null, 0n, -1n, 500_001n, 1, '100000']) {
            await expect(ensureBotUsdcFunding({ ...h.args, requiredAtomic: amount }))
                .rejects.toThrow(/positive action amount within its explicit cap/);
        }
        expect(h.readBalance).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
    });

    it('uses the 100,000 floor but funds when a 250,000 action exceeds a 150,000 balance', async () => {
        const h = harness({ balances: { [recipient]: 150_000n, [source]: 2_000_000n } });
        expect(await ensureBotUsdcFunding({ ...h.args, requiredAtomic: 100_000n }))
            .toMatchObject({ status: 'skipped', reason: 'sufficient-balance' });
        h.sendAndConfirm.mockImplementation(async () => {
            h.values.set(recipient, 500_000n);
            h.values.set(source, 1_650_000n);
            return 'signature-example';
        });
        const receipt = await ensureBotUsdcFunding({ ...h.args, requiredAtomic: 250_000n });
        expect(receipt).toMatchObject({ status: 'funded', amountAtomic: '350000', balanceAtomic: '500000' });
        expectUnlocked(h);
    });

    it('refuses mainnet and malformed balances before loading the key', async () => {
        const mainnet = harness({ hash: 'mainnet', balances: { [recipient]: 0n, [source]: 2_000_000n } });
        await expect(ensureBotUsdcFunding(mainnet.args)).rejects.toThrow(/restricted to Solana devnet/);
        expect(mainnet.loadFunder).not.toHaveBeenCalled();
        expect(mainnet.pool.connect).not.toHaveBeenCalled();
        for (const bad of [null, undefined, NaN, -1n, 1, '0']) {
            const h = harness({ balances: { [recipient]: bad, [source]: 2_000_000n } });
            await expect(ensureBotUsdcFunding(h.args)).rejects.toThrow(/Invalid USDC balance/);
            expect(h.loadFunder).not.toHaveBeenCalled();
            expect(h.pool.connect).not.toHaveBeenCalled();
        }
        const badSource = harness({ balances: { [recipient]: 0n, [source]: null } });
        await expect(ensureBotUsdcFunding(badSource.args)).rejects.toThrow(/Invalid USDC balance/);
        expect(badSource.loadFunder).not.toHaveBeenCalled();
        expectUnlocked(badSource);
    });

    it('tops up the exact shortfall with devnet USDC mint, correct ATAs, 6 decimals and an idempotent ATA instruction', async () => {
        const h = harness({ balances: { [recipient]: 0n, [source]: 1_700_000n } });
        h.sendAndConfirm.mockImplementation(async (_connection, transaction, signers, options) => {
            expect(signers).toEqual([signer]);
            expect(options).toEqual({ commitment: 'confirmed' });
            expect(transaction.instructions).toHaveLength(2);
            const [ata, transfer] = transaction.instructions;
            const recipientAta = getAssociatedTokenAddressSync(BOT_USDC_MINT, new PublicKey(recipient));
            const sourceAta = getAssociatedTokenAddressSync(BOT_USDC_MINT, signer.publicKey);
            expect(BOT_USDC_MINT.toBase58()).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
            expect(ata.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
            expect(ata.data[0]).toBe(1);
            expect(ata.keys.slice(0, 4).map(k => k.pubkey.toBase58()))
                .toEqual([source, recipientAta.toBase58(), recipient, BOT_USDC_MINT.toBase58()]);
            expect(transfer.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
            expect(transfer.data[0]).toBe(12);
            expect(transfer.data.readBigUInt64LE(1)).toBe(500_000n);
            expect(transfer.data[9]).toBe(6);
            expect(transfer.keys.map(k => k.pubkey.toBase58()))
                .toEqual([sourceAta.toBase58(), BOT_USDC_MINT.toBase58(), recipientAta.toBase58(), source]);
            h.values.set(recipient, 500_000n);
            h.values.set(source, 1_200_000n);
            return 'signature-example';
        });
        expect(await ensureBotUsdcFunding(h.args)).toMatchObject({ status: 'funded', wallet: recipient,
            sourceWallet: source, mint: BOT_USDC_MINT.toBase58(), amountAtomic: '500000',
            balanceAtomic: '500000', signature: 'signature-example' });
        expect(h.loadFunder).toHaveBeenCalledTimes(1);
        expect(h.connection.getBalance).toHaveBeenCalledWith(new PublicKey(source), 'confirmed');
        expectUnlocked(h);
    });

    it('preserves USDC and fee SOL reserves before signing', async () => {
        for (const sourceBalance of [1_499_999n, 1_000_000n]) {
            const h = harness({ balances: { [recipient]: 0n, [source]: sourceBalance } });
            await expect(ensureBotUsdcFunding(h.args)).rejects.toThrow(/retaining 1 test USDC/);
            expect(h.loadFunder).not.toHaveBeenCalled();
            expect(h.sendAndConfirm).not.toHaveBeenCalled();
            expectUnlocked(h);
        }
        const h = harness({ sol: 0.504 * LAMPORTS_PER_SOL });
        await expect(ensureBotUsdcFunding(h.args)).rejects.toThrow(/SOL for fees and token-account rent/);
        expect(h.loadFunder).not.toHaveBeenCalled();
        expect(h.sendAndConfirm).not.toHaveBeenCalled();
        expectUnlocked(h);
    });

    it('rejects a mismatched signer, failed send and failed readback, releasing each lock', async () => {
        const mismatch = harness();
        mismatch.loadFunder.mockResolvedValue({ publicKey: new PublicKey(recipient) });
        await expect(ensureBotUsdcFunding(mismatch.args)).rejects.toThrow(/signer does not match/);
        expect(mismatch.sendAndConfirm).not.toHaveBeenCalled();
        expectUnlocked(mismatch);

        const sendFailure = harness();
        sendFailure.sendAndConfirm.mockRejectedValue(new Error('send failed'));
        await expect(ensureBotUsdcFunding(sendFailure.args)).rejects.toThrow('send failed');
        expectUnlocked(sendFailure);
        expect(sendFailure.events[2][1]).toMatchObject({ message: 'send failed' });

        const readback = harness();
        await expect(ensureBotUsdcFunding(readback.args)).rejects.toThrow(/balance readback failed/);
        expectUnlocked(readback);

        const lockFailure = harness();
        const client = { query: vi.fn().mockRejectedValue(new Error('lock failed')), release: vi.fn() };
        lockFailure.args.pool = { connect: vi.fn(async () => client) };
        await expect(ensureBotUsdcFunding(lockFailure.args)).rejects.toThrow('lock failed');
        expect(client.query).toHaveBeenCalledTimes(1);
        expect(client.release).toHaveBeenCalledWith(expect.objectContaining({ message: 'lock failed' }));
        expect(lockFailure.loadFunder).not.toHaveBeenCalled();
    });

    it('rechecks under the lock and skips if another worker already funded the recipient', async () => {
        const h = harness();
        h.readBalance.mockImplementationOnce(async () => 0n).mockImplementationOnce(async () => 500_000n);
        expect(await ensureBotUsdcFunding(h.args)).toMatchObject({ status: 'skipped', reason: 'sufficient-balance' });
        expect(h.loadFunder).not.toHaveBeenCalled();
        expect(h.sendAndConfirm).not.toHaveBeenCalled();
        expectUnlocked(h);
    });

    it('serializes different recipients through the same source lock so the reserve cannot be overspent', async () => {
        let unlock;
        let held = false;
        const events = [];
        const pool = { connect: vi.fn(async () => ({
            query: async (sql) => {
                if (sql.includes('pg_advisory_lock(')) {
                    if (held) await new Promise(resolve => { unlock = resolve; });
                    held = true;
                    events.push('lock');
                } else if (sql.includes('pg_advisory_unlock(')) {
                    held = false;
                    events.push('unlock');
                    unlock?.();
                }
                return { rows: [] };
            },
            release: () => events.push('release')
        })) };
        const balances = new Map([[recipient, 0n], [other, 0n], [source, 1_700_000n]]);
        const readBalance = vi.fn(async (_connection, wallet) => balances.get(wallet));
        const sendAndConfirm = vi.fn(async (_connection, tx) => {
            const amount = tx.instructions[1].data.readBigUInt64LE(1);
            const targetAta = tx.instructions[1].keys[2].pubkey.toBase58();
            const target = [recipient, other].find(wallet => getAssociatedTokenAddressSync(BOT_USDC_MINT,
                new PublicKey(wallet)).toBase58() === targetAta);
            balances.set(target, balances.get(target) + amount);
            balances.set(source, balances.get(source) - amount);
            await Promise.resolve();
            return 'signature-example';
        });
        const connection = { getGenesisHash: async () => genesis, getBalance: async () => LAMPORTS_PER_SOL };
        const args = { connection, pool, enabled: true, requiredAtomic: 100_000n,
            readBalance, loadFunder: async () => signer, sendAndConfirm };
        const first = ensureBotUsdcFunding({ ...args, persona: 'supporter-01' });
        const second = ensureBotUsdcFunding({ ...args, persona: 'notary-01' });
        const results = await Promise.allSettled([first, second]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')[0].reason.message)
            .toMatch(/retaining 1 test USDC/);
        expect(sendAndConfirm).toHaveBeenCalledTimes(1);
        expect(balances.get(source)).toBe(1_200_000n);
        expect(events.filter(event => event !== 'release')).toEqual(['lock', 'unlock', 'lock', 'unlock']);
        expect(events.filter(event => event === 'release')).toHaveLength(2);
    });
});

describe('fundBotAction', () => {
    it('skips pledge, claim and revocation without balance reads, a signer or a ledger write', async () => {
        const h = harness();
        h.pool.query = vi.fn();
        for (const type of ['pledge', 'claim', 'revokePledge']) {
            expect(await fundBotAction({ ...h.args, action: { type, amount: '0.25' } }))
                .toEqual({ status: 'skipped', reason: 'no-token-spend' });
        }
        expect(h.readBalance).not.toHaveBeenCalled();
        expect(h.loadFunder).not.toHaveBeenCalled();
        expect(h.sendAndConfirm).not.toHaveBeenCalled();
        expect(h.pool.connect).not.toHaveBeenCalled();
        expect(h.pool.query).not.toHaveBeenCalled();
    });

    it('requires a run ID and a ledger query before any enabled stake or donation can read or sign', async () => {
        const h = harness();
        h.pool.query = vi.fn(async () => ({ rows: [{ id: 1 }] }));
        for (const action of [{ type: 'stake', amount: '0.25' }, { type: 'donate', amount: '0.25' }]) {
            await expect(fundBotAction({ ...h.args, action })).rejects.toThrow(/run ID and ledger pool/);
            await expect(fundBotAction({ ...h.args, action, runId: 'run-1', pool: { connect: h.pool.connect } }))
                .rejects.toThrow(/run ID and ledger pool/);
        }
        expect(h.readBalance).not.toHaveBeenCalled();
        expect(h.connection.getGenesisHash).not.toHaveBeenCalled();
        expect(h.loadFunder).not.toHaveBeenCalled();
        expect(h.sendAndConfirm).not.toHaveBeenCalled();
        expect(h.pool.query).not.toHaveBeenCalled();
    });

    it('funds a 0.25 USDC stake from 0.15 to 0.5 and checkpoints its receipt', async () => {
        const h = harness({ balances: { [recipient]: 150_000n, [source]: 2_000_000n } });
        h.pool.query = vi.fn(async () => ({ rows: [{ id: 1 }] }));
        h.sendAndConfirm.mockImplementation(async (_connection, transaction) => {
            expect(transaction.instructions[1].data.readBigUInt64LE(1)).toBe(350_000n);
            h.values.set(recipient, 500_000n);
            h.values.set(source, 1_650_000n);
            return 'signature-example';
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const receipt = await fundBotAction({ ...h.args, action: { type: 'stake', amount: '0.25' }, runId: 'run-1' });
            expect(receipt).toMatchObject({ status: 'funded', amountAtomic: '350000', balanceAtomic: '500000' });
            expect(h.pool.query).toHaveBeenCalledTimes(1);
            const [sql, params] = h.pool.query.mock.calls[0];
            expect(sql).toMatch(/UPDATE consensus\.agent_run/);
            expect(params[0]).toBe('run-1');
            expect(JSON.parse(params[3])).toEqual({ usdcFunding: receipt });
            expect(log).toHaveBeenCalledWith(expect.stringMatching(/USDC funding.*status=completed.*amountAtomic=350000.*tx=signature-example/));
            expectUnlocked(h);
        } finally {
            log.mockRestore();
        }
    });
});

it('funds a market seed only under an explicit higher cap and preserves the shared reserve', async () => {
    const h = harness({ balances: { [recipient]: 250_000n, [source]: 100_000_000n } });
    const requiredAtomic = 69_314_720n;
    await expect(ensureBotUsdcFunding({ ...h.args, requiredAtomic })).rejects.toThrow(/explicit cap/);
    expect(h.sendAndConfirm).not.toHaveBeenCalled();
    h.sendAndConfirm.mockImplementation(async (_rpc, tx) => {
        const amount = tx.instructions[1].data.readBigUInt64LE(1);
        expect(amount).toBe(requiredAtomic - 250_000n);
        h.values.set(recipient, requiredAtomic); h.values.set(source, 100_000_000n - amount);
        return 'market-funding-signature';
    });
    const receipt = await ensureBotUsdcFunding({ ...h.args, requiredAtomic, maxActionAtomic: 70_000_000n });
    expect(receipt).toMatchObject({ status: 'funded', balanceAtomic: requiredAtomic.toString() });
    expect(h.sendAndConfirm).toHaveBeenCalledTimes(1);
    expectUnlocked(h);
    expect(h.values.get(source)).toBeGreaterThan(1_000_000n);
});

it('keeps the source reserve when the funding persona seeds its own market', async () => {
    const h = harness({ balances: { [recipient]: 0n, [source]: 70_000_000n } });
    const args = { ...h.args, persona: 'densifier-01', requiredAtomic: 69_314_720n, maxActionAtomic: 70_000_000n };
    await expect(ensureBotUsdcFunding(args)).rejects.toThrow(/retaining 1 test USDC/);
    h.values.set(source, 71_000_000n);
    expect(await ensureBotUsdcFunding(args)).toMatchObject({ reason: 'source-wallet' });
    expect(h.sendAndConfirm).not.toHaveBeenCalled();
});
