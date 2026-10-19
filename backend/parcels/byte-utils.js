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
