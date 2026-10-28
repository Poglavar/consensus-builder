// SOLANA_RPC_MAX_ACCOUNTS bounds every batched account read: the shared helper, the markets API's market
// reader, the agreement index's chain reader (agreements/onchain.js) and the society runner, each over a
// fake RPC; the market reader also checks the market program, subject and stake mint before exposing a pool.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { agreementAccountInfo } from './fixtures/agreement-account.js';
import { MARKET_LIQUIDITY, MARKET_GRACE_SECONDS } from '../markets/agreement-source.js';
import { DEVNET_GENESIS_HASH, AGREEMENT_PROGRAM_ID, createAgreementChain } from '../agreements/onchain.js';
import { accountsPerRequest, getMultipleAccountsBatched } from '../solana/account-batching.js';

const require = createRequire(import.meta.url);
const lmsrClient = require('../../frontend/js/solana/lmsr-client.js').configure({ web3: require('@solana/web3.js') });
const lmsr = require('../../frontend/js/bets/lmsr.js');
const MARKET_PROGRAM_ID = lmsrClient.constants.PROGRAM_ID;
const CID = 'bafy-test-agreement';
const DEADLINE = 1900000000;

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
                return addresses.map(address => rpcState.accounts?.get(address.toBase58()) || null);
            }
        }
    };
});

const { defaultMarketReader, DEVNET_USDC_MINT } = await import('../routes/markets.js');
const { readAccounts: readSocietyAccounts } = await import('../agents/society-run.mjs');

function marketInfo({ proposal, creator, stakeMint = DEVNET_USDC_MINT, liquidity = MARKET_LIQUIDITY, deadline = DEADLINE, grace = MARKET_GRACE_SECONDS, seed = lmsr.maxLoss(BigInt(MARKET_LIQUIDITY)) }) {
    const data = Buffer.alloc(496);
    Buffer.from(lmsrClient.ACCOUNT_DISCRIMINATORS.LmsrMarket).copy(data);
    new PublicKey(proposal).toBuffer().copy(data, 9);
    new PublicKey(creator).toBuffer().copy(data, 41);
    new PublicKey(stakeMint).toBuffer().copy(data, 73);
    data.writeBigUInt64LE(BigInt(liquidity), 137);
    data.writeBigUInt64LE(BigInt(seed), 161);
    data.writeBigInt64LE(BigInt(deadline), 169);
    data.writeUInt32LE(grace, 177);
    return { owner: new PublicKey(MARKET_PROGRAM_ID), data };
}

function indexedAgreement(account) {
    return { account, sponsor: Keypair.generate().publicKey.toBase58(), cid: CID };
}

function setAgreement(agreement, fields = {}) {
    rpcState.accounts.set(agreement.account, agreementAccountInfo({ cid: agreement.cid, authority: agreement.sponsor, deadline: DEADLINE, ...fields }));
}

function setMarket(agreement, info) {
    const address = lmsrClient.getMarketPda(agreement.account, agreement.sponsor)[0].toBase58();
    const mint = new PublicKey(info.data.subarray(73, 105));
    lmsrClient.getVaultAddress(new PublicKey(address), mint).toBuffer().copy(info.data, 105);
    rpcState.accounts.set(address, info);
}

describe('Solana account batching', () => {
    beforeEach(() => {
        rpcCalls.length = 0;
        rpcState.genesisHash = DEVNET_GENESIS_HASH;
        rpcState.accounts = new Map();
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

        const agreements = accounts.map(indexedAgreement);
        agreements.forEach(agreement => setAgreement(agreement));
        const pools = await reader(accounts, agreements);

        expect(rpcCalls.map(({ addresses }) => addresses.length)).toEqual([5, 5, 5, 5, 4]);
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

    it('requires an indexed sponsor before reading accounts', async () => {
        const account = Keypair.generate().publicKey.toBase58();
        const read = defaultMarketReader({ SOLANA_RPC_URL: 'https://rpc.invalid' });
        await expect(read([account], [{ account, cid: CID }])).rejects.toThrow('indexed agreement sponsor');
        expect(rpcCalls).toEqual([]);
    });

    it('verifies agreement identity and canonical market terms before exposing a pool', async () => {
        const account = Keypair.generate().publicKey.toBase58();
        const other = Keypair.generate().publicKey.toBase58();
        const agreement = indexedAgreement(account);
        const read = defaultMarketReader({ SOLANA_RPC_URL: 'https://rpc.invalid' });
        const valid = { proposal: account, creator: agreement.sponsor };
        setAgreement(agreement);
        setMarket(agreement, marketInfo(valid));
        expect((await read([account], [agreement])).get(account).market)
            .toMatchObject({ proposal: account, creator: agreement.sponsor, stakeMint: DEVNET_USDC_MINT });

        for (const fields of [{ cid: 'different-cid' }, { authority: other }, { status: 255 }]) {
            setAgreement(agreement, fields);
            await expect(read([account], [agreement])).rejects.toThrow(/Agreement account identity or status differs/);
        }
        setAgreement(agreement);
        for (const info of [
            { ...marketInfo(valid), owner: new PublicKey(AGREEMENT_PROGRAM_ID) },
            marketInfo({ ...valid, proposal: other }),
            marketInfo({ ...valid, creator: other }),
            marketInfo({ ...valid, stakeMint: other }),
            marketInfo({ ...valid, deadline: DEADLINE + 1 }),
            marketInfo({ ...valid, liquidity: '100000001' }),
            marketInfo({ ...valid, seed: 1 })
        ]) {
            setMarket(agreement, info);
            await expect(read([account], [agreement])).rejects.toThrow(/Unexpected market account program|market address does not match|terms differ/);
        }
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
