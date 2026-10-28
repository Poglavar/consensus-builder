// The CITY_CONFIGS source of truth (frontend/data/city-configs.js) read as TEXT: the literal is cut
// out and evaluated in a vm, never imported, with Infinity kept through JSON round trips.
import vm from 'node:vm';

export const CITY_CONFIGS_FILE = 'frontend/data/city-configs.js';
export const jsonReplacer = (_key, value) => value === Infinity ? { $number: 'Infinity' } : value === -Infinity ? { $number: '-Infinity' } : value;
export const jsonReviver = (_key, value) => value && value.$number === 'Infinity' ? Infinity : value && value.$number === '-Infinity' ? -Infinity : value;

export function objectLiteralAt(source, marker) {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing ${marker}`);
    const open = source.indexOf('{', start + marker.length);
    let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        const next = source[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error(`Unclosed ${marker}`);
}

export function parseCityConfigs(source) {
    const literal = objectLiteralAt(source, 'const CITY_CONFIGS =');
    const context = vm.createContext({ SHARED_DEFAULT_ZOOM: 19, Infinity, NaN,
        exploreView: { lat: 30, lon: 15, zoom: 3 },
        translateCityText: (_key, fallback) => fallback, formatCityText: value => value });
    return JSON.parse(JSON.stringify(vm.runInContext(`(${literal})`, context, { timeout: 1000 }), jsonReplacer), jsonReviver);
}
