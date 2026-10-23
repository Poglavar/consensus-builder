// The server's CID scheme (backend/cid.js, plan-design-agreement.md M2 "Identity: one CID scheme"):
// CIDv1 UnixFS file with raw leaves and fixed 256 KiB chunks, sha2-256, base32 over canonical bytes.
// Known IPFS vectors, the canonical form, the
// browser twin (frontend/js/cid.js) giving the same answers, and isCid accepting one spelling only.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { canonicalBytes, cidOf, cidOfObject, isCid } from '../cid.js';
import { designContent, layoutContent, agreementContent } from './helpers/content-fixtures.js';

const require = createRequire(import.meta.url);
const browserCid = require('../../frontend/js/cid.js');

// An independent RFC 4648 base32 (lower case, unpadded), so the CID's bytes are checked from outside.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
function encode(bytes) {
    let bits = '';
    for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
    let text = '';
    for (let index = 0; index < bits.length; index += 5) text += ALPHABET[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
    return text;
}
function decode(text) {
    const bits = [...text].map(char => ALPHABET.indexOf(char).toString(2).padStart(5, '0')).join('');
    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
    return Buffer.from(bytes);
}
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const cidText = (prefix, digest) => `b${encode(Buffer.concat([Buffer.from(prefix), digest]))}`;

const EMPTY_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const HELLO_CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';

describe('cidOf', () => {
    it('gives the CIDs ipfs add --cid-version=1 --raw-leaves gives', () => {
        expect(cidOf(new Uint8Array())).toBe(EMPTY_CID);
        expect(cidOf(Buffer.from('hello'))).toBe(HELLO_CID);
        expect(cidOf(new TextEncoder().encode('hello'))).toBe(HELLO_CID);
    });

    it('is version 1, codec raw, sha2-256 of 32 bytes, then the digest of exactly the bytes given', () => {
        const bytes = Buffer.from('{"a":1}');
        const decoded = decode(cidOf(bytes).slice(1));
        expect([...decoded.subarray(0, 4)]).toEqual([0x01, 0x55, 0x12, 0x20]);
        expect(decoded.subarray(4).equals(sha256(bytes))).toBe(true);
        expect(cidOf(Buffer.from('{"a":1} '))).not.toBe(cidOf(bytes));
    });

    it('takes bytes only', () => {
        expect(() => cidOf('hello')).toThrow(expect.objectContaining({ code: 'invalid-cid-input' }));
        expect(() => cidOf([104, 105])).toThrow(expect.objectContaining({ code: 'invalid-cid-input' }));
    });
});

describe('canonicalBytes', () => {
    it('sorts keys at every depth by UTF-16 code unit and writes no whitespace', () => {
        const text = canonicalBytes({ b: 1, a: [3, { d: true, c: null }], B: 'x' }).toString('utf8');
        expect(text).toBe('{"B":"x","a":[3,{"c":null,"d":true}],"b":1}');
        // Integer-like keys, which JavaScript enumerates numerically, are sorted as text too.
        expect(canonicalBytes({ 9: 'nine', 10: 'ten' }).toString('utf8')).toBe('{"10":"ten","9":"nine"}');
    });

    it('identifies content, not the order it was written in', () => {
        const one = { title: 'Park', site: { type: 'Polygon', coordinates: [[[1, 2]]] } };
        const two = { site: { coordinates: [[[1, 2]]], type: 'Polygon' }, title: 'Park' };
        expect(canonicalBytes(one).equals(canonicalBytes(two))).toBe(true);
        expect(cidOfObject(one)).toBe(cidOfObject(two));
        expect(cidOfObject({ ...one, title: 'Park ' })).not.toBe(cidOfObject(one));
    });

    it('writes text as UTF-8 and leaves out undefined keys as JSON does', () => {
        expect([...canonicalBytes({ name: 'ž' })]).toEqual([...Buffer.from('{"name":"ž"}', 'utf8')]);
        expect(canonicalBytes({ a: undefined, b: [undefined, 1] }).toString('utf8')).toBe('{"b":[null,1]}');
        expect(canonicalBytes({ zero: -0, small: 1e-7 }).toString('utf8')).toBe('{"small":1e-7,"zero":0}');
    });

    it('refuses what is not JSON instead of hashing a substitute', () => {
        for (const value of [{ n: NaN }, { n: Infinity }, { at: new Date(0) }, { map: new Map() }, { bytes: Buffer.from('x') },
            { f: () => 1 }, { big: 1n }, undefined]) {
            expect(() => canonicalBytes(value)).toThrow(expect.objectContaining({ code: 'invalid-cid-input' }));
        }
    });
});

describe('the browser twin (frontend/js/cid.js)', () => {
    it('gives the same bytes and CID for every published shape', () => {
        const design = designContent();
        const objects = [{}, [], 'text', 0, { a: 'ž€😀', b: [null, true, 1.5e-7, -0] }, { 10: 1, 9: 2, Z: 3, a: 4 },
            design, layoutContent(), agreementContent([design])];
        for (const object of objects) {
            expect(Buffer.from(browserCid.canonicalBytes(object)).equals(canonicalBytes(object))).toBe(true);
            expect(browserCid.cidOfObject(object)).toBe(cidOfObject(object));
        }
        expect(browserCid.cidOf(Buffer.from('hello'))).toBe(HELLO_CID);
    });

    it('agrees on which text is a CID', () => {
        for (const text of [HELLO_CID, HELLO_CID.toUpperCase(), HELLO_CID.slice(0, -1), `${HELLO_CID}a`, '', 'b', null]) {
            expect(browserCid.isCid(text)).toBe(isCid(text));
        }
    });
});

describe('isCid', () => {
    const digest = sha256(Buffer.from('hello'));

    it('accepts a CIDv1 raw sha2-256 base32 CID', () => {
        expect(cidText([0x01, 0x55, 0x12, 0x20], digest)).toBe(HELLO_CID);
        expect(isCid(HELLO_CID)).toBe(true);
        expect(isCid(EMPTY_CID)).toBe(true);
        expect(HELLO_CID).toHaveLength(59);
    });

    it('refuses other codecs, versions, hashes and digest lengths', () => {
        expect(isCid(cidText([0x01, 0x70, 0x12, 0x20], digest))).toBe(true); // UnixFS file root
        expect(isCid(cidText([0x01, 0x71, 0x12, 0x20], digest))).toBe(false); // unsupported dag-cbor
        expect(isCid(cidText([0x01, 0x55, 0x13, 0x20], digest))).toBe(false); // another hash function
        expect(isCid(cidText([0x02, 0x55, 0x12, 0x20], digest))).toBe(false); // another version
        expect(isCid(cidText([0x01, 0x55, 0x12, 0x1f], digest.subarray(0, 31)))).toBe(false);
        expect(isCid(cidText([0x01, 0x55, 0x12, 0x20], Buffer.concat([digest, Buffer.from([0])])))).toBe(false);
        expect(isCid(cidText([0x01, 0xd5, 0x00, 0x12, 0x20], digest))).toBe(false); // the codec in a longer varint
        expect(isCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(false); // CIDv0
    });

    it('accepts one spelling only: lower case, multibase b, no stray padding bits', () => {
        expect(isCid(HELLO_CID.toUpperCase())).toBe(false);
        expect(isCid(HELLO_CID.slice(1))).toBe(false);
        expect(isCid(`B${HELLO_CID.slice(1)}`)).toBe(false);
        // The last character carries two padding bits: set one and the bytes decode the same.
        const last = ALPHABET.indexOf(HELLO_CID.at(-1));
        const respelled = HELLO_CID.slice(0, -1) + ALPHABET[last | 1];
        expect(respelled).not.toBe(HELLO_CID);
        expect(decode(respelled.slice(1)).equals(decode(HELLO_CID.slice(1)))).toBe(true);
        expect(isCid(respelled)).toBe(false);
        expect(isCid(`${HELLO_CID.slice(0, 30)}1${HELLO_CID.slice(31)}`)).toBe(false); // not in the alphabet
    });

    it('never throws, whatever it is given', () => {
        for (const value of [undefined, null, 42, {}, [], () => HELLO_CID, Symbol('cid'), `${HELLO_CID}\n`, ` ${HELLO_CID}`]) {
            expect(isCid(value)).toBe(false);
        }
    });
});
