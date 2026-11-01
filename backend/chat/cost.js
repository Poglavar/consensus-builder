// Chat token prices are operator configuration; missing prices fail closed so budget checks cannot silently become free.
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const PRICE_KEYS = ['input', 'output', 'cache_read', 'cache_creation'];
export const CHAT_MAX_INPUT_TOKENS = 60_000;
function assertPrices(prices) {
    if (!prices || PRICE_KEYS.some(key => number(prices[key]) == null)) throw new Error('Valid chat model token prices are required.');
}
export function pricesFromEnv(env = process.env) {
    const prices = { input: number(env.CHAT_PRICE_USD_PER_MTOK_INPUT), output: number(env.CHAT_PRICE_USD_PER_MTOK_OUTPUT), cache_read: number(env.CHAT_PRICE_USD_PER_MTOK_CACHE_READ), cache_creation: number(env.CHAT_PRICE_USD_PER_MTOK_CACHE_WRITE) };
    if (Object.values(prices).some(value => value == null)) throw new Error('Chat model token prices must be configured as non-negative numbers.');
    return prices;
}
export function costUsd(usage = {}, prices = {}) {
    assertPrices(prices);
    const amount = number(usage.input_tokens) * number(prices.input) + number(usage.cache_read_input_tokens) * number(prices.cache_read) + number(usage.cache_creation_input_tokens) * number(prices.cache_creation) + number(usage.output_tokens) * number(prices.output);
    return Math.round(amount / 1_000_000 * 1_000_000) / 1_000_000;
}
export function estimateTurnUsd(prices, limits = {}) {
    assertPrices(prices);
    const steps = Number(limits.maxSteps) || 8;
    const calls = steps + 1; // Include the forced closing call after the maximum tool steps.
    return Math.round(calls * (CHAT_MAX_INPUT_TOKENS * (Number(prices.input) + Number(prices.cache_creation)) + 2_048 * Number(prices.output)) / 1_000_000 * 1_000_000) / 1_000_000;
}
