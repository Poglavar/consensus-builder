// The city configuration manager as node tests evaluate it: the source list (frontend/js/source-list.js),
// every city's configuration (frontend/data/city-configs.js) and the manager (frontend/js/city-config.js). Both are
// self-contained IIFEs, so the joined text runs in any realm: vm, (0, eval) or new Function.
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../../../frontend/${file}`, import.meta.url), 'utf8');
let source = null;
export function cityConfigSource() {
    if (source === null) source = `${read('js/source-list.js')}\n${read('data/city-configs.js')}\n${read('js/city-config.js')}`;
    return source;
}
