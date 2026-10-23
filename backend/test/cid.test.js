// Unit tests for the content identifiers of published designs and agreements: frontend/js/cid.js (the
// browser module) and backend/cid.js (its node twin used by the courier and the index). CIDv1, codec
// UnixFS with raw leaves, sha2-256, base32 lower case over canonical JSON bytes; both twins must give the same answers.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
let Node;
beforeAll(async () => { Node = await import('../cid.js'); });

const EMPTY_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const HELLO_CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const HELLO_DIGEST = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const utf8 = text => new TextEncoder().encode(text);
const text = bytes => new TextDecoder().decode(bytes);
const hex = bytes => Buffer.from(bytes).toString('hex');
const thrownCode = fn => { try { fn(); } catch (error) { return error.code; } return null; };

// RFC 4648 base32, lower case, no padding: only to spell CIDs these modules must refuse.
function base32(bytes) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            out += alphabet[(buffer >>> bits) & 31];
        }
        buffer &= (1 << bits) - 1;
    }
    return bits ? out + alphabet[(buffer << (5 - bits)) & 31] : out;
}
const spell = (prefix, digest) => 'b' + base32(Buffer.concat([Buffer.from(prefix), digest]));
const sha256 = bytes => createHash('sha256').update(bytes).digest();

describe('cidOf', () => {
    it('gives the known CIDs of the empty file and of "hello" (ipfs add --cid-version=1 --raw-leaves)', () => {
        expect(Cid.cidOf(new Uint8Array(0))).toBe(EMPTY_CID);
        expect(Cid.cidOf(utf8('hello'))).toBe(HELLO_CID);
        expect(hex(Cid.parse(HELLO_CID).digest)).toBe(HELLO_DIGEST);
    });

    it('is the multibase b, then version 1, codec raw, sha2-256 and its 32-byte digest', () => {
        const bytes = utf8('{"schema":"design/v1"}');
        const cid = Cid.cidOf(bytes);
        expect(cid).toBe(spell([0x01, 0x55, 0x12, 0x20], sha256(bytes)));
        expect(cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
        expect(Cid.parse(cid)).toEqual({ version: 1, codec: 0x55, digest: new Uint8Array(sha256(bytes)) });
    });

    it('uses the same UnixFS file root in browser and server for multi-megabyte JSON', () => {
        const object = { schema: 'design/v1', geometry: { coordinates: Array.from({ length: 40000 }, (_, i) => [10 + i / 1000000, 45 + i / 2000000]) } };
        const bytes = Cid.canonicalBytes(object);
        expect(bytes.length).toBeGreaterThan(256 * 1024);
        const cid = Cid.cidOf(bytes);
        expect(Cid.parse(cid).codec).toBe(0x70);
        expect(Node.cidOf(bytes)).toBe(cid);
        expect(Node.isCid(cid)).toBe(true);
    });

    it('hashes binary chunks even when a Unicode character straddles a chunk boundary', () => {
        const prefix = '{"text":"';
        const bytes = utf8(prefix + 'x'.repeat(256 * 1024 - prefix.length - 1) + '🌇雪ž"}');
        expect(thrownCode(() => Cid.cidOf(bytes.subarray(0, 256 * 1024)))).toBe('invalid-cid-input');
        expect(Cid.cidOf(bytes)).toBe(Node.cidOf(bytes));
        expect(Cid.parse(Cid.cidOf(bytes)).codec).toBe(0x70);
    });

    it('needs a Uint8Array and, in the browser, UTF-8 bytes', () => {
        for (const value of ['hello', [104, 105], utf8('hi').buffer, null]) {
            expect(thrownCode(() => Cid.cidOf(value))).toBe('invalid-cid-input');
        }
        expect(thrownCode(() => Cid.cidOf(Uint8Array.of(0xff, 0xfe)))).toBe('invalid-cid-input');
        // A byte order mark is kept as the bytes it is, not dropped by the decoder.
        const withBom = Uint8Array.of(0xef, 0xbb, 0xbf, 0x68, 0x69);
        expect(Cid.cidOf(withBom)).toBe(spell([0x01, 0x55, 0x12, 0x20], sha256(withBom)));
        expect(Cid.cidOf(withBom)).not.toBe(Cid.cidOf(utf8('hi')));
    });
});

describe('canonicalBytes', () => {
    it('sorts keys at every depth, writes no whitespace and leaves undefined keys out', () => {
        const bytes = Cid.canonicalBytes({ b: 1, a: { d: [1, undefined, { z: 1, y: 2 }], c: undefined }, e: 'x y' });
        expect(text(bytes)).toBe('{"a":{"d":[1,null,{"y":2,"z":1}]},"b":1,"e":"x y"}');
        expect(Cid.cidOfObject({ a: 1, b: [2, 3] })).toBe(Cid.cidOfObject({ b: [2, 3], a: 1 }));
        expect(Cid.cidOfObject({ a: [2, 3] })).not.toBe(Cid.cidOfObject({ a: [3, 2] }));
    });

    it('orders keys by code unit, not by locale, and encodes text as UTF-8', () => {
        expect(text(Cid.canonicalBytes({ ž: 1, a: 2, B: 3, Z: 4 }))).toBe('{"B":3,"Z":4,"a":2,"ž":1}');
        expect(Array.from(Cid.canonicalBytes('ž'))).toEqual([0x22, 0xc5, 0xbe, 0x22]);
    });

    it('is the CID input: cidOfObject is cidOf of these bytes', () => {
        const object = { schema: 'agreement/v1', designs: [{ cid: HELLO_CID }], money: { lines: [] } };
        expect(Cid.cidOfObject(object)).toBe(Cid.cidOf(Cid.canonicalBytes(object)));
    });

    it('refuses values JSON would turn into something else', () => {
        const refused = [
            { a: NaN }, { a: Infinity }, [1, -Infinity], { when: new Date(0) }, { map: new Map() },
            { bytes: new Uint8Array(2) }, { big: 10n }, { fn() {} }, undefined, Symbol('x')
        ];
        refused.forEach(value => expect(thrownCode(() => Cid.canonicalBytes(value)), String(value)).toBe('invalid-cid-input'));
        expect(thrownCode(() => Cid.cidOfObject({ a: NaN }))).toBe('invalid-cid-input');
    });
});

describe('isCid and parse', () => {
    const digest = sha256(utf8('hello'));
    it('accept this scheme only', () => {
        expect(Cid.isCid(EMPTY_CID)).toBe(true);
        expect(Cid.isCid(HELLO_CID)).toBe(true);
        expect(Cid.isCid(spell([0x01, 0x70, 0x12, 0x20], digest))).toBe(true);
        const others = [
            undefined, null, 42, '', 'b', HELLO_CID.toUpperCase(), HELLO_CID.slice(1),
            'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB', // CIDv0
            spell([0x01, 0x71, 0x12, 0x20], digest), // unsupported dag-cbor
            spell([0x01, 0x55, 0x13, 0x40], Buffer.concat([digest, digest])), // sha2-512
            spell([0x00, 0x55, 0x12, 0x20], digest), // version 0
            spell([0x01, 0x55, 0x12, 0x20], digest.subarray(0, 31)), // short digest
            spell([0x01, 0x55, 0x12, 0x20], Buffer.concat([digest, Buffer.of(0)])), // trailing byte
            spell([0x81, 0x00, 0x55, 0x12, 0x20], digest), // version spelled in two bytes
            `${HELLO_CID.slice(0, -1)}r`, // the last character sets padding bits: a second spelling
            `${HELLO_CID.slice(0, 10)}1${HELLO_CID.slice(11)}`, // outside the alphabet
            `${HELLO_CID}a`
        ];
        others.forEach(value => {
            expect(Cid.isCid(value), String(value)).toBe(false);
            expect(thrownCode(() => Cid.parse(value)), String(value)).toBe('invalid-cid');
        });
    });

    it('parse gives back the digest a CID was made from', () => {
        const bytes = Cid.canonicalBytes({ title: 'Trg', site: null });
        expect(hex(Cid.parse(Cid.cidOf(bytes)).digest)).toBe(sha256(bytes).toString('hex'));
    });
});

describe('the node twin (backend/cid.js)', () => {
    const objects = [
        {}, [], 'text', 0, -0, 0.1, 1e21, 1e-7, 2 ** 53, true, null,
        { schema: 'design/v1', title: 'Ulica ž', site: { type: 'Polygon', coordinates: [[[15.96, 45.8], [15.961, 45.8], [15.961, 45.801], [15.96, 45.8]]] } },
        { b: [1, undefined, { d: undefined, c: [] }], a: ' ', ž: { Z: 1, a: 2 } }
    ];

    it('writes the same canonical bytes and the same CIDs', () => {
        objects.forEach(object => {
            const label = JSON.stringify(object);
            expect(hex(Node.canonicalBytes(object)), label).toBe(hex(Cid.canonicalBytes(object)));
            expect(Node.cidOfObject(object), label).toBe(Cid.cidOfObject(object));
        });
        expect(Node.cidOf(Buffer.alloc(0))).toBe(EMPTY_CID);
        expect(Node.cidOf(new Uint8Array(Buffer.from('hello')))).toBe(HELLO_CID);
    });

    it('refuses the same non-JSON values', () => {
        [{ a: NaN }, { when: new Date(0) }, { bytes: Buffer.from('x') }, undefined].forEach(value => {
            expect(thrownCode(() => Node.canonicalBytes(value))).toBe('invalid-cid-input');
        });
        expect(thrownCode(() => Node.cidOf('hello'))).toBe('invalid-cid-input');
    });

    it('recognises exactly the CIDs the browser recognises', () => {
        const digest = sha256(utf8('hello'));
        const candidates = [
            EMPTY_CID, HELLO_CID, Cid.cidOfObject({ a: 1 }), HELLO_CID.toUpperCase(), `${HELLO_CID.slice(0, -1)}r`,
            spell([0x01, 0x70, 0x12, 0x20], digest), spell([0x81, 0x00, 0x55, 0x12, 0x20], digest), '', null, 7
        ];
        candidates.forEach(value => expect(Node.isCid(value), String(value)).toBe(Cid.isCid(value)));
    });
});
