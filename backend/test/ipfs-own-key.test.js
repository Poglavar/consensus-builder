// Pinning with the sponsor's own Pinata key (frontend/js/ipfs-own-key.js): each object goes to
// pinFileToIPFS as one CIDv1 file with the JWT as a bearer token, and counts only when Pinata answers
// exactly its CID; a refused key, an unreachable Pinata and another CID each stop the pinning. The key
// is remembered only when asked, and storage failures read as no key.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { canonicalBytes, cidOfObject } from '../cid.js';

const require = createRequire(import.meta.url);
const OwnKey = require('../../frontend/js/ipfs-own-key.js');

const plan = { schema: 'plan/v1', title: 'Courtyard' };
const design = { schema: 'design/v1', title: 'Block A' };
const objects = [plan, design].map((content, index) => ({ kind: index ? 'design' : 'plan', cid: cidOfObject(content), bytes: canonicalBytes(content) }));

function pinata(answer = (cid) => ({ status: 200, body: { IpfsHash: cid } })) {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
        const file = init.body.get('file');
        const cid = cidOfObject(JSON.parse(await file.text()));
        calls.push({ url, auth: init.headers.Authorization, name: file.name, options: JSON.parse(init.body.get('pinataOptions')), cid });
        const { status, body } = answer(cid, calls.length);
        return { ok: status < 300, status, json: async () => body };
    });
    return { calls, fetchImpl };
}

describe('pinWithPinata', () => {
    it('pins every object as a CIDv1 file with the key, and reports progress', async () => {
        const p = pinata();
        const progress = [];
        const result = await OwnKey.pinWithPinata({ objects, jwt: ' key ', fetchImpl: p.fetchImpl, onProgress: step => progress.push(step) });
        expect(result.pinned).toEqual(objects.map(({ kind, cid }) => ({ kind, cid })));
        expect(p.calls).toEqual(objects.map(object => ({ url: OwnKey.PINATA_PIN_FILE, auth: 'Bearer key', name: `${object.kind}-${object.cid}.json`, options: { cidVersion: 1 }, cid: object.cid })));
        expect(progress).toEqual([{ pinned: 1, total: 2 }, { pinned: 2, total: 2 }]);
    });

    it('stops on a refused key, an unreachable Pinata, a failed upload or another CID', async () => {
        const run = fetchImpl => OwnKey.pinWithPinata({ objects, jwt: 'key', fetchImpl });
        await expect(OwnKey.pinWithPinata({ objects, jwt: ' ', fetchImpl: vi.fn() })).rejects.toMatchObject({ code: 'own-key-missing' });
        await expect(run(pinata(() => ({ status: 401, body: {} })).fetchImpl)).rejects.toMatchObject({ code: 'own-key-refused', status: 401 });
        await expect(run(async () => { throw new Error('offline'); })).rejects.toMatchObject({ code: 'own-key-unreachable' });
        await expect(run(pinata(() => ({ status: 500, body: {} })).fetchImpl)).rejects.toMatchObject({ code: 'own-key-pin-failed' });
        const other = pinata((cid, n) => ({ status: 200, body: { IpfsHash: n === 2 ? 'bafkreiother' : cid } }));
        await expect(run(other.fetchImpl)).rejects.toMatchObject({ code: 'cid-mismatch', cid: objects[1].cid, pinnedCid: 'bafkreiother' });
    });
});

describe('the remembered key', () => {
    it('is kept only when asked, and forgotten with null', () => {
        const store = new Map();
        const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
        expect(OwnKey.rememberedKey(storage)).toBeNull();
        OwnKey.rememberKey('jwt-1', storage);
        expect(OwnKey.rememberedKey(storage)).toBe('jwt-1');
        OwnKey.rememberKey(null, storage);
        expect(OwnKey.rememberedKey(storage)).toBeNull();
    });

    it('reads as none where storage throws', () => {
        const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
        expect(OwnKey.rememberedKey(broken)).toBeNull();
        expect(() => OwnKey.rememberKey('jwt', broken)).not.toThrow();
    });
});
