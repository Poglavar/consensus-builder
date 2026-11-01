import { createAnthropicModelCaller } from './anthropic.js';
import { createOpenAIModelCaller } from './openai.js';
import { DEFAULT_CHAT_PROVIDER, isSupportedChatModel, modelForProvider } from './openai-config.js';

export { MAX_CHAT_INPUT_TOKENS, createAnthropicModelCaller } from './anthropic.js';
export { createOpenAIModelCaller } from './openai.js';

export function createChatModelCaller({ provider = process.env.CHAT_PROVIDER || DEFAULT_CHAT_PROVIDER, ...options } = {}) {
    const model = options.model || modelForProvider(provider);
    if (!isSupportedChatModel(provider, model)) throw new Error('Chat provider and model are not configured as a supported pair.');
    const configured = { ...options, model };
    if (provider === 'anthropic') return createAnthropicModelCaller(configured);
    if (provider === 'openai') return createOpenAIModelCaller(configured);
    throw new Error('Chat provider must be anthropic or openai.');
}
