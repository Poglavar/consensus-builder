// Unit tests for the frontend's share helpers (pure string work — no DOM).
// These used to live in e2e/tests/share-roundtrip.spec.ts and e2e/tests/proposals-sharing.spec.ts,
// which booted Chromium to test string helpers.
//
// Which copy is under test: there is exactly one of each. The generic escape/clone helpers live in
// shared-utils.js (proposals/core.js used to carry a duplicate twin that the browser silently
// resolved by load order, so the copy under test was not always the copy that ran), and the share
// link's city parameter in proposals/design-sync.js. The payload share codec went with the
// ?shared= links: a design is shared by its CID (/designs/<cid>).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
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
    // The function reads the window's CityConfigManager; a stub is enough to pin the contract, which
    // is "?city=<code or id>" or an empty string — never a bare "?city=". cadastre-key.test.js checks
    // the real configs: every city's link opens that city. design-sync.js installs it on the window
    // its browser part is given.
    const withCityManager = (manager, fn) => {
        const win = { CityConfigManager: manager };
        DesignSync.browser(win);
        return fn(win.buildCityQueryParam);
    };
    const manager = (overrides = {}) => ({
        resolveCityId: id => ({ zagreb: 'zagreb', zg: 'zagreb', paris: 'paris' })[String(id).toLowerCase()] || null,
        getCurrentCityId: () => 'zagreb',
        getCityCodeForCityId: id => (id === 'zagreb' ? 'zg' : null),
        ...overrides
    });

    it('names the proposal\'s own city, by its code where it has one, else by its id', () => {
        expect(withCityManager(manager(), buildCityQueryParam => buildCityQueryParam('zagreb'))).toBe('?city=zg');
        // most cities have no short code: the link used to carry no city at all for them
        expect(withCityManager(manager(), buildCityQueryParam => buildCityQueryParam('paris'))).toBe('?city=paris');
    });

    it('falls back to the current city when the proposal names none the app knows', () => {
        expect(withCityManager(manager(), buildCityQueryParam => buildCityQueryParam())).toBe('?city=zg');
        expect(withCityManager(manager(), buildCityQueryParam => buildCityQueryParam('atlantis'))).toBe('?city=zg');
    });

    it('url-encodes the code', () => {
        expect(withCityManager(manager({ getCityCodeForCityId: () => 'n y' }), buildCityQueryParam => buildCityQueryParam())).toBe('?city=n%20y');
    });

    it('returns an empty string when there is no city at all', () => {
        expect(withCityManager(manager({ getCurrentCityId: () => null }), buildCityQueryParam => buildCityQueryParam())).toBe('');
        expect(withCityManager(null, buildCityQueryParam => buildCityQueryParam('zagreb'))).toBe('');
    });
});

const utils = require('../../frontend/js/shared-utils.js');

describe('inlineJsArg', () => {
    // What the browser does with onclick="f(ARG)": decode entities, then run the text as JavaScript.
    const decodeAttribute = text => text.replace(/&(quot|#39|lt|gt|amp);/g, (_m, name) => ({ quot: '"', '#39': "'", lt: '<', gt: '>', amp: '&' })[name]);
    const runHandler = arg => {
        let injected = false;
        const received = new Function('f', 'mark', `return f(${decodeAttribute(arg)})`)(value => value, () => { injected = true; });
        return { received, injected };
    };

    it('keeps hostile proposal ids a single string argument, never code', () => {
        for (const id of ["x'+mark()+'", 'x"+mark()+"', "x');mark();('", 'x");mark();("', 'a\\\'b', '</button><img src=x onerror=mark()>', "it's", '42']) {
            const arg = utils.inlineJsArg(id);
            expect(arg).not.toMatch(/["'<>]/);
            expect(runHandler(arg)).toEqual({ received: id, injected: false });
        }
    });

    it('shows why HTML-escaping alone was not enough', () => {
        const escapedOnly = `'${utils.escapeHtml("x'+mark()+'")}'`;
        expect(runHandler(escapedOnly).injected).toBe(true);
    });
});
