// Unit tests for the frontend's share helpers (pure byte/string work — no DOM).
// These used to live in e2e/tests/share-roundtrip.spec.ts and e2e/tests/proposals-sharing.spec.ts,
// which booted Chromium to base64-encode five bytes.
//
// Which copy is under test: there is now exactly one of each. The share codec lives in
// proposals/sharing.js, and the generic escape/clone helpers in shared-utils.js. Both files used to
// have duplicate twins (in proposals/sharing-routes.js and proposals/core.js respectively) that the
// browser silently resolved by load order, so the copy under test was not always the copy that ran.
//
// decodeSharedPayload itself is not unit-tested: it reads SHARE_ENCODING_PREFIX_* and
// decodeBytesToJson as cross-file globals that only resolve because the browser loads these as
// classic scripts sharing one global scope. It is a legacy reader on its way out; shimming those
// globals in to test it would be busywork.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    base64UrlEncodeBytes,
    base64UrlDecodeToBytes,
    buildCityQueryParam
} = require('../../frontend/js/proposals/sharing.js');
const {
    deepClone,
    deepCloneArray,
    ensureArrayOfStrings,
    escapeHtml,
    stableStringify
} = require('../../frontend/js/shared-utils.js');

describe('stableStringify (proposal hash seed)', () => {
    // The bug: JSON.stringify(obj, sortedKeysArray) uses an array replacer, which drops nested keys.
    const oldSerializer = (o) => JSON.stringify(o, Object.keys(o).sort());

    it('is key-order independent', () => {
        expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    });

    it('yields the SAME string as the old array-replacer for a flat object (ids unchanged)', () => {
        const flat = { width: 20, length: 30, typology: 'single', height: 10, chamfer: 2, rotation: 45 };
        expect(stableStringify(flat)).toBe(oldSerializer(flat));
    });

    it('distinguishes objects that differ only in a NESTED value (the fix)', () => {
        const a = { width: 20, opts: { k: 1 } };
        const b = { width: 20, opts: { k: 2 } };
        // Old serializer collapses both nested objects to {} → same string (the bug).
        expect(oldSerializer(a)).toBe(oldSerializer(b));
        // stableStringify keeps the nested value → different strings.
        expect(stableStringify(a)).not.toBe(stableStringify(b));
    });

    it('sorts nested keys and preserves array order', () => {
        expect(stableStringify({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
        expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    });

    it('handles null/undefined deterministically', () => {
        expect(stableStringify({ a: null, b: undefined })).toBe('{"a":null,"b":null}');
        expect(stableStringify(null)).toBe('null');
    });
});

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

    // Regression: three global copies of escapeHtml disagreed here, and the one that won by load
    // order stringified null into the literal text "null" (and undefined into "undefined"), which
    // is what callers passing an absent name/description were actually rendering.
    it('renders null and undefined as an empty string, not "null"/"undefined"', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml('')).toBe('');
        expect(escapeHtml(0)).toBe('0');
        expect(escapeHtml(false)).toBe('false');
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
