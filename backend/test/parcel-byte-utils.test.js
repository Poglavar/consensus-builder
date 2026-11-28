// Unit tests for shared parcel adapter byte helpers including bounded response reading.
import { describe, expect, it, vi } from 'vitest';
import { concatBytes, readBoundedBytes, utf8ByteLength } from '../parcels/byte-utils.js';

function streamResponse(chunks, { contentLength = null } = {}) {
    let index = 0;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const reader = {
        read: vi.fn(async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
        }),
        cancel,
        releaseLock
    };
    const bodyCancel = vi.fn().mockResolvedValue(undefined);
    return {
        response: {
            headers: { get: name => (name.toLowerCase() === 'content-length' ? contentLength : null) },
            body: { getReader: () => reader, cancel: bodyCancel }
        },
        cancel,
        bodyCancel,
        releaseLock
    };
}

describe('parcel byte-utils', () => {
    it('concatenates chunks and counts utf8 bytes', () => {
        const merged = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
        expect([...merged]).toEqual([1, 2, 3, 4]);
        expect(utf8ByteLength('čćžšđ')).toBe(10);
    });

    it('reads a multi-chunk response up to the exact byte limit', async () => {
        const { response, releaseLock } = streamResponse([
            new Uint8Array([10, 20]),
            new Uint8Array([30, 40, 50])
        ]);
        const result = await readBoundedBytes(response, 5);
        expect([...result.bytes]).toEqual([10, 20, 30, 40, 50]);
        expect(result.bytesRead).toBe(5);
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it('rejects early on content-length overflow with the caller error and cancels the body', async () => {
        const { response, bodyCancel } = streamResponse([new Uint8Array([1, 2])], { contentLength: '50' });
        const customError = Object.assign(new Error('too big'), { code: 'provider-limit' });
        await expect(readBoundedBytes(response, 10, { onLimit: () => customError })).rejects.toBe(customError);
        expect(bodyCancel).toHaveBeenCalledTimes(1);
    });

    it('aborts streaming reads that exceed maxBytes, cancels the reader, and releases the lock', async () => {
        const { response, cancel, releaseLock } = streamResponse([
            new Uint8Array([1, 2, 3, 4]),
            new Uint8Array([5, 6, 7])
        ]);
        const customError = new Error('stream overflow');
        await expect(readBoundedBytes(response, 6, { onLimit: () => customError })).rejects.toBe(customError);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(releaseLock).toHaveBeenCalledTimes(1);
    });

    it('calls onUnavailable when the response has no readable body stream', async () => {
        const missing = new Error('no stream');
        await expect(readBoundedBytes({ headers: { get: () => null }, body: null }, 100, { onUnavailable: () => missing }))
            .rejects.toBe(missing);
    });
});
