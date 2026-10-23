// Content identifiers for published designs and agreements (plan-design-agreement.md, M2 "Identity:
// one CID scheme"): CIDv1 UnixFS file, fixed 256 KiB chunks, raw leaves, sha2-256, base32 over
// an object's canonical bytes (keys sorted at every depth, no whitespace, UTF-8).
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.Cid = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';
    const VERSION = 1;
    const CODEC_RAW = 0x55;
    const CODEC_DAG_PB = 0x70;
    const HASH_SHA2_256 = 0x12;
    const DIGEST_BYTES = 32;
    const MULTIBASE_BASE32 = 'b';
    // RFC 4648 base32, lower case, written without padding.
    const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

    function fail(code, message) {
        const error = new Error(message);
        error.code = code;
        throw error;
    }

    // Unsigned LEB128, the varint every multiformats prefix number is written in.
    function varint(value) {
        const bytes = [];
        let rest = value;
        while (rest >= 0x80) {
            bytes.push((rest % 0x80) | 0x80);
            rest = Math.floor(rest / 0x80);
        }
        bytes.push(rest);
        return bytes;
    }

    // One varint at `offset`. The numbers this scheme uses fit in two bytes; a longer one, or one
    // spelled in more bytes than it needs (a second spelling of the same CID), is refused.
    function readVarint(bytes, offset) {
        let value = 0;
        for (let index = 0; index < 2; index += 1) {
            if (offset + index >= bytes.length) fail('invalid-cid', 'The CID ends inside its prefix.');
            const byte = bytes[offset + index];
            value += (byte & 0x7f) * 0x80 ** index;
            if (!(byte & 0x80)) {
                if (index > 0 && byte === 0) fail('invalid-cid', 'The CID spells a prefix number in more bytes than it needs.');
                return { value, next: offset + index + 1 };
            }
        }
        return fail('invalid-cid', 'The CID has a prefix number this scheme never uses.');
    }

    const PREFIX = Uint8Array.from([...varint(VERSION), ...varint(CODEC_RAW), ...varint(HASH_SHA2_256), ...varint(DIGEST_BYTES)]);

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

    // The last character carries zero bits past the final byte; any other value would be a second
    // spelling of the same bytes, so it is refused like a character outside the alphabet.
    function fromBase32(text) {
        const bytes = [];
        let buffer = 0;
        let bits = 0;
        for (const char of text) {
            const value = ALPHABET.indexOf(char);
            if (value < 0) fail('invalid-cid', 'The CID has a character outside lower-case base32.');
            buffer = (buffer << 5) | value;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                bytes.push((buffer >>> bits) & 0xff);
            }
            buffer &= (1 << bits) - 1;
        }
        if (bits >= 5 || buffer !== 0) fail('invalid-cid', 'The CID does not end on a whole byte.');
        return Uint8Array.from(bytes);
    }

    const isBytes = value => ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';

    // Binary digests are also needed for UnixFS chunk and protobuf blocks.
    function sha256(bytes) {
        const api = root.__consentSha256
            || (typeof require === 'function' ? require('../vendor/noble-hashes-1.8.0/sha256.js') : null);
        if (!api || typeof api.sha256Bytes !== 'function') throw new Error('SHA-256 (vendor/noble-hashes) is not loaded.');
        return api.sha256Bytes(bytes);
    }

    // JSON with object keys sorted at every depth (by UTF-16 code unit, never by locale) and no
    // whitespace. Undefined keys are left out and an undefined array item is null, as JSON does.
    // Only JSON values pass: a number that is not finite, or an object that is not plain (a Date, a
    // Map), is refused rather than written as something it is not.
    function stableStringify(value) {
        if (value === null) return 'null';
        const type = typeof value;
        if (type === 'string' || type === 'boolean') return JSON.stringify(value);
        if (type === 'number') {
            if (!Number.isFinite(value)) fail('invalid-cid-input', 'Published numbers must be finite.');
            return JSON.stringify(value);
        }
        if (type !== 'object') return fail('invalid-cid-input', `Published content must be JSON values, not ${type}.`);
        // Array.from visits holes as undefined, so a sparse array is written as JSON writes it.
        if (Array.isArray(value)) return '[' + Array.from(value, item => item === undefined ? 'null' : stableStringify(item)).join(',') + ']';
        const tag = Object.prototype.toString.call(value);
        if (tag !== '[object Object]') fail('invalid-cid-input', `Published content must be JSON values, not ${tag.slice(8, -1)}.`);
        return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
            .map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }

    // The bytes an object is pinned as and identified by.
    function canonicalBytes(value) {
        return new TextEncoder().encode(stableStringify(value));
    }

    // The CID of exactly these bytes: what `ipfs add --cid-version=1 --raw-leaves` gives for a file
    // imported with fixed 256 KiB chunks and raw leaves.
    function cidOf(bytes) {
        if (!isBytes(bytes)) fail('invalid-cid-input', 'cidOf needs a Uint8Array.');
        try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch (_) { fail('invalid-cid-input', 'Only UTF-8 bytes take a CID here: a published object is UTF-8 JSON.'); }
        const root = bytes.length <= 256 * 1024 ? { codec: CODEC_RAW, digest: sha256(bytes) }
            : (globalFileCid().fileRoot(bytes, sha256));
        const prefix = Uint8Array.from([VERSION, root.codec, HASH_SHA2_256, DIGEST_BYTES]);
        const cid = new Uint8Array(prefix.length + DIGEST_BYTES);
        cid.set(prefix, 0);
        cid.set(root.digest, prefix.length);
        return MULTIBASE_BASE32 + base32(cid);
    }

    function globalFileCid() {
        const api = root.IpfsFileCid || (typeof require === 'function' ? require('../vendor/ipfs-file-cid/ipfs-file-cid.js') : null);
        if (!api) fail('invalid-cid-input', 'The IPFS file codec is not loaded.');
        return api;
    }

    const cidOfObject = value => cidOf(canonicalBytes(value));

    // A CID of this scheme taken apart. Throws (code 'invalid-cid') for anything else: another
    // multibase, version, codec or hash, a digest that is not 32 bytes, or a second spelling.
    function parse(text) {
        if (typeof text !== 'string' || text[0] !== MULTIBASE_BASE32) fail('invalid-cid', 'A CID here is lower-case base32 text starting with b.');
        const bytes = fromBase32(text.slice(1));
        let offset = 0;
        const next = () => {
            const read = readVarint(bytes, offset);
            offset = read.next;
            return read.value;
        };
        const version = next();
        const codec = next();
        const hash = next();
        const length = next();
        if (version !== VERSION || (codec !== CODEC_RAW && codec !== CODEC_DAG_PB) || hash !== HASH_SHA2_256 || length !== DIGEST_BYTES) {
            fail('invalid-cid', 'Only CIDv1 raw or UnixFS dag-pb sha2-256 CIDs are used here.');
        }
        if (bytes.length - offset !== DIGEST_BYTES) fail('invalid-cid', 'The CID digest is not 32 bytes.');
        return { version, codec, digest: bytes.slice(offset) };
    }

    // Whether text is a CID of this file scheme (59 characters); never throws for bad text.
    function isCid(text) {
        try {
            parse(text);
            return true;
        } catch (error) {
            if (error && error.code === 'invalid-cid') return false;
            throw error;
        }
    }

    return { cidOf, canonicalBytes, cidOfObject, isCid, parse };
});
