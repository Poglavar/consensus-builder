// Select GML by verified ZIP offsets, never by signatures inside compressed publisher data.
import { Inflate } from 'fflate';
import { upstreamError } from './source-contract.js';
import { CATASTRO_ATOM_PROFILE } from './catastro-atom-profile.js';

const fail = message => { throw upstreamError(message); };
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    let n = i;
    for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});

function selectMember(bytes, limit, profile) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === bytes.length) {
            end = i; break;
        }
    }
    if (end < 0 || v.getUint16(end + 4, true) || v.getUint16(end + 6, true)
        || v.getUint16(end + 8, true) !== v.getUint16(end + 10, true)) fail('Invalid or split parcel ZIP archive.');
    const entries = v.getUint16(end + 10, true), directory = v.getUint32(end + 16, true);
    const directorySize = v.getUint32(end + 12, true);
    if (entries > 20 || directory === 0xffffffff || directorySize === 0xffffffff) fail('Unsupported parcel ZIP archive.');
    if (directory + directorySize !== end) fail('Invalid parcel ZIP directory size.');
    const decoder = new TextDecoder('utf-8', { fatal: true }), names = new Set(), ranges = [];
    let offset = directory, match = null, declaredTotal = 0;
    for (let i = 0; i < entries; i++) {
        if (offset + 46 > end || v.getUint32(offset, true) !== 0x02014b50) fail('Invalid parcel ZIP directory.');
        const flags = v.getUint16(offset + 8, true), method = v.getUint16(offset + 10, true);
        const crc = v.getUint32(offset + 16, true), compressed = v.getUint32(offset + 20, true);
        const size = v.getUint32(offset + 24, true), local = v.getUint32(offset + 42, true);
        const nameLength = v.getUint16(offset + 28, true), extra = v.getUint16(offset + 30, true), comment = v.getUint16(offset + 32, true);
        const next = offset + 46 + nameLength + extra + comment;
        if (next > end) fail('Invalid parcel ZIP directory.');
        if (flags & ~0x080e || ![0, 8].includes(method) || v.getUint16(offset + 34, true)
            || [size, compressed, local].includes(0xffffffff)) fail('Unsupported parcel ZIP member.');
        // Stored members have no codec: their declared byte counts must agree before yielding XML.
        if (method === 0 && compressed !== size) fail('Parcel ZIP stored member sizes disagree.');
        const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
        let name;
        try { name = decoder.decode(nameBytes); } catch { fail('Invalid parcel ZIP member encoding.'); }
        // The verified Spanish metadata basename contains two literal dots. Only
        // exact members of that fixed profile get this exception; paths never do.
        if (!name || (name.includes('..') && !profile?.members.includes(name)) || name.startsWith('/') || /[\\:\u0000-\u001f]/.test(name)
            || name.split('/').some((part, index, parts) => part === '.' || (!part && index < parts.length - 1))
            || names.has(name.toLowerCase())) fail('Parcel ZIP has unsafe or ambiguous members.');
        names.add(name.toLowerCase());
        if (profile && !profile.members.includes(name)) fail('Spanish ATOM ZIP has an unexpected member.');
        declaredTotal += size;
        if (declaredTotal > limit) fail('Parcel ZIP exceeds decompressed limits.');
        if (local + 30 > directory || v.getUint32(local, true) !== 0x04034b50
            || v.getUint16(local + 6, true) !== flags || v.getUint16(local + 8, true) !== method) fail('Parcel ZIP local metadata disagrees.');
        const localNameLength = v.getUint16(local + 26, true), localExtra = v.getUint16(local + 28, true);
        const start = local + 30 + localNameLength + localExtra, dataEnd = start + compressed;
        if (dataEnd > directory || localNameLength !== nameLength
            || !nameBytes.every((byte, j) => bytes[local + 30 + j] === byte)) fail('Parcel ZIP member selection disagrees.');
        const localValues = [v.getUint32(local + 14, true), v.getUint32(local + 18, true), v.getUint32(local + 22, true)];
        if (localValues.some((value, j) => value !== [crc, compressed, size][j] && (!(flags & 8) || value !== 0))) {
            fail('Parcel ZIP local sizes or checksum disagree.');
        }
        let memberEnd = dataEnd;
        if (flags & 8) {
            if (memberEnd + 12 > directory) fail('Incomplete parcel ZIP data descriptor.');
            if (v.getUint32(memberEnd, true) === 0x08074b50) memberEnd += 4;
            if (memberEnd + 12 > directory || v.getUint32(memberEnd, true) !== crc
                || v.getUint32(memberEnd + 4, true) !== compressed || v.getUint32(memberEnd + 8, true) !== size) {
                fail('Parcel ZIP data descriptor disagrees.');
            }
            memberEnd += 12;
        }
        ranges.push([local, memberEnd]);
        if (profile ? name === profile.parcelMember : name.toLowerCase().endsWith('.gml')) {
            if (match) fail('Parcel ZIP has ambiguous GML members.');
            match = { start, compressed, size, crc, method };
        }
        offset = next;
    }
    if (offset !== end) fail('Invalid parcel ZIP directory size.');
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) fail('Overlapping parcel ZIP members.');
    if (!match) fail('Parcel ZIP has no GML member.');
    if (profile && names.size !== profile.members.length) fail('Spanish ATOM ZIP has an incomplete member set.');
    return match;
}

// Inflate only the selected payload with backpressure. Neither ancillary files nor full XML are buffered.
export async function* readGmlZipMember(bytes, limit, signal, profile) {
    if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid parcel ZIP reader options.');
    if (profile !== undefined && profile !== CATASTRO_ATOM_PROFILE) throw new Error('Invalid parcel ZIP profile.');
    if (signal?.aborted) fail('Parcel archive load aborted.');
    const member = selectMember(bytes, limit, profile);
    function* compressedChunks() {
        for (let i = member.start; i < member.start + member.compressed; i += 65536) {
            yield bytes.subarray(i, Math.min(i + 65536, member.start + member.compressed));
        }
    }
    let total = 0, crc = 0xffffffff;
    if (member.method === 0) {
        for (const data of compressedChunks()) {
            if (signal?.aborted) fail('Parcel archive load aborted.');
            total += data.byteLength;
            if (total > limit || total > member.size) fail('Parcel ZIP decompressed size exceeds limit.');
            for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
            yield data;
        }
    } else {
        let queued = [], completed = false;
        const inflate = new Inflate((data, final) => {
            if (completed) fail('Parcel ZIP compressed member has trailing bytes.');
            total += data.byteLength;
            if (total > limit || total > member.size) fail('Parcel ZIP decompressed size exceeds limit.');
            for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
            queued.push(data);
            completed = final;
        });
        try {
            for (const chunk of compressedChunks()) {
                if (signal?.aborted) fail('Parcel archive load aborted.');
                // Small input steps bound queued output while preserving streaming to the caller.
                for (let i = 0; i < chunk.length; i += 1024) {
                    inflate.push(chunk.subarray(i, Math.min(i + 1024, chunk.length)), false);
                    for (const data of queued) yield data;
                    queued = [];
                }
            }
            inflate.push(new Uint8Array(0), true);
            for (const data of queued) yield data;
            // fflate retains unconsumed input in p; completed streams must consume the full member.
            if (!completed || inflate.p.length !== (inflate.s.p ? 1 : 0)) fail('Parcel ZIP compressed member has trailing bytes or is incomplete.');
        } catch (error) {
            if (error.status) throw error;
            fail('Invalid or incomplete parcel ZIP member.');
        }
    }
    if (total !== member.size || ((crc ^ 0xffffffff) >>> 0) !== member.crc) fail('Parcel ZIP decompressed size or checksum is inconsistent.');
}
