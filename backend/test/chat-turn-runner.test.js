import { describe, expect, it, vi } from 'vitest';
import { runTurn } from '../chat/turn-runner.js';
import { contextBlock } from '../chat/system-prompt.js';

const tool = (name, input = {}, id = 't1') => ({ type: 'tool_use', id, name, input });
const model = (...responses) => vi.fn(async () => responses.shift());
const base = { conversation: {}, text: 'make a place', context: { city: 'london', language: 'en' }, prices: { input: 1, output: 2, cache_read: 0.1, cache_creation: 0.5 }, mcpTools: { tools: [{ name: 'ugt_draft_space', description: 'Draft', inputSchema: { type: 'object', properties: { plan: { type: 'string' } } } }] } };

describe('chat turn runner', () => {
    it('keeps the request as an instruction and gives selection refs without exposing plan refs', () => {
        const prompt = contextBlock({ city: 'london', language: 'en', selection: { designCid: 'design-cid', buildingIndex: 2 } }, { cid: 'private-plan-cid', draftRef: 'https://private.test/plan' }, []);
        expect(prompt).toContain('<instruction>'); expect(prompt).toContain('"ref":"building:design-cid:2"');
        expect(prompt).not.toContain('private-plan-cid'); expect(prompt).not.toContain('private.test/plan');
    });
    it('injects the working plan into later tool calls and records a successful plan change', async () => {
        const callModel = model({ content: [tool('ugt_draft_space')] }, { content: [{ type: 'text', text: 'Done.' }] });
        const callTool = vi.fn(async () => ({ structuredContent: { ok: true, plan: { draftRef: 'http://localhost/draft', cid: 'plan-1' } } }));
        const result = await runTurn({ ...base, callModel, callTool });
        expect(callTool).toHaveBeenCalledWith('ugt_draft_space', {}, expect.anything());
        expect(result.plan).toEqual({ draftRef: 'http://localhost/draft', cid: 'plan-1' });
        expect(result.planChanged).toBe(true); expect(result.outcome).toEqual({ type: 'reply', text: 'Done.' });
    });
    it('does not replace a plan on refused placement and marks tool errors in the result', async () => {
        const callModel = model({ content: [tool('ugt_edit_plan')] }, { content: [{ type: 'text', text: 'No change.' }] });
        const callTool = vi.fn(async () => ({ isError: true, structuredContent: { ok: false, code: 'ground-occupied', message: 'Occupied' } }));
        const result = await runTurn({ ...base, conversation: { plan: { draftRef: 'http://localhost/old', cid: 'old' } }, callModel, callTool });
        expect(result.plan.cid).toBe('old'); expect(result.planChanged).toBe(false);
        expect(result.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result')).toMatchObject({ type: 'tool_result', is_error: true });
    });
    it('ends ask_person with a matching tool_result and emits a question outcome', async () => {
        const callModel = model({ content: [tool('ask_person', { question: 'Which one?', options: [{ label: 'A', ref: 'design:a' }] })] }), emit = vi.fn();
        const result = await runTurn({ ...base, callModel, callTool: vi.fn(), emit });
        expect(result.outcome).toMatchObject({ type: 'question', question: 'Which one?' });
        expect(result.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
        expect(result.steps).toContainEqual(expect.objectContaining({ tool: 'ask_person', ok: true }));
        expect(emit).toHaveBeenCalledWith('step', expect.objectContaining({ tool: 'ask_person', ok: true, summary: 'ask person completed' }));
    });
    it('refuses a non-allowlisted tool before MCP and computes cached token cost', async () => {
        const callModel = model({ content: [tool('ugt_publish_design')] }, { content: [{ type: 'text', text: 'Not available.' }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } });
        const callTool = vi.fn();
        const result = await runTurn({ ...base, callModel, callTool });
        expect(callTool).not.toHaveBeenCalled(); expect(result.costUsd).toBeCloseTo(0.000034, 9);
    });
    it('truncates a partial round on abort and reports the step cap', async () => {
        const controller = new AbortController();
        const callModel = model({ content: [tool('ugt_draft_space')] });
        const callTool = vi.fn(async () => { controller.abort(); return { structuredContent: { plan: { draftRef: 'http://localhost/new', cid: 'new' } } }; });
        const result = await runTurn({ ...base, signal: controller.signal, callModel, callTool });
        expect(result.outcome.code).toBe('aborted');
        expect(result.messages.filter(m => m.role === 'assistant').at(-1).content[0].type).toBe('tool_use');
        expect(result.messages.filter(m => m.role === 'user').at(-1).content[0]).toMatchObject({ type: 'tool_result' });
        expect(result.planChanged).toBe(true);
        const capped = await runTurn({ ...base, limits: { maxSteps: 1 }, callModel: model({ content: [tool('ugt_find_place')] }, { content: [tool('ugt_find_place', {}, 't2')] }), callTool: vi.fn(async () => ({ structuredContent: { ok: true } })) });
        expect(capped.outcome.code).toBe('step_limit');
    });
    it('does not append a refused assistant message', async () => {
        const result = await runTurn({ ...base, callModel: model({ stop_reason: 'refusal', content: [{ type: 'text', text: 'refused' }] }), callTool: vi.fn() });
        expect(result.outcome.code).toBe('refused'); expect(result.messages.filter(m => m.role === 'assistant')).toHaveLength(0);
    });
    it('rejects all parallel tool requests with matching errors before calling MCP', async () => {
        const callModel = model({ content: [tool('ugt_find_place', {}, 'a'), tool('ugt_draft_space', {}, 'b')] }, { content: [{ type: 'text', text: 'Please choose one action.' }] });
        const callTool = vi.fn();
        const result = await runTurn({ ...base, callModel, callTool });
        expect(callTool).not.toHaveBeenCalled();
        const blocks = result.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
        expect(blocks).toHaveLength(2); expect(blocks.every(block => block.is_error)).toBe(true);
    });
    it('keeps completed tool rounds when cancellation arrives before the next model call', async () => {
        const controller = new AbortController(), callModel = model({ content: [tool('ugt_find_place')] });
        const result = await runTurn({ ...base, signal: controller.signal, callModel, callTool: vi.fn(async () => ({ structuredContent: { ok: true, candidates: [] } })), emit: () => controller.abort() });
        expect(result.outcome.code).toBe('aborted');
        expect(result.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
        expect(result.messages.at(-1).content[0].type).toBe('tool_result');
    });
    it('does not count a preflight noModelCall error as an attempted paid model call', async () => {
        const callModel = vi.fn(async () => { throw Object.assign(new Error('too much context'), { code: 'context-limit', noModelCall: true }); });
        const result = await runTurn({ ...base, callModel, callTool: vi.fn() });
        expect(result.modelCalls).toBe(0); expect(result.usageUncertain).toBe(false); expect(result.outcome.code).toBe('context-limit');
    });
});
