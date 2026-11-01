import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { MCP_HOSTED_SHARED_TOOLS } from '../agents/mcp-catalog.js';
import { CHAT_TOOL_ALLOWLIST, injectPlanArgs, RELAY_TOOLS, restrictHelpTopic, STRIPPED_PARAMS, toModelTools } from '../chat/tool-catalog.js';

describe('chat tool catalog', () => {
    it('is a subset of hosted tools and strips internal parameters', () => {
        expect(CHAT_TOOL_ALLOWLIST.every(name => MCP_HOSTED_SHARED_TOOLS.includes(name))).toBe(true);
        const tools = toModelTools(CHAT_TOOL_ALLOWLIST.map(name => ({ name, inputSchema: { $schema: 'ignore', type: 'object', properties: Object.fromEntries(STRIPPED_PARAMS.map(key => [key, { type: 'string' }])) , required: [...STRIPPED_PARAMS] } })));
        expect(tools.slice(-2).map(x => x.name)).toEqual(RELAY_TOOLS.map(x => x.name));
        expect(tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
        expect(tools.slice(0, -2).every(x => x.input_schema.type === 'object' && !x.input_schema.$schema && !STRIPPED_PARAMS.some(p => x.input_schema.properties[p]) && !x.input_schema.required.length)).toBe(true);
        expect(JSON.stringify(tools).length).toBeLessThan(80_000);
        expect(toModelTools({ tools: [{ name: 'ugt_find_place', inputSchema: { type: 'object', properties: {} } }] })[0].name).toBe('ugt_find_place');
    });
    it('uses the connected hosted MCP schema shapes within the compact byte bound', async () => {
        const server = createUrbanGameTheoryMcpServer({ mode: 'hosted', env: {} });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'chat-catalog-test', version: '1' });
        try {
            await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
            const actual = (await client.listTools()).tools;
            expect(CHAT_TOOL_ALLOWLIST.every(name => actual.some(tool => tool.name === name))).toBe(true);
            const tools = toModelTools(actual.filter(tool => CHAT_TOOL_ALLOWLIST.includes(tool.name)));
            expect(tools.slice(-2).map(x => x.name)).toEqual(RELAY_TOOLS.map(x => x.name));
            expect(JSON.stringify(tools).length).toBeLessThan(80_000);
        } finally {
            await client.close();
            await server.close();
        }
    });
    it('injects the plan and expected CIDs after stripping them from the model schema', () => {
        expect(injectPlanArgs('ugt_edit_plan', { title: 'Park' }, { draftRef: 'https://example.test/draft', cid: 'plan-cid' })).toEqual({ title: 'Park', plan: 'https://example.test/draft', expectedCid: 'plan-cid' });
        expect(injectPlanArgs('ugt_edit_design', { design: { cid: 'design-cid' } }, { draftRef: 'https://example.test/draft' })).toEqual({ design: { cid: 'design-cid' }, plan: 'https://example.test/draft', expectedCid: 'design-cid' });
        expect(() => injectPlanArgs('ugt_inspect_plan', {})).toThrowError(expect.objectContaining({ code: 'no-working-plan' }));
        expect(injectPlanArgs('ugt_inspect_plan', { limit: 999, includeGeometry: true }, { draftRef: 'https://example.test/draft' })).toMatchObject({ limit: 50, includeGeometry: false });
        expect(() => injectPlanArgs('ugt_publish_design', {}, null)).toThrowError(expect.objectContaining({ code: 'tool-not-available' }));
    });
    it('restricts help discovery to workflow, editing, or allowlisted tools', () => {
        expect(restrictHelpTopic({ topic: 'ugt_edit_plan' }).topic).toBe('ugt_edit_plan');
        expect(restrictHelpTopic({ topic: 'publishing' }).topic).toBe('workflow');
    });
});
