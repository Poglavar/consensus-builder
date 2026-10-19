// The city id the browser sends the API (frontend/js/proposals/core.js normalizeCityCodeForApi) comes
// from the city config's own short codes (CityConfigManager.resolveCityParam), so every code the app
// emits maps: `st` used to reach the API unmapped and file Split's plans under "st"
// (location-first.md phase 4).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const core = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/core.js', import.meta.url)), 'utf8');
const start = core.indexOf('function normalizeCityCodeForApi(');
const source = core.slice(start, core.indexOf('\n}\n', start) + 2);
const normalizeCityCodeForApi = new Function(`${source}; return normalizeCityCodeForApi;`)();

const previous = globalThis.CityConfigManager;
afterEach(() => { globalThis.CityConfigManager = previous; });

describe('normalizeCityCodeForApi', () => {
    it('maps every short code the city config knows, and passes ids through', () => {
        const codes = { zg: 'zagreb', st: 'split', si: 'sibenik', ny: 'new_york' };
        globalThis.CityConfigManager = { resolveCityParam: raw => codes[raw] || (Object.values(codes).includes(raw) ? raw : null) };
        expect(normalizeCityCodeForApi('st')).toBe('split');
        expect(normalizeCityCodeForApi('NY')).toBe('new_york');
        expect(normalizeCityCodeForApi('zagreb')).toBe('zagreb');
        expect(normalizeCityCodeForApi('atlantis')).toBe('atlantis');
        expect(normalizeCityCodeForApi('')).toBe('city');
    });

    it('passes a value through when no city config is loaded', () => {
        globalThis.CityConfigManager = undefined;
        expect(normalizeCityCodeForApi('st')).toBe('st');
    });
});
