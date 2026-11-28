// Small byte helpers shared by browser-runnable parcel adapters.
export function concatBytes(chunks, size) {
    const result = new Uint8Array(size ?? chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    if (offset !== result.byteLength) throw new RangeError('Byte chunks do not match the expected size.');
    return result;
}

const utf8Encoder = new TextEncoder();
export function utf8ByteLength(value) {
    return utf8Encoder.encode(value).byteLength;
}

// Reads a Fetch Response body stream up to maxBytes, invoking caller-supplied errors on overflow
// or missing stream so adapters keep provider-specific error codes and cross-page byte budgets.
export async function readBoundedBytes(response, maxBytes, {
    onLimit = () => new RangeError(`Response exceeds ${maxBytes} bytes.`),
    onUnavailable = () => new Error('Response body stream is unavailable.')
} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new RangeError('maxBytes must be a non-negative safe integer.');
    }
    const contentLength = response?.headers?.get?.('content-length');
    if (typeof contentLength === 'string' && /^\d+$/.test(contentLength.trim()) && Number(contentLength.trim()) > maxBytes) {
        await response.body?.cancel?.().catch(() => { /* ignore cancel error after content-length rejection */ });
        throw onLimit();
    }
    const reader = response?.body?.getReader?.();
    if (!reader) throw onUnavailable();
    const chunks = [];
    let bytesRead = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || !value.byteLength) continue;
            const chunk = value instanceof Uint8Array
                ? value
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            bytesRead += chunk.byteLength;
            if (bytesRead > maxBytes) {
                await reader.cancel?.().catch(() => { /* ignore cancel error when aborting an oversized stream */ });
                throw onLimit();
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock?.();
    }
    return { bytes: concatBytes(chunks, bytesRead), bytesRead };
}
