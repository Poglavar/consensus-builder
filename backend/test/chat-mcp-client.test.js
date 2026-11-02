import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHttpService } from '../agents/mcp-http.mjs';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { createMcpToolCaller } from '../chat/mcp-client.js';

let service, caller, storeDirectory;
afterEach(async () => { await caller?.close(); caller = null; await service?.close(); service = null; if (storeDirectory) rmSync(storeDirectory, { recursive: true, force: true }); storeDirectory = null; });

describe('chat MCP client', () => {
    it('round-trips a hosted tool through the internal HTTP listener', async () => {
        storeDirectory = mkdtempSync(join(tmpdir(), 'chat-mcp-'));
        service = createMcpHttpService({ env: {}, storeDirectory, factory: options => createUrbanGameTheoryMcpServer({ ...options, mode: 'hosted', env: {}, tools: { explain: async () => ({ entries: ['ok'] }) } }) });
        await new Promise(resolve => service.http.listen(0, '::', resolve));
        caller = createMcpToolCaller({ url: `http://[::1]:${service.http.address().port}/mcp` });
        const catalog = await caller.listTools();
        expect(catalog.tools.map(t => t.name)).toContain('ugt_explain');
        const result = await caller.callTool('ugt_explain', { term: 'test' });
        expect(result.structuredContent.entries).toEqual(['ok']);
    });
    it('maps an expired tool call deadline to tool-timeout', async () => {
        const client = { connect: vi.fn(), callTool: vi.fn((_, __, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true }))), close: vi.fn() };
        caller = createMcpToolCaller({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 10, clientFactory: () => client });
        await expect(caller.callTool('anything')).rejects.toMatchObject({ code: 'tool-timeout' });
    });
});
