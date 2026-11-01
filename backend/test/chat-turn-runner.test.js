import { describe, expect, it, vi } from 'vitest';
import { runTurn } from '../chat/turn-runner.js';
import { contextBlock } from '../chat/system-prompt.js';

const tool = (name, input = {}, id = 't1') => ({ type: 'tool_use', id, name, input });
const model = (...responses) => vi.fn(async () => responses.shift());
const base = { conversation: {}, text: 'make a place', context: { city: 'london', language: 'en' }, prices: { input: 1, output: 2, cache_read: 0.1, cache_creation: 0.5 }, mcpTools: { tools: [{ name: 'ugt_draft_space', description: 'Draft', inputSchema: { type: 'object', properties: { plan: { type: 'string' } } } }] } };

describe('chat turn runner', () => {
    it('advances injected navigation state between tools and uses the selected site for drafting', async () => {
        const selection = { parcelSourceId: 'source', focusParcelId: 'p2', parcelIds: ['p1', 'p2'], active: false };
        const view = { at: '51.5,-0.1,18' };
        const callModel = model({ content: [tool('ugt_map_view', { zoomDelta: 1 })] },
            { content: [tool('ugt_select_parcels', { action: 'finish' })] },
            { content: [tool('ugt_draft_space', { spaceKind: 'park' })] },
            { content: [{ type: 'text', text: 'Done.' }] });
        const callTool = vi.fn(async name => ({ structuredContent: name === 'ugt_map_view' ? { view } : name === 'ugt_select_parcels' ? { selection } : { ok: true } }));
        const emit = vi.fn();
        await runTurn({ ...base, context: { city: 'london', parcelSourceId: 'source', view: { at: '51.5,-0.1,17' }, selection: { parcelIds: ['p1'], active: true } }, callModel, callTool, emit });
        expect(callTool.mock.calls[0][1].view.at).toBe('51.5,-0.1,17');
        expect(callTool.mock.calls[1][1].selection).toEqual({ parcelIds: ['p1'], active: true });
        expect(callTool.mock.calls[2][1]).toMatchObject({ parcelIds: ['p1', 'p2'], city: 'london', parcelSourceId: 'source' });
        expect(emit).toHaveBeenCalledWith('view', { view });
        expect(emit).toHaveBeenCalledWith('selection', { selection });
    });

    it.each([
        { text: 'Let us build a road', point: undefined, direction: undefined },
        { text: 'Let us build a plan of row houses', point: undefined, direction: undefined }
    ])('offers a real starting selection and continues with choices before drafting: $text', async ({ text, point, direction }) => {
        const selection = { parcelSourceId: 'source', focusParcelId: 'start', parcelIds: ['start'], active: false };
        const question = 'First choose the land, then the layout and dimensions. I have also selected a random parcel; navigate up, down, north, south, or a direction and how many metres. Continue here, select it yourself, or give an address or intersection?';
        const options = [{ label: 'Continue here' }, { label: 'Select it myself' }, { label: 'Give an address or intersection' }];
        const callModel = model({ content: [tool('ugt_select_parcels', { action: 'random', radiusM: point ? 500 : 100, ...(point ? { point, direction } : {}) })] },
            { content: [tool('ask_person', { question, options })] });
        const callTool = vi.fn(async () => ({ structuredContent: { selection, point: [-0.09, 51.5] } })), emit = vi.fn();
        const result = await runTurn({ ...base, text, context: { city: 'london', parcelSourceId: 'source', view: { at: '51.5,-0.1,17' } }, callModel, callTool, emit });
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(callTool).toHaveBeenCalledWith('ugt_select_parcels', expect.objectContaining({ action: 'random', point: point || [-0.1, 51.5] }), expect.anything());
        expect(emit).toHaveBeenCalledWith('selection', { selection, point: [-0.09, 51.5] });
        expect(result.outcome).toEqual({ type: 'question', question, options });
        expect(result.planChanged).toBe(false);
    });

    it('invalidates the old viewport label mapping after a map move', async () => {
        const callModel = model({ content: [tool('ugt_map_view', { center: [0,0] })] }, { content: [tool('ugt_select_parcels', { action: 'select', parcelNumber: '17/2' })] }, { content: [{ type: 'text', text: 'Refresh the map labels.' }] });
        const callTool = vi.fn(async name => name === 'ugt_map_view' ? { view: { at: '0,0,18' }, parcelIdsVisible: true } : { isError: true, structuredContent: { code: 'parcel-label-coverage-incomplete' } });
        await runTurn({ ...base, callModel, callTool, context: { city: 'london', parcelSourceId: 'source', view: { at: '51.5,-0.1,18' }, mapContext: { parcelSourceId: 'source', display: { parcelIds: false }, visibleParcels: [{ parcelId: 'old', label: '17/2', point: [-0.1,51.5] }], visibleParcelsTruncated: false } } });
        expect(callTool.mock.calls[1][1]).toMatchObject({ visibleParcels: [], visibleParcelsTruncated: true });
    });

    it('keeps the request as an instruction and gives selection refs without exposing plan refs', () => {
        const prompt = contextBlock({ city: 'london', language: 'en', selection: { designCid: 'design-cid', buildingIndex: 2 } }, { cid: 'private-plan-cid', draftRef: 'https://private.test/plan' }, []);
        expect(prompt).toContain('<instruction>'); expect(prompt).toContain('"ref":"building:design-cid:2"');
        expect(prompt).not.toContain('private-plan-cid'); expect(prompt).not.toContain('private.test/plan');
    });
    it('injects the working plan into later tool calls and records a successful plan change', async () => {
        const callModel = model({ content: [tool('ugt_draft_space')] }, { content: [{ type: 'text', text: 'Done.' }] });
        const callTool = vi.fn(async () => ({ structuredContent: { ok: true, plan: { draftRef: 'http://localhost/draft', cid: 'plan-1' } } }));
        const result = await runTurn({ ...base, callModel, callTool });
        expect(callTool).toHaveBeenCalledWith('ugt_draft_space', { city: 'london' }, expect.anything());
        expect(result.plan).toEqual({ draftRef: 'http://localhost/draft', cid: 'plan-1' });
        expect(result.planChanged).toBe(true); expect(result.outcome).toEqual({ type: 'reply', text: 'Done.' });
    });
    it('drafts and revises a private agreement on the working plan without exposing refs to the model', async () => {
        const agreementContent = (title, planCid = 'plan-1') => ({ schema: 'agreement/v1', title, planCid,
            inputs: { parcels: [] }, outputs: [], allocations: [], money: { currency: 'GBP' }, rule: { electorate: 'community', binding: false, settlement: null } });
        const agreementResult = (title, cid, previousCid) => ({ structuredContent: { cid, previousCid,
            draftRef: `https://mcp.example/${cid}`, previewUrl: `https://app.example/designs?draft=${cid}`,
            untrusted: { agreement: agreementContent(title) } } });
        const conversation = { plan: { draftRef: 'https://mcp.example/plan', cid: 'plan-1' } };
        const callModel = model({ content: [tool('ugt_draft_agreement', { title: 'First terms' })] },
            { content: [tool('ugt_edit_agreement', { terms: { title: 'Revised terms' } })] },
            { content: [{ type: 'text', text: 'The private agreement is ready to review.' }] });
        const callTool = vi.fn(async name => name === 'ugt_draft_agreement'
            ? agreementResult('First terms', 'agreement-1') : agreementResult('Revised terms', 'agreement-2', 'agreement-1'));
        const result = await runTurn({ ...base, conversation, callModel, callTool });
        expect(callTool.mock.calls[0][1]).toEqual({ title: 'First terms', plan: conversation.plan.draftRef });
        expect(callTool.mock.calls[1][1]).toEqual({ terms: { title: 'Revised terms' }, plan: 'https://mcp.example/agreement-1', expectedCid: 'agreement-1' });
        expect(result.agreement).toMatchObject({ cid: 'agreement-2', planCid: 'plan-1' });
        expect(result.agreementHistory).toHaveLength(2);
        expect(result.agreementHistory[0]).toBeNull();
        expect(result.agreementHistory[1]).toMatchObject({ cid: 'agreement-1', planCid: 'plan-1' });
        expect(result.agreementChanged).toBe(true);
        const modelResults = result.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
        expect(JSON.stringify(modelResults)).not.toContain('https://mcp.example');
        expect(JSON.stringify(modelResults)).not.toContain('agreement-1');
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
