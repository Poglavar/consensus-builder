import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { DEVNET_GENESIS_HASH, PROPOSAL_PROGRAM_ID, MARKET_PROGRAM_ID } from '../oracle/proposal-lifecycle.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';

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

vi.mock('../agents/lifecycle-actions.js', () => ({
    claimProposalMarket: vi.fn(),
    decodeProposalState: vi.fn(),
    resolveProposalMarket: vi.fn(),
    revokePledge: vi.fn()
}));
vi.mock('../routes/proposals.js', () => ({ EFFECTIVE_STATUS_SQL: 'lifecycle_status', normalizeCityCode: value => value }));

const { defaultMarketReader, defaultProposalStatusReader, DEVNET_USDC_MINT } = await import('../routes/markets.js');
const { decodeProposalState } = await import('../agents/lifecycle-actions.js');
const { readAccounts: readSocietyAccounts } = await import('../agents/society-run.mjs');
const proposalInfo = () => ({
    owner: new PublicKey(PROPOSAL_PROGRAM_ID),
    data: createHash('sha256').update('account:Proposal').digest().subarray(0, 8)
});

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
        vi.mocked(decodeProposalState).mockReturnValue({ status: 0 });
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

    it.each([
        ['markets', defaultMarketReader],
        ['proposal statuses', defaultProposalStatusReader]
    ])('uses the configured bound in the markets API %s reader', async (_name, makeReader) => {
        const accounts = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
        const reader = makeReader({ SOLANA_RPC_MAX_ACCOUNTS: '5', SOLANA_RPC_URL: 'https://rpc.invalid' });
        if (_name === 'proposal statuses') rpcState.accountInfo = proposalInfo();

        await reader(accounts);

        expect(rpcCalls.map(({ addresses }) => addresses.length)).toEqual([5, 5, 2]);
        expect(rpcCalls.every(({ commitment }) => commitment === 'confirmed')).toBe(true);
    });

    it.each([
        ['markets', defaultMarketReader], ['proposal statuses', defaultProposalStatusReader]
    ])('refuses a non-devnet RPC before reading %s', async (_name, makeReader) => {
        rpcState.genesisHash = 'different-network';
        await expect(makeReader({ SOLANA_RPC_URL: 'https://rpc.invalid' })([Keypair.generate().publicKey.toBase58()])).rejects.toThrow('require Solana devnet');
        expect(rpcCalls).toEqual([]);
    });

    it('accepts only a readable proposal owned by the configured program with the correct discriminator', async () => {
        const account = Keypair.generate().publicKey.toBase58();
        const read = defaultProposalStatusReader({ SOLANA_RPC_URL: 'https://rpc.invalid' });
        for (const info of [null, { ...proposalInfo(), owner: new PublicKey(MARKET_PROGRAM_ID) }, { ...proposalInfo(), data: Buffer.alloc(8) }]) {
            rpcState.accountInfo = info;
            await expect(read([account])).rejects.toThrow(/missing|program|not a Proposal/);
        }
        rpcState.accountInfo = proposalInfo();
        vi.mocked(decodeProposalState).mockReturnValueOnce({ status: 99 });
        await expect(read([account])).rejects.toThrow('unknown lifecycle');
        await expect(read([account])).resolves.toEqual(new Map([[account, 'Active']]));
    });

    it('verifies the market program, proposal and stake mint before exposing a pool', async () => {
        const account = Keypair.generate().publicKey.toBase58();
        const other = Keypair.generate().publicKey.toBase58();
        const read = defaultMarketReader({ SOLANA_RPC_URL: 'https://rpc.invalid' });
        for (const info of [
            { ...marketInfo(account), owner: new PublicKey(PROPOSAL_PROGRAM_ID) },
            marketInfo(other), marketInfo(account, other)
        ]) {
            rpcState.accountInfo = info;
            await expect(read([account])).rejects.toThrow(/program|proposal or stake mint/);
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
