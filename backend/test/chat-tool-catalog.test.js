import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createUrbanGameTheoryMcpServer } from '../agents/mcp-server.mjs';
import { MCP_HOSTED_SHARED_TOOLS, MCP_DEBUG_TOOLS } from '../agents/mcp-catalog.js';
import { CHAT_TOOL_ALLOWLIST, injectPlanArgs, RELAY_TOOLS, restrictHelpTopic, STRIPPED_PARAMS, toModelTools } from '../chat/tool-catalog.js';

describe('chat tool catalog', () => {
    it('is a subset of hosted tools and strips internal parameters', () => {
        expect(CHAT_TOOL_ALLOWLIST.every(name => [...MCP_HOSTED_SHARED_TOOLS, ...MCP_DEBUG_TOOLS].includes(name))).toBe(true);
        const tools = toModelTools(CHAT_TOOL_ALLOWLIST.map(name => ({ name, inputSchema: { $schema: 'ignore', type: 'object', properties: Object.fromEntries(STRIPPED_PARAMS.map(key => [key, { type: 'string' }])) , required: [...STRIPPED_PARAMS] } })));
        expect(tools.slice(-RELAY_TOOLS.length).map(x => x.name)).toEqual(RELAY_TOOLS.map(x => x.name));
        expect(tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
        expect(tools.slice(0, -RELAY_TOOLS.length).every(x => x.input_schema.type === 'object' && !x.input_schema.$schema && !STRIPPED_PARAMS.some(p => x.input_schema.properties[p]) && !x.input_schema.required.length)).toBe(true);
        expect(JSON.stringify(tools).length).toBeLessThan(90_000);
        expect(toModelTools({ tools: [{ name: 'ugt_find_place', inputSchema: { type: 'object', properties: {} } }] })[0].name).toBe('ugt_find_place');
    });
    it('keeps the connected hosted tool catalogue below 90 KB with the agreement tools', async () => {
        const server = createUrbanGameTheoryMcpServer({ mode: 'hosted', env: { CHAT_DEBUG_COSTS: '1' } });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'chat-catalog-test', version: '1' });
        try {
            await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
            const actual = (await client.listTools()).tools;
            expect(CHAT_TOOL_ALLOWLIST.every(name => actual.some(tool => tool.name === name))).toBe(true);
            const tools = toModelTools(actual.filter(tool => CHAT_TOOL_ALLOWLIST.includes(tool.name)));
            expect(tools.slice(-RELAY_TOOLS.length).map(x => x.name)).toEqual(RELAY_TOOLS.map(x => x.name));
            // The three agreement tools add 13,649 bytes to the 69,135-byte base catalogue.
            expect(JSON.stringify(tools).length).toBeLessThan(90_000);
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
    it('injects the working plan and exact private agreement revision, hiding terms.plan', () => {
        const plan = { draftRef: 'https://example.test/plan', cid: 'plan-cid' };
        const agreement = { draftRef: 'https://example.test/agreement', cid: 'agreement-cid', planCid: 'plan-cid' };
        expect(injectPlanArgs('ugt_draft_agreement', { title: 'Deal' }, plan)).toEqual({ title: 'Deal', plan: plan.draftRef });
        expect(injectPlanArgs('ugt_inspect_agreement', { filter: {} }, plan, agreement)).toEqual({ filter: {}, plan: agreement.draftRef });
        expect(injectPlanArgs('ugt_edit_agreement', { terms: { title: 'Revised', plan: { cid: 'other' } } }, plan, agreement))
            .toEqual({ terms: { title: 'Revised' }, plan: agreement.draftRef, expectedCid: agreement.cid });
        expect(() => injectPlanArgs('ugt_inspect_agreement', {})).toThrowError(expect.objectContaining({ code: 'no-working-agreement' }));
        const [edit] = toModelTools([{ name: 'ugt_edit_agreement', inputSchema: { type: 'object', properties: {
            plan: {}, expectedCid: {}, terms: { type: 'object', properties: { plan: {}, title: {} } } }, required: ['plan'] } }]);
        expect(edit.input_schema.properties.terms.properties.plan).toBeUndefined();
    });
    it('hides relay-owned current view and cursor from model parameters', () => {
        const tools = toModelTools(['ugt_map_view', 'ugt_select_parcels'].map(name => ({ name, inputSchema: { type: 'object', properties: { view: {}, selection: {}, action: {} }, required: ['view', 'selection'] } })));
        expect(tools[0].input_schema.properties.view).toBeUndefined();
        expect(tools[0].input_schema.required).not.toContain('view');
        expect(tools[1].input_schema.properties.selection).toBeUndefined();
        expect(tools[1].input_schema.required).not.toContain('selection');
    });
    it('restricts help discovery to workflow, editing, or allowlisted tools', () => {
        expect(restrictHelpTopic({ topic: 'ugt_edit_plan' }).topic).toBe('ugt_edit_plan');
        expect(restrictHelpTopic({ topic: 'publishing' }).topic).toBe('workflow');
    });
});
