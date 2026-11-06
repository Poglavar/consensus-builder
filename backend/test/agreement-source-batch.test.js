// The batched agreement source (markets/agreement-source.js readAgreement.many): one index query and
// one chain snapshot per 99 agreements instead of one of each per agreement, with each agreement's
// failure kept to its own entry. The Bets world list reads ~250 agreements through it.
import { describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { createAgreementMarketSource } from '../markets/agreement-source.js';
import { AGREEMENT_PROGRAM_ID, agreementAccountOf } from '../agreements/onchain.js';
import { cidOfObject } from '../cid.js';
import { encodeAgreementAccount } from './helpers/agent-chain-fakes.js';

const SPONSOR = Keypair.generate().publicKey.toBase58();
const LENS = Keypair.generate().publicKey.toBase58();
const DEADLINE = 1_900_000_000;
const CHAIN_TIME = 1_800_000_000;

function clockInfo() {
    const data = Buffer.alloc(40);
    data.writeBigInt64LE(BigInt(CHAIN_TIME), 32);
    return { data, owner: new PublicKey('Sysvar1111111111111111111111111111111111111') };
}

function fixture(count) {
    const rows = [];
    const records = new Map();
    const accounts = [];
    for (let index = 0; index < count; index += 1) {
        const cid = cidOfObject({ schema: 'agreement/v1', title: `Agreement ${index}` });
        const account = agreementAccountOf(cid, SPONSOR);
        accounts.push(account);
        rows.push({ cid, city: 'zagreb', sponsor: SPONSOR, deadline: new Date(DEADLINE * 1000),
            onchain: { chain: 'solana', cluster: 'devnet', account } });
        records.set(account, { data: encodeAgreementAccount({ cid, authority: SPONSOR, lens: LENS, payout: SPONSOR, deadline: DEADLINE, status: 0 }),
            owner: new PublicKey(AGREEMENT_PROGRAM_ID) });
    }
    const pool = { query: vi.fn(async (_sql, [list]) => ({ rows: rows.filter(row => list.includes(row.onchain.account)) })) };
    const snapshot = vi.fn(async keys => ({ context: { slot: 7 },
        value: keys.map(key => (key.equals(SYSVAR_CLOCK_PUBKEY) ? clockInfo() : records.get(key.toBase58()) || null)) }));
    const chain = { connection: async () => ({ getMultipleAccountsInfoAndContext: snapshot }) };
    return { rows, records, accounts, pool, snapshot, read: createAgreementMarketSource(pool, { chain }) };
}

describe('createAgreementMarketSource().many', () => {
    it('reads 150 agreements with one index query and two chain snapshots of at most 100 accounts', async () => {
        const { accounts, pool, snapshot, read } = fixture(150);
        const result = await read.many(accounts);
        expect(pool.query).toHaveBeenCalledTimes(1);
        expect(snapshot).toHaveBeenCalledTimes(2);
        for (const [keys] of snapshot.mock.calls) {
            expect(keys.length).toBeLessThanOrEqual(100);
            expect(keys.at(-1).equals(SYSVAR_CLOCK_PUBKEY)).toBe(true);
        }
        expect([...result.values()].every(source => !(source instanceof Error))).toBe(true);
        expect(result.get(accounts[120])).toMatchObject({ account: accounts[120], closesAt: DEADLINE, chainTime: CHAIN_TIME, chainStatus: 'active', observedSlot: 7 });
    });

    it('keeps an unindexed or unreadable agreement to its own entry', async () => {
        const { accounts, records, rows, read } = fixture(3);
        rows.splice(0, 1);
        records.delete(accounts[1]);
        const result = await read.many(accounts);
        expect(result.get(accounts[0])).toBeInstanceOf(Error);
        expect(result.get(accounts[0]).status).toBe(404);
        expect(result.get(accounts[1]).status).toBe(503);
        expect(result.get(accounts[2])).toMatchObject({ account: accounts[2], chainStatus: 'active' });
        // The single reader throws the entry's own error.
        await expect(read(accounts[1])).rejects.toMatchObject({ status: 503 });
        await expect(read(accounts[2])).resolves.toMatchObject({ account: accounts[2] });
    });

    it('refuses a list holding anything but account addresses', async () => {
        const { accounts, read } = fixture(1);
        await expect(read.many([accounts[0], 'not-an-account'])).rejects.toMatchObject({ status: 400 });
    });
});
