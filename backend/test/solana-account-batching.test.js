import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';

const { rpcCalls } = vi.hoisted(() => ({ rpcCalls: [] }));

vi.mock('@solana/web3.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        Connection: class FakeConnection {
            constructor() {}

            async getMultipleAccountsInfo(addresses, commitment) {
                rpcCalls.push({ addresses: [...addresses], commitment });
                return addresses.map(() => null);
            }
        }
    };
});

vi.mock('../agents/lifecycle-actions.js', () => ({
    claimProposalMarket: vi.fn(),
    decodeProposalState: vi.fn(),
    resolveProposalMarket: vi.fn(),
    revokePledge: vi.fn()
}));
vi.mock('../routes/proposals.js', () => ({ EFFECTIVE_STATUS_SQL: 'lifecycle_status', normalizeCityCode: value => value }));

const { defaultMarketReader, defaultProposalStatusReader } = await import('../routes/markets.js');
const { readAccounts: readSocietyAccounts } = await import('../agents/society-run.mjs');

describe('Solana account batching', () => {
    beforeEach(() => { rpcCalls.length = 0; });

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

    it.each([
        ['markets', defaultMarketReader],
        ['proposal statuses', defaultProposalStatusReader]
    ])('uses the configured bound in the markets API %s reader', async (_name, makeReader) => {
        const accounts = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
        const reader = makeReader({ SOLANA_RPC_MAX_ACCOUNTS: '5', SOLANA_RPC_URL: 'https://rpc.invalid' });

        await reader(accounts);

        expect(rpcCalls.map(({ addresses }) => addresses.length)).toEqual([5, 5, 2]);
        expect(rpcCalls.every(({ commitment }) => commitment === 'confirmed')).toBe(true);
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
