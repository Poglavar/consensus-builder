import { describe, expect, it, vi } from 'vitest';
import { createChatModelCaller, createOpenAIModelCaller, MAX_CHAT_INPUT_TOKENS } from '../chat/model.js';
import { pricesFromEnv, estimateTurnUsd, costUsd } from '../chat/cost.js';
import { DEFAULT_CHAT_PROVIDER, isSupportedChatModel, modelForProvider } from '../chat/openai-config.js';

const input = { system: 'Design places.', tools: [{ name: 'find', input_schema: { type: 'object', properties: { query: { type: 'string' }, optional: { type: 'string' } }, required: ['query'], additionalProperties: false } }], messages: [{ role: 'user', content: 'A park.' }] };
const clientStub = (tokenCount = 100) => ({ responses: {
    inputTokens: { count: vi.fn(async () => ({ input_tokens: tokenCount })) },
    create: vi.fn(async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ready' }] }], status: 'completed', usage: { input_tokens: 100, output_tokens: 10 }, model: 'test' }))
} });

describe('chat model boundary', () => {
    it('keeps Anthropic as the default and selects provider-specific models', async () => {
        expect(DEFAULT_CHAT_PROVIDER).toBe('anthropic');
        expect(modelForProvider('anthropic')).toBe('claude-haiku-5-5');
        expect(modelForProvider('openai')).toBe('gpt-6-luna');
        expect(isSupportedChatModel('openai', 'gpt-6-luna')).toBe(true);
        expect(isSupportedChatModel('anthropic', 'gpt-6-luna')).toBe(false);
        const client = { messages: { countTokens: vi.fn(async () => ({ input_tokens: 1 })), create: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} })) } };
        await createChatModelCaller({ client, provider: 'anthropic', model: 'claude-haiku-5-5' })(input);
        expect(client.messages.create).toHaveBeenCalledTimes(1);
    });
    it('counts before the paid call and sends a bounded, sequential Responses request', async () => {
        const client = clientStub(), call = createOpenAIModelCaller({ client, model: 'test' });
        const result = await call(input);
        expect(client.responses.inputTokens.count.mock.invocationCallOrder[0]).toBeLessThan(client.responses.create.mock.invocationCallOrder[0]);
        expect(client.responses.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'test', max_output_tokens: 2048,
            tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort: 'low' }, store: false,
            tools: [{ type: 'function', name: 'find', description: '', strict: false, parameters: { type: 'object', properties: { query: { type: 'string' }, optional: { type: 'string' } }, required: ['query'], additionalProperties: false } }] }), expect.objectContaining({ maxRetries: 0 }));
        expect(result).toMatchObject({ content: [{ type: 'text', text: 'Ready' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } });
        await call({ ...input, toolChoice: { type: 'none' } });
        expect(client.responses.create.mock.calls[1][0].tool_choice).toBe('none');
    });
    it.each([MAX_CHAT_INPUT_TOKENS + 1, undefined, NaN])('never sends an over-budget or unverified prompt (%s)', async count => {
        const client = clientStub(count);
        if (count === undefined) client.responses.inputTokens.count.mockResolvedValue({ input_tokens: undefined });
        await expect(createOpenAIModelCaller({ client, model: 'test' })(input)).rejects.toMatchObject({ noModelCall: true });
        expect(client.responses.create).not.toHaveBeenCalled();
    });
    it('maps tool calls and tool results through normalized runTurn messages', async () => {
        const client = clientStub();
        client.responses.create.mockResolvedValueOnce({ output: [{ type: 'function_call', call_id: 'call-1', name: 'find', arguments: '{"q":"park"}' }], usage: {} });
        const call = createOpenAIModelCaller({ client, model: 'test' });
        const result = await call(input);
        expect(result.content).toEqual([{ type: 'tool_use', id: 'call-1', name: 'find', input: { q: 'park' } }]);
        await call({ ...input, messages: [...input.messages, { role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"ok":true}' }] }] });
        expect(client.responses.inputTokens.count.mock.calls[1][0].input).toEqual([
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A park.' }] },
            { type: 'function_call', call_id: 'call-1', name: 'find', arguments: '{"q":"park"}' },
            { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' }
        ]);
        client.responses.create.mockResolvedValueOnce({ output: [{ type: 'function_call', call_id: 'call-2', name: 'find', arguments: '{invalid' }], usage: { input_tokens: 12, output_tokens: 3 } });
        const invalid = await call(input);
        expect(invalid.content).toEqual([{ type: 'tool_use', id: 'call-2', name: '__invalid_tool_arguments__', input: { malformedArguments: '{invalid' } }]);
        expect(invalid.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
    });
    it('redacts provider failures while marking count failures as uncharged', async () => {
        const client = clientStub();
        client.responses.inputTokens.count.mockRejectedValue(new Error('private-provider-detail'));
        await expect(createOpenAIModelCaller({ client, model: 'test' })(input)).rejects.toMatchObject({ noModelCall: true, code: 'token-count-failed' });
        client.responses.inputTokens.count.mockResolvedValue({ input_tokens: 100 });
        client.responses.create.mockRejectedValue(new Error('private-provider-detail'));
        await expect(createOpenAIModelCaller({ client, model: 'test' })(input)).rejects.toMatchObject({ message: 'The agent could not finish this turn.', code: 'model-unavailable' });
    });
    it('requires operator pricing and reserves every call including the closing call', () => {
        expect(() => pricesFromEnv({})).toThrow(/configured/);
        expect(() => costUsd({}, { input: null, output: 0, cache_read: 0, cache_creation: 0 })).toThrow(/prices/);
        expect(() => pricesFromEnv({ CHAT_PRICE_USD_PER_MTOK_INPUT: '', CHAT_PRICE_USD_PER_MTOK_OUTPUT: 0, CHAT_PRICE_USD_PER_MTOK_CACHE_READ: 0, CHAT_PRICE_USD_PER_MTOK_CACHE_WRITE: 0 })).toThrow(/configured/);
        const prices = { input: .1, output: .5, cache_read: .01, cache_creation: .125 };
        expect(estimateTurnUsd(prices, { maxSteps: 8 })).toBeGreaterThanOrEqual(costUsd({ cache_creation_input_tokens: 9 * MAX_CHAT_INPUT_TOKENS, output_tokens: 9 * 2048 }, prices));
    });
});
