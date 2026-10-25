// ZIP and dBASE metadata are inspected before decoding only configured native IDs and polygons.
import { Inflate } from 'fflate';
import proj4 from 'proj4';
import { upstreamError, validateGeometry } from './source-contract.js';
import { sha256Hex } from './portable-hash.js';
import { encodeSnapshotNativeId } from './geojson-snapshot-source.js';
import { concatBytes } from './byte-utils.js';

const fail = message => { throw upstreamError(message); };
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
function inflateRawBounded(data, expected) {
    if (!Number.isSafeInteger(expected) || expected < 0) fail('Invalid parcel ZIP member size.');
    const chunks = []; let total = 0, completed = false;
    const inflate = new Inflate((chunk, final) => {
        total += chunk.length;
        if (total > expected) throw new Error('Parcel ZIP member exceeds declared size.');
        chunks.push(chunk); completed = final;
    });
    // Small pushes cap temporary output if a malformed member expands far beyond its declaration.
    for (let offset = 0; offset < data.length; offset += 1024) {
        inflate.push(data.subarray(offset, Math.min(offset + 1024, data.length)), false);
    }
    inflate.push(new Uint8Array(0), true);
    if (!completed || inflate.p.length !== (inflate.s.p ? 1 : 0) || total !== expected) fail('Parcel ZIP compressed member size or trailing bytes disagree.');
    const output = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
    let n = i; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0;
});
function crc32(bytes) {
    let n = 0xffffffff; for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0;
}
export const SHAPEFILE_CRS = Object.freeze({
    // Monte Mario / Italy zone 1; approximate EPSG:1660 Helmert, no fitted offset or grid.
    'EPSG:3003': '+proj=tmerc +lat_0=0 +lon_0=9 +k=0.9996 +x_0=1500000 +y_0=0 +ellps=intl +towgs84=-104.1,-49.1,-9.9,0.971,-2.917,0.714,-11.68 +units=m +no_defs',
    'EPSG:6677': '+proj=tmerc +lat_0=36 +lon_0=139.833333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
    // JGD2000 / Japan Plane Rectangular CS XII. SHP ordinates are easting,northing.
    'EPSG:2454': '+proj=tmerc +lat_0=44 +lon_0=142.25 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs',
    'EPSG:2154': '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs'
});

// No filesystem extraction, ZIP64, encryption, ambiguous names or unbounded inflation.
export function readBoundedZipMembers(bytes, descriptor, selectMembers) {
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
            || !equalBytes(nameBytes, bytes.subarray(local + 30, local + 30 + localNameSize))) fail('Parcel ZIP member selection disagrees.');
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
    for (const [kind, name] of Object.entries(selectMembers([...names.values()].map(member => member.name)))) {
        const m = names.get(name.toLowerCase()); if (!m || m.name !== name) fail('Verified parcel ZIP member is missing.');
        if (['prj', 'cpg'].includes(kind) && m.size > 16384) fail('Parcel metadata member exceeds limit.');
        const data = bytes.subarray(m.dataStart, m.dataStart + m.compressed); let output;
        try {
            if (m.method === 0) output = data;
            else {
                if (!Number.isSafeInteger(m.size) || m.size > descriptor.maxDecompressedBytes) fail('Parcel ZIP member exceeds decompressed byte limit.');
                output = inflateRawBounded(data, m.size);
            }
        }
        catch { fail('Invalid compressed parcel ZIP member.'); }
        if (output.length !== m.size || crc32(output) !== m.crc) fail('Parcel ZIP member checksum or length disagrees.');
        result[kind] = output;
    }
    return result;
}

export function readShapefileZipMembers(bytes, descriptor) {
    return readBoundedZipMembers(bytes, descriptor, () => descriptor.shapefileMembers);
}

function verifiedProjection(prj, sourceCrs) {
    let text, parsed;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(prj); parsed = proj4(text).oProj; }
    catch { fail('Invalid parcel projection metadata.'); }
    const expected = proj4(SHAPEFILE_CRS[sourceCrs]).oProj;
    const parameters = ['a', 'b', 'lat0', 'long0', 'k0', 'x0', 'y0'];
    const projectionNames = ['EPSG:6677', 'EPSG:2454', 'EPSG:3003'].includes(sourceCrs) ? ['tmerc', 'Transverse_Mercator'] : ['lcc', 'Lambert_Conformal_Conic'];
    const datumName = sourceCrs === 'EPSG:3003' ? /Monte[_ ]?Mario/i : sourceCrs === 'EPSG:2454' ? /JGD[_ ]?2000/i : sourceCrs === 'EPSG:6677' ? /JGD[_ ]?2011/i : /RGF[_ ]?(?:1993|93)/i;
    const parallels = sourceCrs === 'EPSG:2154' && [parsed.lat1, parsed.lat2].sort().some((n, i) =>
        !Number.isFinite(n) || Math.abs(n - [expected.lat1, expected.lat2].sort()[i]) > 1e-10);
    if (!projectionNames.includes(parsed.projName) || !['meter', 'm'].includes(parsed.units) || parallels
        || (parsed.to_meter !== undefined && parsed.to_meter !== 1)
        || (parsed.from_greenwich !== undefined && parsed.from_greenwich !== 0)
        || parsed.datum_params?.some(value => Number(value) !== 0)
        || parameters.some(key => expected[key] !== undefined && (!Number.isFinite(parsed[key])
            || Math.abs(parsed[key] - expected[key]) > Math.max(1e-10, Math.abs(expected[key]) * 1e-10)))
        || !datumName.test(text)) {
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
        || !(end === bytes.length || (end + 1 === bytes.length && bytes[end] === (descriptor.dbfEof === 'null' ? 0 : 26)))) fail('Parcel DBF count or length is incomplete.');
    let offset = 1; const schema = new Map();
    for (let cursor = 32; cursor < header - 1; cursor += 32) {
        const nameBytes = bytes.subarray(cursor, cursor + 11);
        if (nameBytes.some(byte => byte > 127)) fail('Invalid parcel DBF field name encoding.');
        const field = new TextDecoder('ascii').decode(nameBytes).split('\0')[0];
        const length = bytes[cursor + 16], type = String.fromCharCode(bytes[cursor + 11]), decimals = bytes[cursor + 17];
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) || schema.has(field) || !length) fail('Invalid parcel DBF schema.');
        schema.set(field, { offset, length, type, decimals }); offset += length;
    }
    if (offset !== width) fail('Parcel DBF record width disagrees.');
    let encoding = descriptor.dbfEncoding;
    if (cpg) {
        const label = new TextDecoder('ascii').decode(cpg).trim();
        const aliases = { 'UTF-8': 'utf-8', '65001': 'utf-8', '1252': 'windows-1252', 'ISO 88591': 'windows-1252', '932': 'shift_jis', 'SHIFT-JIS': 'shift_jis' };
        if ((aliases[label.toUpperCase()] || label.toLowerCase()) !== encoding) fail('Parcel DBF encoding metadata disagrees.');
    }
    let decoder; try { decoder = new TextDecoder(encoding, { fatal: true }); } catch { fail('Unsupported parcel DBF encoding.'); }
    const selected = descriptor.idFields.map(field => {
        const column = schema.get(field);
        if (!column || !['C', 'N', 'I'].includes(column.type) || (column.decimals && !descriptor.integerDecimalFields?.includes(field)) || column.length > 256
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
                // WHATWG Shift-JIS uses ASCII for these bytes; the publisher/GDAL JIS Roman
                // identity uses U+00A5 and U+203E. Explicit opt-in preserves the native label.
                if (descriptor.dbfCharacterSet === 'jis-x-0201-roman') value = value.replaceAll('\\', '¥').replaceAll('~', '‾');
                value = column.type === 'C' ? value.replace(/ +$/, '') : value.trim();
                if (column.type === 'N') {
                    if (descriptor.integerDecimalFields?.includes(column.field)) value = value.replace(/\.0+$/, '');
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
export function readShapefilePolygon(v, offset, size, projection, descriptor) {
    const shapeType = v.getUint32(offset, true), hasZ = shapeType === 15;
    if (size < 44 || ![5, 15].includes(shapeType)) fail('Parcel SHP contains null or non-polygon records.');
    const parts = v.getUint32(offset + 36, true), points = v.getUint32(offset + 40, true);
    const xyEnd = 44 + parts * 4 + points * 16, zEnd = xyEnd + (hasZ ? 16 + points * 8 : 0);
    if (!parts || parts > 10000 || points > descriptor.maxRecordPoints
        || (size !== zEnd && !(hasZ && size === zEnd + 16 + points * 8))) fail('Parcel polygon count or length exceeds limits.');
    const starts = Array.from({ length: parts }, (_, i) => v.getUint32(offset + 44 + i * 4, true)); starts.push(points);
    if (starts[0] !== 0 || starts.some((n, i) => i && n - starts[i - 1] < 4)) fail('Invalid parcel polygon parts.');
    const shells = [], holes = []; let extent = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < parts; i++) {
        const native = [], ring = [];
        for (let n = starts[i]; n < starts[i + 1]; n++) {
            const pos = offset + 44 + parts * 4 + n * 16, p = [v.getFloat64(pos, true), v.getFloat64(pos + 8, true)];
            if (hasZ) p.push(v.getFloat64(offset + xyEnd + 16 + n * 8, true));
            if (!p.every(Number.isFinite)) fail('Non-finite native parcel coordinate.');
            native.push(p); const converted = projection.forward(p);
            if (hasZ) converted[2] = p[2];
            if (!converted.every(Number.isFinite) || Math.abs(converted[0]) > 180 || Math.abs(converted[1]) > 90) fail('Invalid converted parcel coordinate.');
            ring.push(converted); extent = [Math.min(extent[0], converted[0]), Math.min(extent[1], converted[1]), Math.max(extent[2], converted[0]), Math.max(extent[3], converted[1])];
        }
        if (native[0][0] !== native.at(-1)[0] || native[0][1] !== native.at(-1)[1]) fail('Unclosed parcel polygon ring.');
        let area = 0; const origin = native[0];
        for (let n = 1; n < native.length; n++) area += (native[n - 1][0] - origin[0]) * (native[n][1] - origin[1]) - (native[n][0] - origin[0]) * (native[n - 1][1] - origin[1]);
        if (!Number.isFinite(area) || area === 0) fail('Degenerate parcel polygon ring.');
        const item = { native, ring, area, polygon: [ring], nativePolygon: [native] }; (area < 0 ? shells : holes).push(item);
    }
    if (!shells.length) fail('Parcel SHP has no exterior ring.');
    for (const hole of holes) {
        const containers = shells.filter(shell => inside(hole.native[0], shell.native)).sort((a, b) => Math.abs(a.area) - Math.abs(b.area));
        if (!containers.length) fail('Parcel SHP hole has no exterior ring.');
        containers[0].polygon.push(hole.ring);
        containers[0].nativePolygon.push(hole.native);
    }
    const geometry = shells.length === 1 ? { type: 'Polygon', coordinates: shells[0].polygon }
        : { type: 'MultiPolygon', coordinates: shells.map(shell => shell.polygon) };
    if (!validateGeometry(geometry)) fail('Invalid parcel polygon geometry.');
    const nativeGeometry = shells.length === 1 ? { type: 'Polygon', coordinates: shells[0].nativePolygon }
        : { type: 'MultiPolygon', coordinates: shells.map(shell => shell.nativePolygon) };
    return { geometry, nativeGeometry, bbox: extent, pointCount: points };
}

// OGR little-endian WKB (including the legacy 25D flag); preserve every ordinate and ring/part order.
export function nativePolygonWkb(geometry) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const multi = geometry.type === 'MultiPolygon', dimensions = polygons[0][0][0].length;
    const zFlag = dimensions === 3 ? 0x80000000 : 0;
    const size = (multi ? 9 : 0) + polygons.reduce((sum, polygon) => sum + 9 + polygon.reduce((n, ring) => n + 4 + ring.length * dimensions * 8, 0), 0);
    const bytes = new Uint8Array(size), view = viewOf(bytes); let pos = 0;
    function header(type, count) { view.setUint8(pos++, 1); view.setUint32(pos, type + zFlag, true); pos += 4; view.setUint32(pos, count, true); pos += 4; }
    if (multi) header(6, polygons.length);
    for (const polygon of polygons) {
        header(3, polygon.length);
        for (const ring of polygon) {
            view.setUint32(pos, ring.length, true); pos += 4;
            for (const point of ring) for (const n of point) { view.setFloat64(pos, n, true); pos += 8; }
        }
    }
    return bytes;
}

// Retain binary geometry plus a compact index, rather than hundreds of thousands of JS features.
export async function indexShapefileSnapshot(members, descriptor, signal) {
    if (descriptor.nativeRecordIdentity === 'cadastral-shape-sha256-v1') return indexCadastralShapeSnapshot(members, descriptor, signal);
    const projection = verifiedProjection(members.prj, descriptor.sourceCrs);
    const dbf = readShapefileDbf(members.dbf, descriptor, members.cpg);
    const shp = shapeHeader(members.shp), shx = shapeHeader(members.shx);
    if ((members.shx.length - 100) / 8 !== dbf.count) fail('Parcel SHX and DBF counts disagree.');
    const byId = new Map(), extents = new Float64Array(dbf.count * 4); let offset = 100, totalPoints = 0;
    const wkbIdentity = descriptor.nativeRecordIdentity === 'geometry-sha256-wkb-v1';
    const nativeIds = wkbIdentity ? new Array(dbf.count) : null;
    const encoder = new TextEncoder();
    const namespace = wkbIdentity ? encoder.encode(`${descriptor.id}\0`) : null;
    let duplicateRows = 0;
    for (let i = 0; i < dbf.count; i++) {
        if (signal?.aborted) throw upstreamError('Parcel snapshot indexing timed out.', 504);
        const size = shx.getUint32(104 + i * 8) * 2;
        if (shx.getUint32(100 + i * 8) * 2 !== offset || offset + 8 + size > members.shp.length
            || shp.getUint32(offset) !== i + 1 || shp.getUint32(offset + 4) * 2 !== size) fail('Parcel SHX record offsets disagree with SHP.');
        const props = dbf.properties(i);
        const parsed = readShapefilePolygon(shp, offset + 8, size, projection, descriptor); totalPoints += parsed.pointCount;
        const nativeId = wkbIdentity ? sha256Hex(concatBytes([namespace,
            encoder.encode(`${props[descriptor.idFields[0]]}\0`), nativePolygonWkb(parsed.nativeGeometry)]))
            : encodeSnapshotNativeId(descriptor.idFields.map(field => props[field]));
        if (nativeIds) nativeIds[i] = nativeId;
        if (byId.has(nativeId)) {
            if (!wkbIdentity) fail('Parcel snapshot repeated a native identity.');
            duplicateRows++;
        }
        if (totalPoints > descriptor.maxSnapshotPoints) fail('Parcel snapshot exceeds coordinate limit.');
        if (descriptor.bbox && parsed.bbox.some((n, j) => j < 2 ? n < descriptor.bbox[j] : n > descriptor.bbox[j])) fail('Parcel lies outside verified snapshot extent.');
        if (!byId.has(nativeId)) { extents.set(parsed.bbox, i * 4); byId.set(nativeId, i); }
        else extents.set([Infinity, Infinity, -Infinity, -Infinity], i * 4);
        offset += 8 + size;
        if (i % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (offset !== members.shp.length) fail('Parcel SHP contains unindexed trailing records.');
    return { byId, extents, count: dbf.count,
        ...(nativeIds ? { nativeId: index => nativeIds[index], statistics: {
            sourceRows: dbf.count, distinctShapes: byId.size, identicalReferenceAndShapeRows: duplicateRows } } : {}),
        feature(index) {
        const offset = shx.getUint32(100 + index * 8) * 2, size = shx.getUint32(104 + index * 8) * 2;
        return { type: 'Feature', properties: dbf.properties(index), geometry: readShapefilePolygon(shp, offset + 8, size, projection, descriptor).geometry };
    } };
}

// Agricultural publications can repeat a cadastral key for distinct land-use polygons.
// Identity binds literal cadastral references to the exact native SHP record content (not row order).
// Index all coordinates, but decode ring topology only for requested polygons: a malformed remote
// polygon fails its own read rather than preventing access to unrelated usable records.
async function indexCadastralShapeSnapshot(members, descriptor, signal) {
    if (descriptor.sourceCrs !== 'EPSG:3003' || descriptor.projectionMetadata !== 'publisher'
        || members.prj) fail('Unsupported publisher-declared cadastral archive profile.');
    const projection = proj4(SHAPEFILE_CRS[descriptor.sourceCrs], 'EPSG:4326');
    const dbf = readShapefileDbf(members.dbf, descriptor, members.cpg);
    const shp = shapeHeader(members.shp), shx = shapeHeader(members.shx);
    if ((members.shx.length - 100) / 8 !== dbf.count) fail('Parcel SHX and DBF counts disagree.');
    const byId = new Map(), nativeIds = new Array(dbf.count), extents = new Float64Array(dbf.count * 4);
    let offset = 100, totalPoints = 0, duplicateRows = 0, selectedRows = 0;
    for (let i = 0; i < dbf.count; i++) {
        if (signal?.aborted) throw upstreamError('Parcel snapshot indexing timed out.', 504);
        const size = shx.getUint32(104 + i * 8) * 2;
        if (shx.getUint32(100 + i * 8) * 2 !== offset || offset + 8 + size > members.shp.length
            || shp.getUint32(offset) !== i + 1 || shp.getUint32(offset + 4) * 2 !== size) fail('Parcel SHX record offsets disagree with SHP.');
        const start = offset + 8, props = dbf.properties(i);
        extents.set([Infinity, Infinity, -Infinity, -Infinity], i * 4);
        if (Object.entries(descriptor.attributeFilters || {}).every(([key, value]) => props[key] === value)) {
            selectedRows++;
            if (size < 44 || shp.getUint32(start, true) !== 5) fail('Parcel SHP contains null or non-polygon records.');
            const parts = shp.getUint32(start + 36, true), points = shp.getUint32(start + 40, true);
            if (!parts || parts > 10000 || points > descriptor.maxRecordPoints || size !== 44 + parts * 4 + points * 16) fail('Invalid parcel polygon length.');
            totalPoints += points;
            if (totalPoints > descriptor.maxSnapshotPoints) fail('Parcel snapshot exceeds coordinate limit.');
            const hash = sha256Hex(members.shp.subarray(start, start + size));
            const native = encodeSnapshotNativeId([...descriptor.idFields.map(field => props[field]), hash]);
            nativeIds[i] = native;
            if (byId.has(native)) duplicateRows++;
            else {
                byId.set(native, i);
                const extent = [Infinity, Infinity, -Infinity, -Infinity];
                for (let j = 0; j < points; j++) {
                    const p = start + 44 + parts * 4 + j * 16;
                    const nativePoint = [shp.getFloat64(p, true), shp.getFloat64(p + 8, true)];
                    if (!nativePoint.every(Number.isFinite)) fail('Non-finite native parcel coordinate.');
                    const converted = projection.forward(nativePoint);
                    if (!converted.every(Number.isFinite) || Math.abs(converted[0]) > 180 || Math.abs(converted[1]) > 90) fail('Invalid converted parcel coordinate.');
                    extent[0] = Math.min(extent[0], converted[0]); extent[1] = Math.min(extent[1], converted[1]);
                    extent[2] = Math.max(extent[2], converted[0]); extent[3] = Math.max(extent[3], converted[1]);
                }
                if (descriptor.bbox && extent.some((n, j) => j < 2 ? n < descriptor.bbox[j] : n > descriptor.bbox[j])) fail('Parcel lies outside verified snapshot extent.');
                extents.set(extent, i * 4);
            }
        }
        offset += 8 + size;
        if (i % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (offset !== members.shp.length) fail('Parcel SHP contains unindexed trailing records.');
    return { byId, extents, count: dbf.count, nativeId: index => nativeIds[index],
        statistics: { sourceRows: dbf.count, selectedRows, distinctShapes: byId.size, identicalReferenceAndShapeRows: duplicateRows },
        feature(index) {
            const offset = shx.getUint32(100 + index * 8) * 2, size = shx.getUint32(104 + index * 8) * 2;
            return { type: 'Feature', properties: dbf.properties(index),
                geometry: readShapefilePolygon(shp, offset + 8, size, projection, descriptor).geometry };
        }
    };
}
