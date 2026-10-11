import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { createRetryingRpcFetch, createRpcConnection } from '../solana/rpc.js';
import { createRpcMethodCounter } from '../solana/rpc-method-counts.js';

const rpcUrl = 'https://rpc.example.test/provider-secret-key';
const rpcRequest = (method, params = []) => JSON.stringify({ jsonrpc: '2.0', id: 7, method, params });
const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
});

describe('bounded Solana RPC retries', () => {
    it('retries 429, 502, and 503 with capped attempts and exponential waits', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('busy', { status: 429 }))
            .mockResolvedValueOnce(new Response('upstream', { status: 502 }))
            .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
            .mockResolvedValueOnce(response({ jsonrpc: '2.0', id: 7, result: 123 }));
        const wait = vi.fn(async () => {});
        const retry = createRetryingRpcFetch({ fetchImpl, wait, log: vi.fn() });

        const result = await retry(rpcUrl, { method: 'POST', body: rpcRequest('getBalance') });

        expect(result.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(wait.mock.calls.map(([duration]) => duration)).toEqual([1000, 2000, 4000]);
    });

    it('retries a transient JSON-RPC -32005 response', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ jsonrpc: '2.0', id: 7, error: { code: -32005, message: 'node busy' } }))
            .mockResolvedValueOnce(response({ jsonrpc: '2.0', id: 7, result: 456 }));
        const wait = vi.fn(async () => {});
        const retry = createRetryingRpcFetch({ fetchImpl, wait, log: vi.fn() });

        await expect(retry(rpcUrl, { method: 'POST', body: rpcRequest('getAccountInfo') })).resolves.toMatchObject({ status: 200 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(wait.mock.calls.map(([duration]) => duration)).toEqual([1000]);
    });

    it('does not retry deterministic JSON-RPC errors or HTTP 413', async () => {
        const deterministic = response({ jsonrpc: '2.0', id: 7, error: { code: -32002, message: 'simulation failed' } });
        const fetchDeterministic = vi.fn().mockResolvedValue(deterministic);
        const retryDeterministic = createRetryingRpcFetch({ fetchImpl: fetchDeterministic, wait: vi.fn(), log: vi.fn() });
        await expect(retryDeterministic(rpcUrl, { method: 'POST', body: rpcRequest('simulateTransaction') })).resolves.toBe(deterministic);
        expect(fetchDeterministic).toHaveBeenCalledTimes(1);

        const tooLarge = new Response('too large', { status: 413 });
        const fetchTooLarge = vi.fn().mockResolvedValue(tooLarge);
        const retryTooLarge = createRetryingRpcFetch({ fetchImpl: fetchTooLarge, wait: vi.fn(), log: vi.fn() });
        await expect(retryTooLarge(rpcUrl, { method: 'POST', body: rpcRequest('getMultipleAccounts') })).resolves.toBe(tooLarge);
        expect(fetchTooLarge).toHaveBeenCalledTimes(1);
    });

    it('never retries requestAirdrop, even after a retryable HTTP response', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('busy', { status: 429 }));
        const wait = vi.fn();
        const retry = createRetryingRpcFetch({ fetchImpl, wait, log: vi.fn() });

        await retry(rpcUrl, { method: 'POST', body: rpcRequest('requestAirdrop') });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(wait).not.toHaveBeenCalled();
    });

    it('bounds network failures to four attempts', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new TypeError('socket reset'));
        const wait = vi.fn(async () => {});
        const retry = createRetryingRpcFetch({ fetchImpl, wait, log: vi.fn() });

        await expect(retry(rpcUrl, { method: 'POST', body: rpcRequest('getBalance') })).rejects.toThrow('socket reset');
        expect(fetchImpl).toHaveBeenCalledTimes(4);
        expect(wait.mock.calls.map(([duration]) => duration)).toEqual([1000, 2000, 4000]);
    });

    it('stops when the caller aborts during a retry wait', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn().mockResolvedValue(new Response('busy', { status: 429 }));
        const wait = vi.fn(async (_duration, _value, options) => {
            controller.abort(new Error('caller cancelled'));
            options.signal.throwIfAborted();
        });
        const retry = createRetryingRpcFetch({ fetchImpl, wait, log: vi.fn() });

        await expect(retry(rpcUrl, { method: 'POST', body: rpcRequest('getBalance'), signal: controller.signal }))
            .rejects.toMatchObject({ message: 'caller cancelled' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(wait).toHaveBeenCalledTimes(1);
    });

    it('replays sendTransaction with byte-identical body and keeps URL/body out of logs', async () => {
        const body = rpcRequest('sendTransaction', ['signed-transaction-bytes-secret']);
        const logs = [];
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('busy', { status: 429 }))
            .mockResolvedValueOnce(response({ jsonrpc: '2.0', id: 7, result: 'signature' }));
        const retry = createRetryingRpcFetch({ fetchImpl, wait: async () => {}, log: message => logs.push(message) });

        await retry(rpcUrl, { method: 'POST', body });

        expect(fetchImpl.mock.calls.map(([, init]) => init.body)).toEqual([body, body]);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('sendTransaction');
        expect(logs.join('\n')).not.toContain('provider-secret-key');
        expect(logs.join('\n')).not.toContain('signed-transaction-bytes-secret');
    });

    it('counts each JSON-RPC batch member at the transport boundary, including retries', async () => {
        const rpcCounter = createRpcMethodCounter();
        const body = JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [] },
            { jsonrpc: '2.0', id: 2, method: 'getBalance', params: [] }
        ]);
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response('busy', { status: 429 }))
            .mockResolvedValueOnce(new Response(JSON.stringify([
                { jsonrpc: '2.0', id: 1, result: null }, { jsonrpc: '2.0', id: 2, result: null }
            ]), { status: 200, headers: { 'content-type': 'application/json' } }));
        const retry = createRetryingRpcFetch({ fetchImpl, onRpcRequest: rpcCounter.onRequest, wait: async () => {}, log: vi.fn() });

        await retry(rpcUrl, { method: 'POST', body });

        expect(rpcCounter.snapshot()).toEqual({ getTransaction: 2, getBalance: 2 });
    });

    it('uses the configured fetch through a real web3 Connection request', async () => {
        const fetchImpl = vi.fn(async (_input, init) => {
            const request = JSON.parse(init.body);
            expect(request.method).toBe('getBalance');
            return response({ jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: 9876 } });
        });
        const rpcCounter = createRpcMethodCounter();
        const connection = createRpcConnection(rpcUrl, 'confirmed', { fetchImpl, onRpcRequest: rpcCounter.onRequest, wait: vi.fn(), log: vi.fn() });

        await expect(connection.getBalance(new PublicKey('11111111111111111111111111111111'))).resolves.toBe(9876);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(rpcCounter.snapshot()).toEqual({ getBalance: 1 });
    });
});
