// Anthropic Messages adapter for the existing normalized chat runner contract.
import Anthropic from '@anthropic-ai/sdk';
import { CHAT_MAX_INPUT_TOKENS } from './cost.js';

export const MAX_CHAT_INPUT_TOKENS = CHAT_MAX_INPUT_TOKENS;
export function createAnthropicModelCaller({ apiKey, model = process.env.CHAT_MODEL, timeoutMs = 60_000, client } = {}) {
    if (!client && !apiKey) throw new Error('Anthropic API key is required.');
    const anthropic = client || new Anthropic({ apiKey, maxRetries: 0 });
    return async ({ system, tools, messages, toolChoice }, { signal } = {}) => {
        const tokenParams = { model, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], tools, messages };
        let counted;
        try { counted = await anthropic.messages.countTokens(tokenParams, { signal, timeout: timeoutMs, maxRetries: 0 }); }
        catch (cause) { throw Object.assign(new Error('Could not verify the chat prompt size; no model request was sent.'), { code: 'token-count-failed', noModelCall: true, cause }); }
        if (!Number.isSafeInteger(counted?.input_tokens) || counted.input_tokens < 0) throw Object.assign(new Error('The prompt size could not be verified.'), { code: 'token-count-failed', noModelCall: true });
        if (counted.input_tokens > MAX_CHAT_INPUT_TOKENS) throw Object.assign(new Error(`This conversation is too long for another turn (${counted.input_tokens} input tokens; maximum ${MAX_CHAT_INPUT_TOKENS}).`), { code: 'context-limit', noModelCall: true, inputTokens: counted.input_tokens, maxInputTokens: MAX_CHAT_INPUT_TOKENS });
        let response;
        try { response = await anthropic.messages.create({ model, max_tokens: 2048, system: tokenParams.system, tools,
            tool_choice: toolChoice || { type: 'auto', disable_parallel_tool_use: true }, output_config: { effort: 'low' }, messages },
        { signal, timeout: timeoutMs, maxRetries: 0 }); }
        catch (cause) { throw Object.assign(new Error('The agent could not finish this turn.'), { code: signal?.aborted ? 'aborted' : 'model-unavailable', cause }); }
        return { content: response.content, stop_reason: response.stop_reason, usage: response.usage, model: response.model };
    };
}
