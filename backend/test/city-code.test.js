// The city id a request's city parameter names (utils/city-code.js), shared by the design, agreement,
// market and activity routes: every short code the frontend can send maps to its full city id.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeCityCode } from '../utils/city-code.js';

describe('normalizeCityCode', () => {
    // The frontend sends short codes (CITY_QUERY_MAP in frontend/js/city-config.js) while designs and
    // agreements are indexed under the full city id. A code that fails to map silently filters out
    // every record of that city — which is exactly what `ny` did.
    //
    // Read the codes OUT OF the frontend rather than restating them here. A hand-copied fixture is
    // what let `st` go unmapped for the whole life of the Split city: the list was written once,
    // Split was added later, and a test comparing a copy to itself stayed green over the gap. Now
    // adding a city to CITY_QUERY_MAP without adding it to CITY_CODE_TO_ID fails this test.
    const cityConfigSrc = readFileSync(
        new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8'
    );
    const queryMapBlock = cityConfigSrc.match(/CITY_QUERY_MAP\s*=\s*\{([^}]*)\}/)?.[1] || '';
    const codeToId = Object.fromEntries(
        [...queryMapBlock.matchAll(/([\w-]+)\s*:\s*'([^']+)'/g)].map(m => [m[1], m[2]])
    );

    it('reads the frontend city codes (guards the regex above against a silent empty match)', () => {
        // An empty map would make the next test vacuously green — the exact failure mode this
        // rewrite exists to remove.
        expect(Object.keys(codeToId).length).toBeGreaterThanOrEqual(7);
        expect(codeToId.ny).toBe('new_york');
    });

    it('maps every city code the frontend can send to a full city id', () => {
        for (const [code, id] of Object.entries(codeToId)) {
            expect(normalizeCityCode(code)).toBe(id);
        }
    });

    it('accepts a full city id unchanged, so both forms work', () => {
        expect(normalizeCityCode('new_york')).toBe('new_york');
        expect(normalizeCityCode('zagreb')).toBe('zagreb');
    });

    it('is case- and whitespace-insensitive', () => {
        expect(normalizeCityCode('  NY  ')).toBe('new_york');
    });

    it('returns null for an empty code so no city filter is applied', () => {
        expect(normalizeCityCode('')).toBeNull();
        expect(normalizeCityCode(null)).toBeNull();
        expect(normalizeCityCode(undefined)).toBeNull();
    });
});
