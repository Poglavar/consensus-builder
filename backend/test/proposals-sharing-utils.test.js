// Unit tests for the frontend's share-link encoding helpers (pure byte/string work — no DOM).
// These used to live in e2e/tests/share-roundtrip.spec.ts and e2e/tests/proposals-sharing.spec.ts,
// which booted Chromium to base64-encode five bytes.
//
// NOTE: compressBytes/inflateBytes are deliberately NOT covered here — they delegate to `pako`,
// which the app loads from a CDN and which is not an npm dependency, so in node they take their
// no-compression fallback path. Their real round-trip stays in the Playwright suite.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    base64UrlEncodeBytes,
    base64UrlDecodeToBytes,
    deepClone,
    deepCloneArray,
    ensureArrayOfStrings,
    escapeHtml,
    buildCityQueryParam
} = require('../../frontend/js/proposals/sharing.js');

describe('base64url encoding', () => {
    it('round-trips arbitrary bytes, including 0x00 and 0xFF', () => {
        const input = new Uint8Array([0, 1, 127, 128, 255, 72, 101, 108, 108, 111]);
        const decoded = base64UrlDecodeToBytes(base64UrlEncodeBytes(input));
        expect(Array.from(decoded)).toEqual(Array.from(input));
    });

    it('emits url-safe output: no +, no / and no = padding', () => {
        // 0xFB 0xFF 0xFE encodes to "+//+" style characters in standard base64.
        const encoded = base64UrlEncodeBytes(new Uint8Array([251, 255, 254, 0, 1]));
        expect(encoded).not.toContain('+');
        expect(encoded).not.toContain('/');
        expect(encoded).not.toContain('=');
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('decodes correctly regardless of how much padding was stripped', () => {
        for (let length = 1; length <= 8; length++) {
            const input = new Uint8Array(Array.from({ length }, (_, i) => (i * 37) % 256));
            const decoded = base64UrlDecodeToBytes(base64UrlEncodeBytes(input));
            expect(Array.from(decoded), `length ${length}`).toEqual(Array.from(input));
        }
    });

    it('returns an empty string for an empty or non-Uint8Array input', () => {
        expect(base64UrlEncodeBytes(new Uint8Array([]))).toBe('');
        expect(base64UrlEncodeBytes(null)).toBe('');
        expect(base64UrlEncodeBytes([1, 2, 3])).toBe('');
    });
});

describe('escapeHtml', () => {
    it('neutralises an injected script tag', () => {
        const escaped = escapeHtml('<script>alert("xss")</script>');
        expect(escaped).not.toContain('<script>');
        expect(escaped).toContain('&lt;');
        expect(escaped).toContain('&gt;');
    });

    it('escapes every dangerous character', () => {
        expect(escapeHtml(`<img src=x onerror="alert('xss')">&"'`))
            .toBe('&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&amp;&quot;&#39;');
    });

    it('escapes the ampersand first, so an entity is not double-escaped into nonsense', () => {
        expect(escapeHtml('a & b')).toBe('a &amp; b');
    });
});

describe('deepClone', () => {
    it('produces an independent copy — mutating the clone leaves the original alone', () => {
        const original = { a: 1, b: { c: [1, 2, 3] } };
        const clone = deepClone(original);
        clone.b.c.push(4);
        expect(original.b.c).toHaveLength(3);
        expect(clone.b.c).toHaveLength(4);
    });

    it('passes undefined through and returns null for a value it cannot clone', () => {
        expect(deepClone(undefined)).toBeUndefined();
        const circular = {};
        circular.self = circular;
        expect(deepClone(circular)).toBeNull();
    });

    it('deepCloneArray clones each element and returns [] for a non-array', () => {
        const source = [{ x: 1 }, { x: 2 }];
        const cloned = deepCloneArray(source);
        cloned[0].x = 99;
        expect(source[0].x).toBe(1);
        expect(deepCloneArray(null)).toEqual([]);
    });
});

describe('ensureArrayOfStrings', () => {
    it('stringifies entries and drops the empty ones', () => {
        expect(ensureArrayOfStrings(['a', 1, null, undefined, '', 'b'])).toEqual(['a', '1', 'b']);
    });

    it('returns [] for a non-array', () => {
        expect(ensureArrayOfStrings('not-an-array')).toEqual([]);
    });
});

describe('buildCityQueryParam', () => {
    // The function reads window.CityConfigManager; a stub is enough to pin the contract, which is
    // "?city=<code>" or an empty string — never a bare "?city=".
    const withCityManager = (manager, fn) => {
        const hadWindow = 'window' in globalThis;
        const previous = globalThis.window;
        globalThis.window = { CityConfigManager: manager };
        try {
            return fn();
        } finally {
            if (hadWindow) globalThis.window = previous;
            else delete globalThis.window;
        }
    };

    it('builds the query param from the current city code', () => {
        const result = withCityManager({
            getCurrentCityConfig: () => ({ id: 'zagreb' }),
            getCityCodeForCityId: (id) => (id === 'zagreb' ? 'zg' : null)
        }, () => buildCityQueryParam());
        expect(result).toBe('?city=zg');
    });

    it('url-encodes the code', () => {
        const result = withCityManager({
            getCurrentCityConfig: () => ({ id: 'new_york' }),
            getCityCodeForCityId: () => 'n y'
        }, () => buildCityQueryParam());
        expect(result).toBe('?city=n%20y');
    });

    it('returns an empty string when the city cannot be resolved', () => {
        expect(withCityManager({
            getCurrentCityConfig: () => null,
            getCityCodeForCityId: () => 'zg'
        }, () => buildCityQueryParam())).toBe('');

        expect(withCityManager({
            getCurrentCityConfig: () => ({ id: 'atlantis' }),
            getCityCodeForCityId: () => null
        }, () => buildCityQueryParam())).toBe('');
    });
});
