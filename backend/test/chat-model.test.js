// The provider boundary verifies the token ceiling before paid calls and preserves exact model settings.
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicModelCaller, MAX_CHAT_INPUT_TOKENS } from '../chat/model.js';
import { pricesFromEnv, estimateTurnUsd, costUsd } from '../chat/cost.js';
const input = { system: 'Design places.', tools: [], messages: [{ role: 'user', content: 'A park.' }] };
describe('chat model boundary', () => {
    it('counts before the paid call and uses the bounded tool policy without retrying', async () => {
        const client = { messages: { countTokens: vi.fn(async () => ({ input_tokens: 100 })), create: vi.fn(async () => ({ content: [{ type: 'text', text: 'Ready' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 }, model: 'test' })) } };
        const call = createAnthropicModelCaller({ client, model: 'test' });
        const result = await call(input);
        expect(client.messages.countTokens.mock.invocationCallOrder[0]).toBeLessThan(client.messages.create.mock.invocationCallOrder[0]);
        expect(client.messages.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'test', max_tokens: 2048,
            tool_choice: { type: 'auto', disable_parallel_tool_use: true }, output_config: { effort: 'low' } }), expect.objectContaining({ maxRetries: 0 }));
        expect(client.messages.create.mock.calls[0][0]).not.toHaveProperty('temperature');
        expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 10 });
        await call({ ...input, toolChoice: { type: 'none' } });
        expect(client.messages.create.mock.calls[1][0].tool_choice).toEqual({ type: 'none' });
    });
    it.each([MAX_CHAT_INPUT_TOKENS + 1, undefined, NaN])('never sends an over-budget or unverified prompt (%s)', async count => {
        const client = { messages: { countTokens: vi.fn(async () => ({ input_tokens: count })), create: vi.fn() } };
        await expect(createAnthropicModelCaller({ client, model: 'test' })(input)).rejects.toMatchObject({ noModelCall: true });
        expect(client.messages.create).not.toHaveBeenCalled();
    });
    it('redacts provider failures while marking count failures as uncharged', async () => {
        const client = { messages: { countTokens: vi.fn(async () => { throw new Error('private-provider-detail'); }), create: vi.fn() } };
        await expect(createAnthropicModelCaller({ client, model: 'test' })(input)).rejects.toMatchObject({ noModelCall: true, code: 'token-count-failed' });
        client.messages.countTokens.mockResolvedValue({ input_tokens: 100 });
        client.messages.create.mockRejectedValue(new Error('private-provider-detail'));
        await expect(createAnthropicModelCaller({ client, model: 'test' })(input)).rejects.toMatchObject({ message: 'The agent could not finish this turn.', code: 'model-unavailable' });
    });
    it('requires operator pricing and reserves every call including the closing call', () => {
        expect(() => pricesFromEnv({})).toThrow(/configured/);
        expect(() => costUsd({}, { input: null, output: 0, cache_read: 0, cache_creation: 0 })).toThrow(/prices/);
        expect(() => pricesFromEnv({ CHAT_PRICE_USD_PER_MTOK_INPUT: '', CHAT_PRICE_USD_PER_MTOK_OUTPUT: 0, CHAT_PRICE_USD_PER_MTOK_CACHE_READ: 0, CHAT_PRICE_USD_PER_MTOK_CACHE_WRITE: 0 })).toThrow(/configured/);
        const prices = { input: .1, output: .5, cache_read: .01, cache_creation: .125 };
        expect(estimateTurnUsd(prices, { maxSteps: 8 })).toBeGreaterThanOrEqual(costUsd({ cache_creation_input_tokens: 9 * MAX_CHAT_INPUT_TOKENS, output_tokens: 9 * 2048 }, prices));
    });
});
