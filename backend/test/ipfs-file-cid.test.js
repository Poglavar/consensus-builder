import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { balanced } from 'ipfs-unixfs-importer/layout';
import { decode as decodeDagPb } from '@ipld/dag-pb';
import { UnixFS } from 'ipfs-unixfs';
import { CHUNK_BYTES, fileRoot, MAX_BYTES } from '../lib/ipfs-file-cid-entry.mjs';

const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const sha256 = bytes => createHash('sha256').update(bytes).digest();
const hex = bytes => Buffer.from(bytes).toString('hex');
let bundled;
let bundleSource;

beforeAll(() => {
    const bundlePath = require.resolve('../../frontend/vendor/ipfs-file-cid/ipfs-file-cid.js');
    bundled = require(bundlePath);
    bundleSource = readFileSync(bundlePath, 'utf8');
});

function bytesOfSize(size) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    return bytes;
}

async function importedRoot(bytes) {
    const blocks = new Map();
    const blockstore = {
        put: async (cid, block) => { blocks.set(cid.toString(), block); }
    };
    const entries = [];
    for await (const entry of importer([{ path: 'fixture.json', content: bytes }], blockstore, {
        cidVersion: 1,
        rawLeaves: true,
        reduceSingleLeafToSelf: true,
        wrapWithDirectory: false,
        chunker: fixedSize({ chunkSize: CHUNK_BYTES }),
        layout: balanced()
    })) entries.push(entry);
    return { root: entries.at(-1), blocks };
}

describe('fileRoot', () => {
    it.each([
        CHUNK_BYTES - 1,
        CHUNK_BYTES,
        CHUNK_BYTES + 1,
        CHUNK_BYTES * 2 + 17,
        2 * 1024 * 1024,
        MAX_BYTES
    ])('matches ipfs-unixfs-importer for %i bytes', async size => {
        const bytes = bytesOfSize(size);
        const expected = await importedRoot(bytes);
        const result = fileRoot(bytes, sha256);
        expect(result.codec).toBe(expected.root.cid.code);
        expect(hex(result.digest)).toBe(hex(expected.root.cid.multihash.digest));

        const fromBundle = bundled.fileRoot(bytes, sha256);
        expect(fromBundle.codec).toBe(result.codec);
        expect(hex(fromBundle.digest)).toBe(hex(result.digest));
    });

    it('keeps a single chunk as the existing raw CID', () => {
        for (const size of [0, 1, CHUNK_BYTES - 1, CHUNK_BYTES]) {
            const bytes = bytesOfSize(size);
            const result = fileRoot(bytes, sha256);
            expect(result.codec).toBe(0x55);
            expect(hex(result.digest)).toBe(hex(sha256(bytes)));
        }
    });

    it('exposes the same helper as a browser global', () => {
        const browser = { Uint8Array, TextEncoder, TextDecoder, BigInt };
        runInNewContext(bundleSource, browser);
        const bytes = bytesOfSize(CHUNK_BYTES + 1);
        const result = browser.IpfsFileCid.fileRoot(bytes, sha256);
        expect(result.codec).toBe(0x70);
        expect(hex(result.digest)).toBe(hex(fileRoot(bytes, sha256).digest));
    });

    it('encodes ordered raw chunk links and the exact UnixFS file size', async () => {
        const bytes = bytesOfSize(CHUNK_BYTES * 2 + 17);
        const { root, blocks } = await importedRoot(bytes);
        const node = decodeDagPb(blocks.get(root.cid.toString()));
        const unixfs = UnixFS.unmarshal(node.Data);
        const sizes = [CHUNK_BYTES, CHUNK_BYTES, 17];

        expect(unixfs.fileSize()).toBe(BigInt(bytes.byteLength));
        expect(unixfs.blockSizes).toEqual(sizes.map(BigInt));
        expect(node.Links.map((link, i) => Buffer.compare(
            Buffer.from(blocks.get(link.Hash.toString())),
            Buffer.from(bytes.subarray(i * CHUNK_BYTES, i * CHUNK_BYTES + sizes[i]))
        ) === 0))
            .toEqual([true, true, true]);
        expect(node.Links.map(link => link.Name)).toEqual(['', '', '']);
        expect(node.Links.map(link => link.Tsize)).toEqual(sizes);
        expect(fileRoot(bytes, sha256)).toEqual({ codec: 0x70, digest: root.cid.multihash.digest });
    });

    it('is deterministic for canonical Unicode JSON at the 10 MiB limit', async () => {
        const note = 'ž/雪/🌇';
        const prefix = `{"note":${JSON.stringify(note)},"payload":"`;
        const suffix = '"}';
        const payload = 'x'.repeat(MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
        const canonical = `{"note":${JSON.stringify(note)},"payload":"${payload}"}`;
        const bytes = new TextEncoder().encode(canonical);
        const sameBytes = new TextEncoder().encode(`{"note":${JSON.stringify(note)},"payload":"${payload}"}`);

        expect(bytes.byteLength).toBe(MAX_BYTES);
        expect(new TextDecoder().decode(bytes.subarray(0, Buffer.byteLength(prefix)))).toBe(prefix);
        expect(new TextDecoder().decode(bytes.subarray(-Buffer.byteLength(suffix)))).toBe(suffix);
        expect(hex(sha256(sameBytes))).toBe(hex(sha256(bytes)));
        expect(fileRoot(bytes, sha256)).toEqual(fileRoot(sameBytes, sha256));
        const expected = await importedRoot(bytes);
        expect(fileRoot(bytes, sha256).codec).toBe(expected.root.cid.code);
        expect(hex(fileRoot(bytes, sha256).digest)).toBe(hex(expected.root.cid.multihash.digest));
    });

    it('rejects invalid bytes, hashes, and files over the limit', () => {
        const errorCode = fn => {
            try { fn(); } catch (error) { return error.code; }
            return null;
        };
        expect(errorCode(() => fileRoot('text', sha256))).toBe('invalid-cid-input');
        expect(errorCode(() => fileRoot(new Uint8Array(1), null))).toBe('invalid-cid-input');
        expect(errorCode(() => fileRoot(new Uint8Array(1), () => new Uint8Array(31)))).toBe('invalid-cid-input');
        expect(errorCode(() => fileRoot(new Uint8Array(1), () => new Uint8Array(33)))).toBe('invalid-cid-input');
        expect(errorCode(() => fileRoot(new Uint8Array(MAX_BYTES + 1), sha256))).toBe('invalid-cid-input');
    });
});
