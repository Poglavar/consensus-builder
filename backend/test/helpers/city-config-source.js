// The city configuration manager as node tests evaluate it: every city's configuration
// (frontend/data/city-configs.js) followed by the manager (frontend/js/city-config.js). Both are
// self-contained IIFEs, so the joined text runs in any realm: vm, (0, eval) or new Function.
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../../../frontend/${file}`, import.meta.url), 'utf8');
let source = null;
export function cityConfigSource() {
    if (source === null) source = `${read('data/city-configs.js')}\n${read('js/city-config.js')}`;
    return source;
}
