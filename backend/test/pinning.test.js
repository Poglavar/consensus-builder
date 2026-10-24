// Pinning one published object through Pinata (storage/pinning.js, plan-design-agreement.md M2):
// the exact bytes go up as one file with cidVersion 1, and Pinata's CID must be the one the bytes
// were computed to have. fetch is stubbed; nothing leaves the machine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PINNED_OBJECT_BYTES, PINATA_FILE_ENDPOINT, pinBytes, pinFileToPinata } from '../storage/pinning.js';
import { canonicalBytes, cidOf } from '../cid.js';
import { designContent } from './helpers/content-fixtures.js';

const bytes = canonicalBytes(designContent());
const cid = cidOf(bytes);

function pinata(answer = { IpfsHash: cid, Timestamp: '2026-10-21T10:00:00Z' }, { status = 200 } = {}) {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
}

beforeEach(() => {
    vi.stubEnv('PINATA_API_KEY', 'test-key');
    vi.stubEnv('PINATA_API_SECRET', 'test-secret');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('pinBytes', () => {
    it('sends the exact bytes as one JSON file with cidVersion 1 and answers Pinata\'s own pin time', async () => {
        const fetchImpl = pinata();
        await expect(pinBytes({ bytes, name: `design-${cid}`, cid })).resolves.toEqual({ cid, pinnedAt: '2026-10-21T10:00:00.000Z' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(PINATA_FILE_ENDPOINT);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ pinata_api_key: 'test-key', pinata_secret_api_key: 'test-secret' });
        const file = init.body.get('file');
        expect(file.name).toBe(`design-${cid}.json`);
        expect(file.type).toBe('application/json');
        expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
        expect(JSON.parse(init.body.get('pinataOptions'))).toEqual({ cidVersion: 1 });
        expect(JSON.parse(init.body.get('pinataMetadata'))).toEqual({ name: `design-${cid}` });
    });

    it('refuses Pinata\'s answer when it pinned the bytes under another CID', async () => {
        const other = cidOf(Buffer.from('other bytes'));
        pinata({ IpfsHash: other, Timestamp: '2026-10-21T10:00:00Z' });
        await expect(pinBytes({ bytes, name: 'design-x', cid })).rejects.toMatchObject({ code: 'cid-mismatch', status: 409, cid, pinnedCid: other });
        // A CIDv0 answer (Pinata ignoring cidVersion) is a mismatch too, never accepted as the same pin.
        pinata({ IpfsHash: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
        await expect(pinBytes({ bytes, name: 'design-x', cid })).rejects.toMatchObject({ code: 'cid-mismatch', status: 409 });
    });

    it('refuses bytes that are not the CID they are sent under, before any request', async () => {
        const fetchImpl = pinata();
        const other = canonicalBytes(designContent({ title: 'Another park' }));
        await expect(pinBytes({ bytes: other, name: 'design-x', cid })).rejects.toMatchObject({
            code: 'cid-mismatch', status: 400, cid, computedCid: cidOf(other)
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('is unconfigured (503) without both Pinata credentials, before any request', async () => {
        const fetchImpl = pinata();
        vi.stubEnv('PINATA_API_SECRET', '');
        await expect(pinBytes({ bytes, name: 'design-x', cid })).rejects.toMatchObject({ code: 'pinning-unconfigured', status: 503 });
        vi.stubEnv('PINATA_API_SECRET', 'test-secret');
        vi.stubEnv('PINATA_API_KEY', '');
        await expect(pinBytes({ bytes, name: 'design-x', cid })).rejects.toMatchObject({ code: 'pinning-unconfigured', status: 503 });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('pins IPFS files up to 10 MiB across multiple chunks', async () => {
        expect(MAX_PINNED_OBJECT_BYTES).toBe(10 * 1024 * 1024);
        const atCap = Buffer.alloc(MAX_PINNED_OBJECT_BYTES, 0x20);
        const fetchImpl = pinata({ IpfsHash: cidOf(atCap) });
        await expect(pinBytes({ bytes: atCap, name: 'cap', cid: cidOf(atCap) })).resolves.toMatchObject({ cid: cidOf(atCap) });
        const over = Buffer.alloc(MAX_PINNED_OBJECT_BYTES + 1, 0x20);
        await expect(pinBytes({ bytes: over, name: 'over', cid })).rejects.toMatchObject({ code: 'too-large', status: 413 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        await expect(pinBytes({ bytes: new Uint8Array(), name: 'empty', cid: cidOf(new Uint8Array()) }))
            .rejects.toMatchObject({ code: 'invalid-pin', status: 400 });
    });

    it('uses the time of Pinata\'s answer only when Pinata gives none', async () => {
        pinata({ IpfsHash: cid });
        const before = Date.now();
        const { pinnedAt } = await pinBytes({ bytes, name: 'design-x', cid });
        expect(Date.parse(pinnedAt)).toBeGreaterThanOrEqual(before - 1);
        expect(new Date(pinnedAt).toISOString()).toBe(pinnedAt);
    });
});

describe('pinFileToPinata', () => {
    it('distinguishes an exhausted account from a retryable upstream failure', async () => {
        pinata({ error: { reason: 'FORBIDDEN', details: 'Account blocked due to plan usage limit' } }, { status: 403 });
        await expect(pinFileToPinata({ bytes, fileName: 'x.json' })).rejects.toMatchObject({
            code: 'pinning-quota-exhausted', status: 409, upstreamStatus: 403
        });
        pinata({ error: { reason: 'FORBIDDEN', details: 'Invalid authorization' } }, { status: 403 });
        await expect(pinFileToPinata({ bytes, fileName: 'x.json' })).rejects.toMatchObject({ code: 'pin-failed', status: 502 });
    });
    it('reports an upstream failure as pin-failed (502) with Pinata\'s status', async () => {
        pinata({ error: 'quota' }, { status: 429 });
        await expect(pinFileToPinata({ bytes, fileName: 'x.json' })).rejects.toMatchObject({ code: 'pin-failed', status: 502, upstreamStatus: 429 });
        pinata({ ok: true });
        await expect(pinFileToPinata({ bytes, fileName: 'x.json' })).rejects.toMatchObject({ code: 'pin-failed', status: 502 });
    });

    it('leaves out the metadata and options it is not given', async () => {
        const fetchImpl = pinata();
        await expect(pinFileToPinata({ bytes, fileName: 'image.png', contentType: 'image/png' })).resolves.toEqual({ cid, pinnedAt: '2026-10-21T10:00:00.000Z' });
        const form = fetchImpl.mock.calls[0][1].body;
        expect(form.get('pinataMetadata')).toBeNull();
        expect(form.get('pinataOptions')).toBeNull();
        expect(form.get('file').type).toBe('image/png');
    });
});
