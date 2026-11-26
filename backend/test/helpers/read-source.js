// A ReadSource (frontend/js/chain/read-source.js) for a fake window: the chosen `source` is set as a
// link's ?readFrom= sets it, over an in-memory storage, so loaders read where a test says.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ReadSource = require('../../../frontend/js/chain/read-source.js');

export function readSource(source = 'server', { stored = new Map() } = {}) {
    const href = `https://app.example.test/?${ReadSource.PARAM}=${source}`;
    const win = {
        location: { search: `?${ReadSource.PARAM}=${source}`, href },
        localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
        history: { state: null, replaceState() {} }
    };
    return Object.freeze({ ...ReadSource, ...ReadSource.browser(win) });
}
