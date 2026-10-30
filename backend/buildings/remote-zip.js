// Reads single files out of a zip on an HTTP server that honours Range requests, without downloading
// the archive: the central directory once, then each file's own bytes (Hamburg publishes its LoD2
// model as one 660 MB zip of 1 km tiles, hamburg-lod2.js). Plain zips only (no zip64); stored or
// deflated files.
import { inflateSync } from 'fflate';

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const decoder = new TextDecoder();

// The archive at url: entries() → [{ name, method, compressedSize, size, offset }], read(entry) → bytes.
export function openRemoteZip(url, { fetchImpl = fetch } = {}) {
    async function range(spec) {
        const response = await fetchImpl(url, { headers: { Range: `bytes=${spec}` } });
        if (response.status !== 206) throw new Error(`${url}: HTTP ${response.status} to a range request`);
        return new Uint8Array(await response.arrayBuffer());
    }

    let directory = null;
    function entries() {
        directory ??= (async () => {
            // The end-of-central-directory record is the last 22 bytes plus a comment of up to 64 KiB.
            const tail = await range('-65558');
            const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
            let at = tail.length - 22;
            while (at >= 0 && view.getUint32(at, true) !== EOCD) at--;
            if (at < 0) throw new Error(`${url}: no zip directory at the end of the file`);
            const size = view.getUint32(at + 12, true), offset = view.getUint32(at + 16, true);
            if (offset === 0xffffffff) throw new Error(`${url}: zip64 archives are not supported`);
            const bytes = await range(`${offset}-${offset + size - 1}`);
            const dir = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const list = [];
            for (let p = 0; p + 46 <= bytes.length && dir.getUint32(p, true) === CENTRAL;) {
                const nameLength = dir.getUint16(p + 28, true), extra = dir.getUint16(p + 30, true), comment = dir.getUint16(p + 32, true);
                list.push({ name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)), method: dir.getUint16(p + 10, true),
                    compressedSize: dir.getUint32(p + 20, true), size: dir.getUint32(p + 24, true), offset: dir.getUint32(p + 42, true) });
                p += 46 + nameLength + extra + comment;
            }
            return list;
        })();
        directory.catch(() => { directory = null; });
        return directory;
    }

    async function read(entry) {
        // The local header repeats the name and carries its own extra field; 1 KiB covers the usual ones.
        const guess = 30 + entry.name.length + 1024;
        let bytes = await range(`${entry.offset}-${entry.offset + guess + entry.compressedSize - 1}`);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, true) !== LOCAL) throw new Error(`${url}: no file header for ${entry.name}`);
        const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
        if (start + entry.compressedSize > bytes.length) {
            bytes = await range(`${entry.offset}-${entry.offset + start + entry.compressedSize - 1}`);
        }
        const data = bytes.subarray(start, start + entry.compressedSize);
        if (entry.method === 0) return data;
        if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.size) });
        throw new Error(`${url}: ${entry.name} uses zip method ${entry.method}`);
    }

    return { entries, read };
}
