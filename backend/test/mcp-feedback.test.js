import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
let client, server;
afterEach(async () => { await client?.close(); await server?.close(); });
describe('MCP private feedback', () => {
    it('preserves a generated receipt ID for a safe retry when the API result is uncertain', async () => {
        const sent = [];
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async (_url, options) => {
            sent.push(JSON.parse(options.body));
            if (sent.length === 1) throw new Error('Response lost');
            return Response.json({ report: { id: sent[0].reportId, status: 'received' } });
        } });
        let recovery;
        try { await tools.submitFeedback({ message: 'The comparison is disabled.', confirm: true }); }
        catch (error) { recovery = error.next; }
        expect(recovery.tool).toBe('ugt_submit_feedback');
        expect(recovery.arguments.reportId).toMatch(/^[0-9a-f-]{36}$/);
        expect((await tools.submitFeedback(recovery.arguments)).report.id).toBe(sent[0].reportId);
        expect(sent[1]).toEqual(sent[0]);
    });
    it('exposes a separately confirmed write and returns the API receipt without publishing or signing', async () => {
        const calls = [], receipt = { report: { id: '7489c4d1-0804-4f51-b34d-114907452e72', status: 'received' } };
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: vi.fn(async (url, options) => {
            calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body), origin: options.headers.origin });
            return Response.json(receipt);
        }) });
        server = createUrbanGameTheoryMcpServer({ mode: 'hosted', env: {}, tools });
        client = new Client({ name: 'feedback-test', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(st), client.connect(ct)]);
        const tool = (await client.listTools()).tools.find(t => t.name === 'ugt_submit_feedback');
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
        const args = { message: 'The three roads appear changed.', pageUrl: 'https://urbangametheory.xyz/agreements/example', reportId: receipt.report.id };
        expect((await client.callTool({ name: tool.name, arguments: { ...args, confirm: false } })).isError).toBe(true);
        expect(calls).toHaveLength(0);
        expect((await client.callTool({ name: tool.name, arguments: { ...args, confirm: true } })).structuredContent).toEqual(receipt);
        expect(calls).toEqual([{ path: '/feedback', body: { ...args, kind: 'bug', source: 'mcp' }, origin: 'https://urbangametheory.xyz' }]);
    });
});
