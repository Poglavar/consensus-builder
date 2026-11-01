import { CHAT_MAX_INPUT_TOKENS } from './cost.js';

export const MAX_CHAT_INPUT_TOKENS = CHAT_MAX_INPUT_TOKENS;
const endpoint = 'https://api.openai.com/v1/responses';
const tokenEndpoint = `${endpoint}/input_tokens`;

const openAITools = tools => tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description || '', strict: false, parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} } }));
function inputItems(messages = []) {
    return messages.flatMap(message => {
        const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];
        return content.flatMap(block => {
            if (block.type === 'tool_use') return [{ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) }];
            if (block.type === 'tool_result') return [{ type: 'function_call_output', call_id: block.tool_use_id, output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') }];
            if (block.type === 'text') return [{ type: 'message', role: message.role, content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(block.text ?? '') }] }];
            return [];
        });
    });
}
function normalizedResponse(response) {
    const content = [];
    let refused = false;
    for (const item of response.output || []) {
        if (item.type === 'message') for (const block of item.content || []) {
            if (block.type === 'output_text') content.push({ type: 'text', text: block.text });
            else if (block.type === 'refusal') { refused = true; content.push({ type: 'text', text: block.refusal }); }
        }
        if (item.type === 'function_call') {
            let input = {};
            let name = item.name;
            try {
                input = JSON.parse(item.arguments || '{}');
                if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Tool arguments must be a JSON object.');
            }
            catch {
                // The turn runner rejects this deliberately unknown name without calling any tool,
                // while retaining the provider response and its usage for settlement.
                name = '__invalid_tool_arguments__';
                input = { malformedArguments: String(item.arguments || '').slice(0, 1000) };
            }
            content.push({ type: 'tool_use', id: item.call_id, name, input });
        }
    }
    const usage = response.usage || {};
    const cached = Number(usage.input_tokens_details?.cached_tokens) || 0;
    const totalInput = Number(usage.input_tokens) || 0;
    return {
        content,
        stop_reason: refused ? 'refusal' : response.status === 'incomplete' ? 'max_tokens' : response.output?.some(item => item.type === 'function_call') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: Math.max(0, totalInput - cached), cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: Number(usage.output_tokens) || 0 },
        model: response.model
    };
}

export function createOpenAIModelCaller({ apiKey, model = process.env.CHAT_MODEL, timeoutMs = 60_000, client, fetchImpl = fetch } = {}) {
    if (!client && !apiKey) throw new Error('OpenAI API key is required.');
    const request = client ? async (path, body, options) => {
        if (path === tokenEndpoint) return client.responses.inputTokens.count(body, options);
        return client.responses.create(body, options);
    } : async (path, body, { signal } = {}) => {
        const response = await fetchImpl(path, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)) });
        if (!response.ok) throw Object.assign(new Error(`OpenAI request failed (${response.status}).`), { status: response.status });
        return response.json();
    };
    return async ({ system, tools = [], messages = [], toolChoice }, { signal } = {}) => {
        const payload = { model, instructions: system, input: inputItems(messages), tools: openAITools(tools), max_output_tokens: 2048, store: false,
            reasoning: { effort: 'low' }, parallel_tool_calls: false,
            ...(toolChoice?.type === 'none' ? { tool_choice: 'none' } : { tool_choice: 'auto' }) };
        let counted;
        try { counted = await request(tokenEndpoint, { model, instructions: system, input: payload.input, tools: payload.tools, parallel_tool_calls: false }, { signal, timeout: timeoutMs, maxRetries: 0 }); }
        catch (cause) { throw Object.assign(new Error('Could not verify the chat prompt size; no model request was sent.'), { code: 'token-count-failed', noModelCall: true, cause }); }
        const inputTokens = counted?.input_tokens;
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw Object.assign(new Error('The prompt size could not be verified.'), { code: 'token-count-failed', noModelCall: true });
        if (inputTokens > MAX_CHAT_INPUT_TOKENS) throw Object.assign(new Error(`This conversation is too long for another turn (${inputTokens} input tokens; maximum ${MAX_CHAT_INPUT_TOKENS}).`), { code: 'context-limit', noModelCall: true, inputTokens, maxInputTokens: MAX_CHAT_INPUT_TOKENS });
        let response;
        try { response = await request(endpoint, payload, { signal, timeout: timeoutMs, maxRetries: 0 }); }
        catch (cause) { throw Object.assign(new Error('The agent could not finish this turn.'), { code: signal?.aborted ? 'aborted' : 'model-unavailable', cause }); }
        return normalizedResponse(response);
    };
}
