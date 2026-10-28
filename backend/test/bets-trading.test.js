// Asset isolation, authenticated points identity, and durable reconciliation after uncertain writes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Trading = require('../../frontend/js/bets/bets-trading.js');

function makeStorage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
        values
    };
}

function response(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function harness({ fetch, storage = makeStorage(), agent = 'agent-a', backend = 'https://api.example', run = '' } = {}) {
    let randomId = 0;
    const crypto = {
        getRandomValues: bytes => { bytes.fill(0xab); return bytes; },
        randomUUID: () => `request-${++randomId}`
    };
    const chain = { buy: vi.fn(async value => ({ action: 'buy', ...value })), sell: vi.fn(async value => ({ action: 'sell', ...value })) };
    const api = Trading.create({ storage, crypto, fetch: fetch || vi.fn(async () => response({})),
        baseUrl: () => backend, profile: async () => agent, simulationRun: () => run, chain: () => chain });
    return { api, storage, chain };
}

afterEach(() => vi.restoreAllMocks());

describe('betting asset trading client', () => {
    it('lets a shared link select its book independently of the saved preference', () => {
        const storage = makeStorage({ 'bets-asset-v1': 'points' });
        const api = Trading.create({ storage, initialAsset: 'devnet-usdc' });
        expect(api.asset()).toBe('devnet-usdc');
        expect(api.needsWallet()).toBe(true);
        expect(Trading.create({ storage, initialAsset: 'cash' }).asset()).toBe('points');
    });
    it('defaults to points, creates a scoped random credential, and never authenticates public markets', async () => {
        const calls = [];
        const fetch = vi.fn(async (url, options = {}) => {
            calls.push({ url: String(url), options });
            if (String(url).includes('/bets/points/account')) return response({ id: 'account-1', positions: {}, balance: '100' });
            if (String(url).includes('/bets/points/markets?')) return response({ markets: {}, subjects: {} });
            if (String(url).includes('/markets?city=')) return response({ contests: [] });
            return response({});
        });
        const { api, storage } = harness({ fetch });
        expect(api.asset()).toBe('points');
        expect(api.needsWallet()).toBe(false);
        await api.readAccount();
        await api.loadCity('Rijeka');
        const account = calls.find(call => call.url.endsWith('/bets/points/account'));
        expect(account.options.headers.Authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
        const publicMarkets = calls.find(call => call.url.includes('/markets?city='));
        expect(publicMarkets.options.headers?.Authorization).toBeUndefined();
        expect(publicMarkets.options.body).toBeUndefined();
        const tokenKeys = [...storage.values.keys()].filter(key => key.endsWith(':token'));
        expect(tokenKeys).toHaveLength(1);
        expect(tokenKeys[0]).toContain('https://api.example::agent-a');
    });

    it('keeps credentials isolated by profile, backend, and simulation run', async () => {
        const storage = makeStorage();
        const tokens = [];
        const fetch = vi.fn(async (url, options = {}) => {
            if (String(url).endsWith('/bets/points/account')) tokens.push(options.headers.Authorization);
            return response({ id: 'acct', positions: {}, balance: '0' });
        });
        for (const config of [
            { agent: 'agent-a', backend: 'https://one', run: 'run-1' },
            { agent: 'agent-b', backend: 'https://one', run: 'run-1' },
            { agent: 'agent-a', backend: 'https://two', run: 'run-1' },
            { agent: 'agent-a', backend: 'https://one', run: 'run-2' }
        ]) await harness({ ...config, fetch, storage }).api.readAccount();
        expect([...storage.values.keys()].filter(key => key.endsWith(':token'))).toHaveLength(4);
    });

    it('persists an idempotency request across an uncertain response and replays it after recreation', async () => {
        const storage = makeStorage();
        const calls = [];
        let loseResponse = true;
        const fetch = vi.fn(async (url, options = {}) => {
            calls.push({ url: String(url), options });
            if (String(url).endsWith('/bets/points/account')) return response({ id: 'acct', positions: {}, balance: '100' });
            if (String(url).includes('/bets/points/trade')) {
                const requestBody = JSON.parse(options.body);
                if (loseResponse) { loseResponse = false; throw new Error('connection dropped'); }
                return response({ receipt: { id: 'receipt-1', requestId: requestBody.requestId } });
            }
            return response({});
        });
        const intent = { proposal: 'agreement-account', shares: '25', side: 'yes', maxCost: '8' };
        const first = harness({ fetch, storage }).api;
        await expect(first.buy(intent)).rejects.toMatchObject({ code: 'CONFIRMATION_UNKNOWN' });
        const pendingEntry = [...storage.values.entries()].find(([key]) => key.endsWith(':pending'));
        expect(pendingEntry).toBeTruthy();
        const pending = JSON.parse(pendingEntry[1]);
        expect(pending.data.requestId).toBe('request-1');

        const recreated = harness({ fetch, storage }).api;
        const receipt = await recreated.buy(intent);
        expect(receipt.receipt.id).toBe('receipt-1');
        const tradeCalls = calls.filter(call => call.url.includes('/bets/points/trade'));
        expect(tradeCalls).toHaveLength(2);
        expect(tradeCalls.map(call => JSON.parse(call.options.body).requestId)).toEqual(['request-1', 'request-1']);
        expect(storage.getItem(pendingEntry[0])).toBeNull();
    });

    it('blocks a different intent while one is pending and clears the pending request after a definitive 409', async () => {
        const storage = makeStorage();
        let status = 503;
        const fetch = vi.fn(async (url, options = {}) => {
            if (String(url).endsWith('/bets/points/account')) return response({ id: 'acct', positions: {}, balance: '100' });
            if (String(url).includes('/bets/points/trade')) return response({ message: 'Conflict', error: 'conflict' }, status);
            return response({});
        });
        const api = harness({ fetch, storage }).api;
        const first = { proposal: 'a', shares: '1', side: 'no', maxCost: '2' };
        await expect(api.buy(first)).rejects.toMatchObject({ code: 'CONFIRMATION_UNKNOWN' });
        await expect(api.buy({ ...first, shares: '2' })).rejects.toMatchObject({ code: 'POINTS_PENDING' });
        const pendingKey = [...storage.values.keys()].find(key => key.endsWith(':pending'));
        expect(storage.getItem(pendingKey)).not.toBeNull();
        status = 409;
        await expect(api.buy(first)).rejects.toMatchObject({ status: 409 });
        expect(storage.getItem(pendingKey)).toBeNull();
    });

    it('requires a matching receipt request ID and preserves uncertain or mismatched requests', async () => {
        const storage = makeStorage();
        const fetch = vi.fn(async (url, options = {}) => {
            if (String(url).endsWith('/bets/points/account')) return response({ id: 'acct', positions: {}, balance: '100' });
            if (String(url).includes('/bets/points/trade')) return response({ receipt: { id: 'receipt', requestId: 'some-other-request' } });
            return response({});
        });
        const api = harness({ fetch, storage }).api;
        await expect(api.buy({ proposal: 'a', shares: '2', side: 'yes', maxCost: '4' }))
            .rejects.toMatchObject({ code: 'CONFIRMATION_UNKNOWN' });
        expect([...storage.values.keys()].some(key => key.endsWith(':pending'))).toBe(true);
    });

    it('rejects a malformed saved credential without replacing or transmitting it', async () => {
        const key = 'bets-points-v1:https://api.example::agent-a:token';
        const storage = makeStorage({ [key]: 'invalid-secret' });
        const fetch = vi.fn();
        await expect(harness({ fetch, storage }).api.readAccount()).rejects.toMatchObject({ code: 'POINTS_CREDENTIAL_INVALID' });
        expect(storage.getItem(key)).toBe('invalid-secret');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('supplements public agreements with server markets and authoritative point-subject status', async () => {
        const fetch = vi.fn(async (url, options = {}) => {
            const target = String(url);
            if (target.endsWith('/markets?city=Rijeka')) return response({ contests: [{ agreements: [
                { account: 'account-1', deadline: 9999999999, chainStatus: 'expired', market: { resolved: false } },
                { account: 'account-2', deadline: 9999999999, chainStatus: 'active', market: { resolved: false } }
            ] }] });
            if (target.includes('/bets/points/markets?')) return response({
                markets: { 'account-1': { address: 'market-1', resolved: false, closesAt: Math.floor(Date.now() / 1000) + 1000, graceSeconds: 0, qYes: '4', qNo: '2' } },
                subjects: { 'account-1': { chainStatus: 'active', deadline: 123, sponsor: 'sponsor-a' } }
            });
            if (target.includes('/bets/points/account')) return response({ id: 'owner', positions: { 'account-1': { yes: '4', no: '2' } }, balance: '10' });
            return response({});
        });
        const { api, chain } = harness({ fetch });
        const catalog = await api.loadCity('Rijeka');
        const [listed, unavailable] = catalog.contests[0].agreements;
        expect(listed.chainStatus).toBe('active');
        expect(listed.deadline).toBe(123);
        expect(listed.sponsor).toBe('sponsor-a');
        expect(listed.market.address).toBe('market-1');
        expect(listed.bettable).toBe(true);
        expect(listed.canSettle).toBe(false);
        expect(unavailable.market).toBeNull();
        expect(unavailable.bettable).toBe(false);
        expect(catalog.contests[0].sharesAtomic).toBe('6');
        expect(await api.readPositions([{ account: 'account-1' }])).toEqual({ 'account-1': { yes: '4', no: '2' } });
        expect(chain.buy).not.toHaveBeenCalled();
    });

    it('keeps devnet explicit and delegates trade values to the wallet bridge', async () => {
        const { api, chain, storage } = harness();
        api.setAsset('devnet-usdc');
        expect(api.needsWallet()).toBe(true);
        const buy = { proposal: 'market-address', side: 1, shares: '123456', maxCost: '22000' };
        const sell = { proposal: 'market-address', side: 0, shares: '654321', minReturn: '31000' };
        await api.buy(buy);
        await api.sell(sell);
        expect(chain.buy).toHaveBeenCalledWith(buy);
        expect(chain.sell).toHaveBeenCalledWith(sell);
        expect([...storage.values.keys()].some(key => key.includes('points-v1'))).toBe(false);
    });
});
