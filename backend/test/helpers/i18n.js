// Load the real locale runtime and JSON dictionaries for feature tests, without a browser or network.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../../frontend/js/i18n.js', import.meta.url), 'utf8');
export function dictionary(language) {
    return JSON.parse(readFileSync(new URL(`../../../frontend/i18n/${language}.json`, import.meta.url), 'utf8'));
}
function flatten(node, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object') flatten(value, path, out);
        else out[path] = value;
    }
    return out;
}
export function testI18n(language = 'en') {
    const win = { location: { search: `?lang=${language}` } };
    new Function('window', source)(win);
    for (const lang of new Set(['en', language])) win.i18n.registerTranslations(lang, flatten(dictionary(lang)));
    return win.i18n;
}
