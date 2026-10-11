// ZIP and dBASE metadata are inspected before decoding only configured native IDs and polygons.
import { inflateRawSync } from 'node:zlib';
import proj4 from 'proj4';
import { upstreamError, validateGeometry } from './source-contract.js';
import { encodeSnapshotNativeId } from './geojson-snapshot-source.js';

const fail = message => { throw upstreamError(message); };
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    let n = i; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0;
});
function crc32(bytes) {
    let n = 0xffffffff; for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0;
}
export const SHAPEFILE_CRS = Object.freeze({
    'EPSG:6677': '+proj=tmerc +lat_0=36 +lon_0=139.833333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
    'EPSG:2154': '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs'
});

// No filesystem extraction, ZIP64, encryption, ambiguous names or unbounded inflation.
export function readShapefileZipMembers(bytes, descriptor) {
    const v = viewOf(bytes); let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (v.getUint32(i, true) === 0x06054b50 && i + 22 + v.getUint16(i + 20, true) === bytes.length) { end = i; break; }
    }
    if (end < 0 || v.getUint16(end + 4, true) || v.getUint16(end + 6, true)
        || v.getUint16(end + 8, true) !== v.getUint16(end + 10, true)) fail('Invalid or split parcel ZIP.');
    const count = v.getUint16(end + 10, true), start = v.getUint32(end + 16, true), directorySize = v.getUint32(end + 12, true);
    if (!count || count > 512 || start + directorySize !== end) fail('Invalid parcel ZIP directory.');
    const names = new Map(), ranges = []; let cursor = start, total = 0;
    for (let i = 0; i < count; i++) {
        if (cursor + 46 > end || v.getUint32(cursor, true) !== 0x02014b50) fail('Invalid parcel ZIP directory.');
        const flags = v.getUint16(cursor + 8, true), method = v.getUint16(cursor + 10, true);
        const size = v.getUint32(cursor + 24, true), compressed = v.getUint32(cursor + 20, true), local = v.getUint32(cursor + 42, true);
        const nameSize = v.getUint16(cursor + 28, true), extra = v.getUint16(cursor + 30, true), comment = v.getUint16(cursor + 32, true);
        const next = cursor + 46 + nameSize + extra + comment;
        if (next > end || flags & ~0x080e || ![0, 8].includes(method) || v.getUint16(cursor + 34, true)
            || [size, compressed, local].includes(0xffffffff)) fail('Unsupported parcel ZIP member.');
        const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
        let name;
        try { name = new TextDecoder(flags & 0x800 ? 'utf-8' : descriptor.zipEncoding, { fatal: true }).decode(nameBytes); }
        catch { fail('Invalid parcel ZIP member encoding.'); }
        if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.includes(':')
            || name.split('/').some((part, index, parts) => ['..', '.'].includes(part) || (!part && index < parts.length - 1))
            || names.has(name.toLowerCase())) fail('Unsafe or ambiguous parcel ZIP member.');
        total += size; if (total > descriptor.maxDecompressedBytes) fail('Parcel ZIP exceeds decompressed byte limit.');
        if (local + 30 > start || v.getUint32(local, true) !== 0x04034b50
            || v.getUint16(local + 6, true) !== flags || v.getUint16(local + 8, true) !== method) fail('Parcel ZIP local metadata disagrees.');
        const localNameSize = v.getUint16(local + 26, true), localExtra = v.getUint16(local + 28, true);
        const dataStart = local + 30 + localNameSize + localExtra, dataEnd = dataStart + compressed;
        if (dataEnd > start || localNameSize !== nameSize
            || !Buffer.from(nameBytes).equals(Buffer.from(bytes.subarray(local + 30, local + 30 + localNameSize)))) fail('Parcel ZIP member selection disagrees.');
        const crc = v.getUint32(cursor + 16, true);
        if (!(flags & 8) && (v.getUint32(local + 14, true) !== crc || v.getUint32(local + 18, true) !== compressed
            || v.getUint32(local + 22, true) !== size)) fail('Parcel ZIP local sizes disagree.');
        let memberEnd = dataEnd;
        if (flags & 8) {
            if (memberEnd + 12 > start) fail('Incomplete parcel ZIP data descriptor.');
            if (v.getUint32(memberEnd, true) === 0x08074b50) memberEnd += 4;
            if (memberEnd + 12 > start || v.getUint32(memberEnd, true) !== crc
                || v.getUint32(memberEnd + 4, true) !== compressed || v.getUint32(memberEnd + 8, true) !== size) {
                fail('Parcel ZIP data descriptor disagrees.');
            }
            memberEnd += 12;
        }
        ranges.push([local, memberEnd]); names.set(name.toLowerCase(), { name, size, compressed, method, dataStart, crc }); cursor = next;
    }
    if (cursor !== end) fail('Invalid parcel ZIP directory size.');
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) fail('Overlapping parcel ZIP members.');
    const result = {};
    for (const [kind, name] of Object.entries(descriptor.shapefileMembers)) {
        const m = names.get(name.toLowerCase()); if (!m || m.name !== name) fail('Verified parcel ZIP member is missing.');
        if (['prj', 'cpg'].includes(kind) && m.size > 16384) fail('Parcel metadata member exceeds limit.');
        const data = bytes.subarray(m.dataStart, m.dataStart + m.compressed); let output;
        try {
            if (m.method === 0) output = data;
            else {
                const inflated = inflateRawSync(data, { maxOutputLength: m.size + 1, info: true });
                if (inflated.engine.bytesWritten !== data.length) fail('Parcel ZIP compressed member has trailing bytes.');
                output = inflated.buffer;
            }
        }
        catch { fail('Invalid compressed parcel ZIP member.'); }
        if (output.length !== m.size || crc32(output) !== m.crc) fail('Parcel ZIP member checksum or length disagrees.');
        result[kind] = output;
    }
    return result;
}

function verifiedProjection(prj, sourceCrs) {
    let text, parsed;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(prj); parsed = proj4(text).oProj; }
    catch { fail('Invalid parcel projection metadata.'); }
    const expected = proj4(SHAPEFILE_CRS[sourceCrs]).oProj;
    const parameters = ['a', 'b', 'lat0', 'long0', 'k0', 'x0', 'y0'];
    const projectionNames = sourceCrs === 'EPSG:6677' ? ['tmerc', 'Transverse_Mercator'] : ['lcc', 'Lambert_Conformal_Conic'];
    const parallels = sourceCrs === 'EPSG:2154' && [parsed.lat1, parsed.lat2].sort().some((n, i) =>
        !Number.isFinite(n) || Math.abs(n - [expected.lat1, expected.lat2].sort()[i]) > 1e-10);
    if (!projectionNames.includes(parsed.projName) || !['meter', 'm'].includes(parsed.units) || parallels
        || (parsed.to_meter !== undefined && parsed.to_meter !== 1)
        || (parsed.from_greenwich !== undefined && parsed.from_greenwich !== 0)
        || parsed.datum_params?.some(value => Number(value) !== 0)
        || parameters.some(key => expected[key] !== undefined && (!Number.isFinite(parsed[key])
            || Math.abs(parsed[key] - expected[key]) > Math.max(1e-10, Math.abs(expected[key]) * 1e-10)))
        || (sourceCrs === 'EPSG:6677' ? !/JGD[_ ]?2011/i.test(text) : !/RGF[_ ]?(?:1993|93)/i.test(text))) {
        fail('Parcel PRJ disagrees with the verified source CRS.');
    }
    return proj4(SHAPEFILE_CRS[sourceCrs], 'EPSG:4326');
}

// Schema first. Unselected columns are skipped as bytes and never decoded or retained.
export function readShapefileDbf(bytes, descriptor, cpg) {
    const v = viewOf(bytes);
    if (bytes.length < 33 || bytes[0] !== 3) fail('Unsupported parcel DBF version.');
    const count = v.getUint32(4, true), header = v.getUint16(8, true), width = v.getUint16(10, true);
    const end = header + count * width;
    if (header < 33 || (header - 33) % 32 || header > bytes.length || bytes[header - 1] !== 13 || !width
        || count > descriptor.maxSnapshotFeatures || count !== descriptor.expectedSnapshotFeatures
        || !(end === bytes.length || (end + 1 === bytes.length && bytes[end] === 26))) fail('Parcel DBF count or length is incomplete.');
    let offset = 1; const schema = new Map();
    for (let cursor = 32; cursor < header - 1; cursor += 32) {
        const nameBytes = bytes.subarray(cursor, cursor + 11);
        if (nameBytes.some(byte => byte > 127)) fail('Invalid parcel DBF field name encoding.');
        const field = Buffer.from(nameBytes).toString('ascii').split('\0')[0];
        const length = bytes[cursor + 16], type = String.fromCharCode(bytes[cursor + 11]), decimals = bytes[cursor + 17];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) || schema.has(field) || !length) fail('Invalid parcel DBF schema.');
        schema.set(field, { offset, length, type, decimals }); offset += length;
    }
    if (offset !== width) fail('Parcel DBF record width disagrees.');
    let encoding = descriptor.dbfEncoding;
    if (cpg) {
        const label = new TextDecoder('ascii').decode(cpg).trim();
        const aliases = { 'UTF-8': 'utf-8', '65001': 'utf-8', '1252': 'windows-1252', '932': 'shift_jis' };
        if ((aliases[label.toUpperCase()] || label.toLowerCase()) !== encoding) fail('Parcel DBF encoding metadata disagrees.');
    }
    let decoder; try { decoder = new TextDecoder(encoding, { fatal: true }); } catch { fail('Unsupported parcel DBF encoding.'); }
    const selected = descriptor.idFields.map(field => {
        const column = schema.get(field);
        if (!column || !['C', 'N', 'I'].includes(column.type) || column.decimals || column.length > 256
            || (column.type === 'I' && column.length !== 4)) fail('Parcel DBF identity schema is unsafe or missing.');
        return { ...column, field };
    });
    function properties(index) {
        const start = header + index * width;
        if (bytes[start] !== 32) fail('Parcel DBF has deleted or invalid rows; snapshot is incomplete.');
        return Object.fromEntries(selected.map(column => {
            const pos = start + column.offset; let value;
            if (column.type === 'I') value = v.getInt32(pos, true);
            else {
                try { value = decoder.decode(bytes.subarray(pos, pos + column.length)); } catch { fail('Invalid native DBF identity encoding.'); }
                value = column.type === 'C' ? value.replace(/ +$/, '') : value.trim();
                if (column.type === 'N') {
                    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('Unsafe numeric DBF identity.');
                    value = Number(value);
                }
            }
            if (descriptor.idType === 'integer' && (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) fail('Invalid integer DBF identity.');
            try { encodeSnapshotNativeId([value]); } catch { fail('Invalid native DBF identity.'); }
            if (typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value)) fail('Invalid native DBF identity.');
            return [column.field, value];
        }));
    }
    return { count, properties };
}

function shapeHeader(bytes) {
    const v = viewOf(bytes);
    if (bytes.length < 100 || v.getUint32(0) !== 9994 || v.getUint32(24) * 2 !== bytes.length
        || v.getUint32(28, true) !== 1000 || v.getUint32(32, true) !== 5) fail('Parcel SHP must contain complete Polygon records.');
    return v;
}
function inside(point, ring) {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
}
function polygon(v, offset, size, projection, descriptor) {
    if (size < 44 || v.getUint32(offset, true) !== 5) fail('Parcel SHP contains null or non-polygon records.');
    const parts = v.getUint32(offset + 36, true), points = v.getUint32(offset + 40, true);
    if (!parts || parts > 10000 || points > descriptor.maxRecordPoints || size !== 44 + parts * 4 + points * 16) fail('Parcel polygon count or length exceeds limits.');
    const starts = Array.from({ length: parts }, (_, i) => v.getUint32(offset + 44 + i * 4, true)); starts.push(points);
    if (starts[0] !== 0 || starts.some((n, i) => i && n - starts[i - 1] < 4)) fail('Invalid parcel polygon parts.');
    const shells = [], holes = []; let extent = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < parts; i++) {
        const native = [], ring = [];
        for (let n = starts[i]; n < starts[i + 1]; n++) {
            const pos = offset + 44 + parts * 4 + n * 16, p = [v.getFloat64(pos, true), v.getFloat64(pos + 8, true)];
            if (!p.every(Number.isFinite)) fail('Non-finite native parcel coordinate.');
            native.push(p); const converted = projection.forward(p);
            if (!converted.every(Number.isFinite) || Math.abs(converted[0]) > 180 || Math.abs(converted[1]) > 90) fail('Invalid converted parcel coordinate.');
            ring.push(converted); extent = [Math.min(extent[0], converted[0]), Math.min(extent[1], converted[1]), Math.max(extent[2], converted[0]), Math.max(extent[3], converted[1])];
        }
        if (native[0][0] !== native.at(-1)[0] || native[0][1] !== native.at(-1)[1]) fail('Unclosed parcel polygon ring.');
        let area = 0; const origin = native[0];
        for (let n = 1; n < native.length; n++) area += (native[n - 1][0] - origin[0]) * (native[n][1] - origin[1]) - (native[n][0] - origin[0]) * (native[n - 1][1] - origin[1]);
        if (!Number.isFinite(area) || area === 0) fail('Degenerate parcel polygon ring.');
        const item = { native, ring, area, polygon: [ring] }; (area < 0 ? shells : holes).push(item);
    }
    if (!shells.length) fail('Parcel SHP has no exterior ring.');
    for (const hole of holes) {
        const containers = shells.filter(shell => inside(hole.native[0], shell.native)).sort((a, b) => Math.abs(a.area) - Math.abs(b.area));
        if (!containers.length) fail('Parcel SHP hole has no exterior ring.');
        containers[0].polygon.push(hole.ring);
    }
    const geometry = shells.length === 1 ? { type: 'Polygon', coordinates: shells[0].polygon }
        : { type: 'MultiPolygon', coordinates: shells.map(shell => shell.polygon) };
    if (!validateGeometry(geometry)) fail('Invalid parcel polygon geometry.');
    return { geometry, bbox: extent, pointCount: points };
}

// Retain binary geometry plus a compact index, rather than hundreds of thousands of JS features.
export async function indexShapefileSnapshot(members, descriptor, signal) {
    const projection = verifiedProjection(members.prj, descriptor.sourceCrs);
    const dbf = readShapefileDbf(members.dbf, descriptor, members.cpg);
    const shp = shapeHeader(members.shp), shx = shapeHeader(members.shx);
    if ((members.shx.length - 100) / 8 !== dbf.count) fail('Parcel SHX and DBF counts disagree.');
    const byId = new Map(), extents = new Float64Array(dbf.count * 4); let offset = 100, totalPoints = 0;
    for (let i = 0; i < dbf.count; i++) {
        if (signal?.aborted) throw upstreamError('Parcel snapshot indexing timed out.', 504);
        const size = shx.getUint32(104 + i * 8) * 2;
        if (shx.getUint32(100 + i * 8) * 2 !== offset || offset + 8 + size > members.shp.length
            || shp.getUint32(offset) !== i + 1 || shp.getUint32(offset + 4) * 2 !== size) fail('Parcel SHX record offsets disagree with SHP.');
        const props = dbf.properties(i), nativeId = encodeSnapshotNativeId(descriptor.idFields.map(field => props[field]));
        if (byId.has(nativeId)) fail('Parcel snapshot repeated a native identity.');
        const parsed = polygon(shp, offset + 8, size, projection, descriptor); totalPoints += parsed.pointCount;
        if (totalPoints > descriptor.maxSnapshotPoints) fail('Parcel snapshot exceeds coordinate limit.');
        if (descriptor.bbox && parsed.bbox.some((n, j) => j < 2 ? n < descriptor.bbox[j] : n > descriptor.bbox[j])) fail('Parcel lies outside verified snapshot extent.');
        extents.set(parsed.bbox, i * 4); byId.set(nativeId, i); offset += 8 + size;
        if (i % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
    }
    if (offset !== members.shp.length) fail('Parcel SHP contains unindexed trailing records.');
    return { byId, extents, count: dbf.count, feature(index) {
        const offset = shx.getUint32(100 + index * 8) * 2, size = shx.getUint32(104 + index * 8) * 2;
        return { type: 'Feature', properties: dbf.properties(index), geometry: polygon(shp, offset + 8, size, projection, descriptor).geometry };
    } };
}
