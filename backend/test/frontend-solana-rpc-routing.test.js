import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(async () => {
    await import('../../frontend/js/solana/rpc-routing.js');
});

const routing = () => globalThis.SolanaRpcRouting;
const reply = payload => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
});
const request = (id, method) => ({ jsonrpc: '2.0', id, method, params: [] });

describe('browser Solana RPC routing', () => {
    it('verifies the configured devnet endpoint before account reads, rejecting missing or different identity', async () => {
        const oldWindow = globalThis.window;
        let genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
        const created = [];
        globalThis.window = { solanaWeb3: { Connection: class {
            constructor(endpoint) { this.endpoint = endpoint; created.push(this); }
            async getGenesisHash() { return genesis; }
        } } };
        try {
            await import('../../frontend/js/solana/chain-data-loader.js?verified-account-network-test');
            const loader = globalThis.window.SolanaChainDataLoader;
            await expect(loader.getVerifiedConnection('mainnet-beta')).rejects.toThrow('devnet only');
            expect(created).toHaveLength(0);
            expect(await loader.getVerifiedConnection('devnet')).toBe(created[0]);
            genesis = 'another-network';
            await expect(loader.getVerifiedConnection('devnet')).rejects.toThrow('does not match devnet');
            genesis = null;
            await expect(loader.getVerifiedConnection('devnet')).rejects.toThrow('does not match devnet');
            expect(created).toHaveLength(1);
        } finally {
            if (oldWindow === undefined) delete globalThis.window;
            else globalThis.window = oldWindow;
        }
    });
    it('resolves runtime per-cluster primary and program-account endpoints', () => {
        const oldRpc = globalThis.SOLANA_RPC_URLS;
        const oldProgramRpc = globalThis.SOLANA_PROGRAM_ACCOUNTS_RPC_URLS;
        globalThis.SOLANA_RPC_URLS = { devnet: 'https://devnet-primary.example.test/rpc' };
        globalThis.SOLANA_PROGRAM_ACCOUNTS_RPC_URLS = { devnet: 'https://devnet-list.example.test/rpc' };
        try {
            expect(routing().resolveEndpoints('devnet')).toEqual({
                cluster: 'devnet',
                primary: 'https://devnet-primary.example.test/rpc',
                programAccounts: 'https://devnet-list.example.test/rpc',
                ws: 'wss://api.devnet.solana.com'
            });
        } finally {
            if (oldRpc === undefined) delete globalThis.SOLANA_RPC_URLS;
            else globalThis.SOLANA_RPC_URLS = oldRpc;
            if (oldProgramRpc === undefined) delete globalThis.SOLANA_PROGRAM_ACCOUNTS_RPC_URLS;
            else globalThis.SOLANA_PROGRAM_ACCOUNTS_RPC_URLS = oldProgramRpc;
        }
    });

    it('constructs the browser SDK Connection with configured endpoints and method router', async () => {
        const oldWindow = globalThis.window;
        const primary = 'https://configured-devnet.example.test/rpc';
        const secondary = 'https://configured-list.example.test/rpc';
        const created = [];
        globalThis.window = {
            SOLANA_RPC_URLS: { devnet: primary },
            SOLANA_PROGRAM_ACCOUNTS_RPC_URLS: { devnet: secondary },
            solanaWeb3: {
                Connection: class Connection {
                    constructor(endpoint, options) { Object.assign(this, { endpoint, options }); created.push(this); }
                }
            },
            fetch: async (endpoint, init) => {
                const payload = JSON.parse(init.body);
                const result = payload.method === 'getGenesisHash' ? 'devnet-genesis' : [];
                return reply({ jsonrpc: '2.0', id: payload.id, result });
            }
        };
        try {
            await import('../../frontend/js/solana/rpc-routing.js?window-configured-endpoints-test');
            await import('../../frontend/js/solana/chain-data-loader.js?configured-endpoints-test');
            const connection = globalThis.window.SolanaChainDataLoader.getConnection('devnet');

            expect(connection.endpoint).toBe(primary);
            expect(connection.options.commitment).toBe('confirmed');
            // The configured primary may lack signatureSubscribe; confirmations listen on the public socket.
            expect(connection.options.wsEndpoint).toBe('wss://api.devnet.solana.com');
            expect(connection.options.fetch).toBeTypeOf('function');
            await expect(connection.options.fetch(primary, {
                method: 'POST', body: JSON.stringify(request(30, 'getProgramAccounts'))
            })).resolves.toMatchObject({ status: 200 });
        } finally {
            if (oldWindow === undefined) delete globalThis.window;
            else globalThis.window = oldWindow;
        }
        expect(created).toHaveLength(1);
    });

    it('confirms over the public cluster websocket unless SOLANA_WS_URLS names another', () => {
        const oldWs = globalThis.SOLANA_WS_URLS;
        try {
            delete globalThis.SOLANA_WS_URLS;
            expect(routing().resolveEndpoints('mainnet').ws).toBe('wss://api.mainnet-beta.solana.com');
            expect(routing().resolveEndpoints('devnet').ws).toBe('wss://api.devnet.solana.com');
            globalThis.SOLANA_WS_URLS = { devnet: 'wss://devnet-socket.example.test' };
            expect(routing().resolveEndpoints('devnet').ws).toBe('wss://devnet-socket.example.test');
        } finally {
            if (oldWs === undefined) delete globalThis.SOLANA_WS_URLS;
            else globalThis.SOLANA_WS_URLS = oldWs;
        }
    });

    it('sends ordinary methods only to primary and routes list methods to the verified secondary', async () => {
        const primary = 'https://devnet-primary.example.test/rpc';
        const secondary = 'https://devnet-list.example.test/rpc';
        const fetchImpl = vi.fn(async (endpoint, init) => {
            const body = JSON.parse(init.body);
            const rows = Array.isArray(body) ? body : [body];
            if (rows[0].method === 'getGenesisHash') return reply({ jsonrpc: '2.0', id: rows[0].id, result: 'devnet-genesis' });
            const output = rows.map(row => ({ jsonrpc: '2.0', id: row.id, result: endpoint === secondary ? ['list-result'] : 'ordinary-result' }));
            return reply(Array.isArray(body) ? output : output[0]);
        });
        const fetchRpc = routing().createFetch(primary, secondary, fetchImpl);
        const body = JSON.stringify([request(10, 'getBalance'), request(11, 'getProgramAccounts')]);

        const response = await fetchRpc(primary, { method: 'POST', body });

        expect(await response.json()).toEqual([
            { jsonrpc: '2.0', id: 10, result: 'ordinary-result' },
            { jsonrpc: '2.0', id: 11, result: ['list-result'] }
        ]);
        const calls = fetchImpl.mock.calls.map(([endpoint, init]) => [endpoint, JSON.parse(init.body)]);
        expect(calls.slice(0, 2)).toEqual([
            [primary, request(1, 'getGenesisHash')],
            [secondary, request(1, 'getGenesisHash')]
        ]);
        expect(calls.slice(2).map(([endpoint, payload]) => [endpoint, payload.map(row => row.method)])).toEqual([
            [primary, ['getBalance']],
            [secondary, ['getProgramAccounts']]
        ]);
    });

    it('blocks a program-account request when the secondary endpoint is on another cluster', async () => {
        const primary = 'https://mainnet-primary.example.test/rpc';
        const secondary = 'https://wrong-cluster.example.test/rpc';
        const fetchImpl = vi.fn(async (endpoint, init) => {
            const body = JSON.parse(init.body);
            return reply({ jsonrpc: '2.0', id: body.id, result: endpoint === primary ? 'mainnet-genesis' : 'devnet-genesis' });
        });
        const fetchRpc = routing().createFetch(primary, secondary, fetchImpl);

        await expect(fetchRpc(primary, { method: 'POST', body: JSON.stringify(request(20, 'getProgramAccounts')) }))
            .rejects.toThrow('different Solana network');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('retries browser network verification after a transient genesis failure', async () => {
        const primary = 'https://retry-browser-primary.example.test/rpc';
        const secondary = 'https://retry-browser-list.example.test/rpc';
        let failedPrimaryGenesis = false;
        const fetchImpl = vi.fn(async (endpoint, init) => {
            const body = JSON.parse(init.body);
            const rows = Array.isArray(body) ? body : [body];
            if (rows[0].method === 'getGenesisHash') {
                if (endpoint === primary && !failedPrimaryGenesis) {
                    failedPrimaryGenesis = true;
                    throw new TypeError('temporary browser network reset');
                }
                return reply({ jsonrpc: '2.0', id: rows[0].id, result: 'same-cluster' });
            }
            const output = rows.map(row => ({
                jsonrpc: '2.0', id: row.id,
                result: row.method === 'getBalance' ? 456 : ['list-result']
            }));
            return reply(Array.isArray(body) ? output : output[0]);
        });
        const fetchRpc = routing().createFetch(primary, secondary, fetchImpl);

        await expect(fetchRpc(primary, { method: 'POST', body: JSON.stringify(request(40, 'getProgramAccounts')) }))
            .rejects.toThrow('temporary browser network reset');
        await expect(fetchRpc(primary, { method: 'POST', body: JSON.stringify(request(41, 'getBalance')) }))
            .resolves.toMatchObject({ status: 200 });
        await expect(fetchRpc(primary, { method: 'POST', body: JSON.stringify(request(42, 'getProgramAccounts')) }))
            .resolves.toMatchObject({ status: 200 });

        const dispatched = fetchImpl.mock.calls.map(([endpoint, init]) => [endpoint, JSON.parse(init.body).method]);
        expect(dispatched).toEqual([
            [primary, 'getGenesisHash'],
            [secondary, 'getGenesisHash'],
            [primary, 'getBalance'],
            [primary, 'getGenesisHash'],
            [secondary, 'getGenesisHash'],
            [secondary, 'getProgramAccounts']
        ]);
    });
});
