export const DEFAULT_CHAT_PROVIDER = 'anthropic';
export const DEFAULT_CHAT_MODEL = 'claude-haiku-5-5';
export const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-6-luna';
export const CHAT_MODELS = Object.freeze({ anthropic: Object.freeze([DEFAULT_CHAT_MODEL]), openai: Object.freeze([DEFAULT_OPENAI_CHAT_MODEL]) });
export function modelForProvider(provider = DEFAULT_CHAT_PROVIDER) {
    if (provider === 'anthropic') return DEFAULT_CHAT_MODEL;
    if (provider === 'openai') return DEFAULT_OPENAI_CHAT_MODEL;
    return null;
}
export const isSupportedChatModel = (provider, model) => CHAT_MODELS[provider]?.includes(model) === true;
