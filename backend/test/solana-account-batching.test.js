// SOLANA_RPC_MAX_ACCOUNTS bounds every batched account read: the shared helper, the markets API's market
// reader, the agreement index's chain reader (agreements/onchain.js) and the society runner, each over a
// fake RPC; the market reader also checks the market program, subject and stake mint before exposing a pool.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { DEVNET_GENESIS_HASH, AGREEMENT_PROGRAM_ID, createAgreementChain } from '../agreements/onchain.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';

const MARKET_PROGRAM_ID = createRequire(import.meta.url)('../../frontend/js/solana/market-client.js').constants.PROGRAM_ID;

const { rpcCalls, rpcState } = vi.hoisted(() => ({ rpcCalls: [], rpcState: {} }));

vi.mock('@solana/web3.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        Connection: class FakeConnection {
            constructor() {}

            async getGenesisHash() { return rpcState.genesisHash; }

            async getMultipleAccountsInfo(addresses, commitment) {
                rpcCalls.push({ addresses: [...addresses], commitment });
                return addresses.map(() => rpcState.accountInfo || null);
            }
        }
    };
});

const { defaultMarketReader, DEVNET_USDC_MINT } = await import('../routes/markets.js');
const { readAccounts: readSocietyAccounts } = await import('../agents/society-run.mjs');

function marketInfo(proposal, stakeMint = DEVNET_USDC_MINT) {
    const data = Buffer.alloc(123);
    createHash('sha256').update('account:Market').digest().copy(data, 0, 0, 8);
    new PublicKey(proposal).toBuffer().copy(data, 8);
    new PublicKey(stakeMint).toBuffer().copy(data, 40);
    new PublicKey(MARKET_PROGRAM_ID).toBuffer().copy(data, 72);
    return { owner: new PublicKey(MARKET_PROGRAM_ID), data };
}

describe('Solana account batching', () => {
    beforeEach(() => {
        rpcCalls.length = 0;
        rpcState.genesisHash = DEVNET_GENESIS_HASH;
        rpcState.accountInfo = null;
    });

    it('defaults to 100 and validates configured limits from 1 through 100', () => {
        expect(accountsPerRequest({})).toBe(100);
        expect(accountsPerRequest({ SOLANA_RPC_MAX_ACCOUNTS: '' })).toBe(100);
        expect(accountsPerRequest({ SOLANA_RPC_MAX_ACCOUNTS: '5' })).toBe(5);
        expect(accountsPerRequest({ SOLANA_RPC_MAX_ACCOUNTS: '1' })).toBe(1);
        expect(accountsPerRequest({ SOLANA_RPC_MAX_ACCOUNTS: '100' })).toBe(100);

        for (const value of ['0', '-1', '101', '1.5', 'abc']) {
            expect(() => accountsPerRequest({ SOLANA_RPC_MAX_ACCOUNTS: value }))
                .toThrow(/SOLANA_RPC_MAX_ACCOUNTS must be an integer from 1 to 100/);
        }
    });

    it('reads larger input sequentially in bounded batches and preserves result order, nulls, and commitment', async () => {
        const addresses = Array.from({ length: 12 }, (_, index) => `account-${index}`);
        const expected = addresses.map((_, index) => index === 2 || index === 9 ? null : { index });
        const batches = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const connection = {
            async getMultipleAccountsInfo(batch, commitment) {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                batches.push({ batch: [...batch], commitment });
                await new Promise(resolve => setTimeout(resolve, 0));
                inFlight -= 1;
                return batch.map(address => expected[Number(address.slice('account-'.length))]);
            }
        };

        const result = await getMultipleAccountsBatched(connection, addresses, {
            batchSize: accountsPerRequest({ SOLANA_RPC_MAX_ACCOUNTS: '5' })
        });

        expect(batches.map(({ batch }) => batch.length)).toEqual([5, 5, 2]);
        expect(batches.flatMap(({ batch }) => batch)).toEqual(addresses);
        expect(batches.every(({ commitment }) => commitment === 'confirmed')).toBe(true);
        expect(maxInFlight).toBe(1);
        expect(result).toEqual(expected);
    });

    it('uses the configured bound in the markets API market reader', async () => {
        const accounts = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
        const reader = defaultMarketReader({ SOLANA_RPC_MAX_ACCOUNTS: '5', SOLANA_RPC_URL: 'https://rpc.invalid' });

        const pools = await reader(accounts);

        expect(rpcCalls.map(({ addresses }) => addresses.length)).toEqual([5, 5, 2]);
        expect(rpcCalls.every(({ commitment }) => commitment === 'confirmed')).toBe(true);
        expect([...pools.keys()]).toEqual(accounts);
        expect([...pools.values()].every(entry => entry.market === null)).toBe(true);
    });

    it('refuses a non-devnet RPC before reading markets', async () => {
        rpcState.genesisHash = 'different-network';
        await expect(defaultMarketReader({ SOLANA_RPC_URL: 'https://rpc.invalid' })([Keypair.generate().publicKey.toBase58()])).rejects.toThrow('require Solana devnet');
        expect(rpcCalls).toEqual([]);
    });

    it('uses the configured bound in the agreement index\'s chain reader', async () => {
        const accounts = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
        const calls = [];
        const connection = {
            async getGenesisHash() { return DEVNET_GENESIS_HASH; },
            async getMultipleAccountsInfoAndContext(keys, commitment) {
                calls.push({ addresses: keys.map(key => key.toBase58()), commitment });
                return { context: { slot: 7 }, value: keys.map(() => null) };
            }
        };
        const rows = await createAgreementChain({ connection, env: { SOLANA_RPC_MAX_ACCOUNTS: '5' } }).readAccounts(accounts);
        expect(calls.map(({ addresses }) => addresses.length)).toEqual([5, 5, 2]);
        expect(calls.flatMap(({ addresses }) => addresses)).toEqual(accounts);
        expect(calls.every(({ commitment }) => commitment === 'confirmed')).toBe(true);
        expect(rows.map(row => row.problem)).toEqual(accounts.map(() => 'missing'));
        await expect(createAgreementChain({ connection, env: { SOLANA_RPC_MAX_ACCOUNTS: '101' } }).readAccounts(accounts)).rejects.toThrow(/SOLANA_RPC_MAX_ACCOUNTS/);
    });

    it('verifies the market program, subject and stake mint before exposing a pool', async () => {
        const account = Keypair.generate().publicKey.toBase58();
        const other = Keypair.generate().publicKey.toBase58();
        const read = defaultMarketReader({ SOLANA_RPC_URL: 'https://rpc.invalid' });
        for (const info of [
            { ...marketInfo(account), owner: new PublicKey(AGREEMENT_PROGRAM_ID) },
            marketInfo(other), marketInfo(account, other)
        ]) {
            rpcState.accountInfo = info;
            await expect(read([account])).rejects.toThrow(/Unexpected market account program|different subject or stake mint/);
        }
        rpcState.accountInfo = marketInfo(account);
        const accepted = await read([account]);
        expect(accepted.get(account).market).toMatchObject({ proposal: account, stakeMint: DEVNET_USDC_MINT });
    });

    it('uses the configured bound in the society runner', async () => {
        const addresses = Array.from({ length: 12 }, (_, index) => `account-${index}`);
        const calls = [];
        const connection = {
            async getMultipleAccountsInfo(batch, commitment) {
                calls.push({ batch: [...batch], commitment });
                return batch.map(() => null);
            }
        };

        await readSocietyAccounts(connection, addresses, { SOLANA_RPC_MAX_ACCOUNTS: '5' });

        expect(calls.map(({ batch }) => batch.length)).toEqual([5, 5, 2]);
        expect(calls.flatMap(({ batch }) => batch)).toEqual(addresses);
        expect(calls.every(({ commitment }) => commitment === 'confirmed')).toBe(true);
    });
});
