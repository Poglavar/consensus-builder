// Content identifiers of published designs and agreements (plan-design-agreement.md, M2 "Identity: one
// CID scheme"): CIDv1, codec raw (0x55), multihash sha2-256, multibase base32 lower case (`bafkrei…`),
// over an object's canonical bytes (JSON with keys sorted at every depth, no whitespace, UTF-8). The
// node twin of frontend/js/cid.js: the same object gets the same CID on both sides, which is what lets
// the courier and the index refuse any bytes that do not hash to the CID they are sent under.
import { createHash } from 'node:crypto';

const VERSION = 1;
const CODEC_RAW = 0x55;
const HASH_SHA2_256 = 0x12;
const DIGEST_BYTES = 32;
const MULTIBASE_BASE32 = 'b';
// RFC 4648 base32, lower case, written without padding.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function fail(code, message) {
    throw Object.assign(new Error(message), { code });
}

// Unsigned LEB128, the varint every multiformats prefix number is written in.
function varint(value) {
    const bytes = [];
    let rest = value;
    while (rest >= 0x80) {
        bytes.push((rest & 0x7f) | 0x80);
        rest >>>= 7;
    }
    bytes.push(rest);
    return bytes;
}

// version, codec, hash function, digest length: the same four bytes start every CID of this scheme.
const PREFIX = Buffer.from([...varint(VERSION), ...varint(CODEC_RAW), ...varint(HASH_SHA2_256), ...varint(DIGEST_BYTES)]);
const CID_BYTES = PREFIX.length + DIGEST_BYTES;

function base32(bytes) {
    let text = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            text += ALPHABET[(buffer >>> bits) & 31];
        }
        buffer &= (1 << bits) - 1;
    }
    if (bits) text += ALPHABET[(buffer << (5 - bits)) & 31];
    return text;
}

// Whole bytes only; leftover bits are dropped here and caught by isCid's re-encoding.
function fromBase32(text) {
    const bytes = [];
    let buffer = 0;
    let bits = 0;
    for (const char of text) {
        const value = ALPHABET.indexOf(char);
        if (value < 0) return null;
        buffer = (buffer << 5) | value;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >>> bits) & 0xff);
        }
        buffer &= (1 << bits) - 1;
    }
    return Buffer.from(bytes);
}

// JSON with object keys sorted at every depth (by UTF-16 code unit, as Array.prototype.sort does) and
// no whitespace. Undefined keys are left out and an undefined array item is null, as JSON does. Only
// JSON values pass: a number that is not finite, or an object that is not plain (a Date, a Buffer), is
// refused rather than written as something it is not. Byte for byte frontend/js/cid.js stableStringify.
function stableStringify(value) {
    if (value === null) return 'null';
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return JSON.stringify(value);
    if (type === 'number') {
        if (!Number.isFinite(value)) fail('invalid-cid-input', 'Published numbers must be finite.');
        return JSON.stringify(value);
    }
    if (type !== 'object') fail('invalid-cid-input', `Published content must be JSON values, not ${type}.`);
    // Array.from visits holes as undefined, so a sparse array is written as JSON writes it.
    if (Array.isArray(value)) return `[${Array.from(value, item => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
    const tag = Object.prototype.toString.call(value);
    if (tag !== '[object Object]') fail('invalid-cid-input', `Published content must be JSON values, not ${tag.slice(8, -1)}.`);
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** The bytes an object is pinned as and identified by. Throws (code 'invalid-cid-input') for non-JSON. */
export function canonicalBytes(object) {
    return Buffer.from(stableStringify(object), 'utf8');
}

/**
 * The CID of exactly these bytes: what `ipfs add --cid-version=1 --raw-leaves` gives for a file that
 * fits in one block. Any bytes hash here; the browser twin takes UTF-8 only, which is all a published
 * object ever is.
 */
export function cidOf(bytes) {
    if (!(bytes instanceof Uint8Array)) fail('invalid-cid-input', 'cidOf needs bytes (a Buffer or Uint8Array).');
    const digest = createHash('sha256').update(bytes).digest();
    return MULTIBASE_BASE32 + base32(Buffer.concat([PREFIX, digest]));
}

export const cidOfObject = object => cidOf(canonicalBytes(object));

/**
 * Whether text is a CID of this scheme (`bafkrei…`, 59 characters): base32 lower case, CIDv1, raw,
 * sha2-256, a 32-byte digest and its one spelling (minimal varints, zero padding bits). Never throws.
 */
export function isCid(text) {
    if (typeof text !== 'string' || text[0] !== MULTIBASE_BASE32) return false;
    const bytes = fromBase32(text.slice(1));
    return !!bytes && bytes.length === CID_BYTES && bytes.subarray(0, PREFIX.length).equals(PREFIX)
        && MULTIBASE_BASE32 + base32(bytes) === text;
}
