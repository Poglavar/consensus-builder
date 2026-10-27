// Narrow, checked FlatGeobuf v3 reader: 2D Polygon/MultiPolygon, packed R-tree.
// Wire definitions: https://github.com/flatgeobuf/flatgeobuf/tree/master/src/fbs
// No attribute object is materialized except the caller's explicit safe allowlist.
import { upstreamError } from './source-contract.js';
const fail = () => upstreamError('Invalid or unsupported FlatGeobuf parcel data.');
const decoder = new TextDecoder('utf-8', { fatal: true });
class Tables {
    constructor(bytes) { this.bytes = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
    check(p, n) { if (!Number.isSafeInteger(p) || !Number.isSafeInteger(n) || p < 0 || n < 0 || p + n > this.bytes.length) throw fail(); return p; }
    u8(p) { return this.v.getUint8(this.check(p, 1)); }
    u16(p) { return this.v.getUint16(this.check(p, 2), true); }
    u32(p) { return this.v.getUint32(this.check(p, 4), true); }
    i32(p) { return this.v.getInt32(this.check(p, 4), true); }
    u64(p) { const n = Number(this.v.getBigUint64(this.check(p, 8), true)); if (!Number.isSafeInteger(n)) throw fail(); return n; }
    f64(p) { const n = this.v.getFloat64(this.check(p, 8), true); if (!Number.isFinite(n)) throw fail(); return n; }
    ptr(p) { const offset = this.u32(p); if (offset < 4) throw fail(); return this.check(p + offset, 4); }
    field(t, i) {
        const vt = t - this.i32(t), len = this.u16(vt), slot = vt + 4 + i * 2;
        if (slot + 2 > vt + len) return 0;
        const offset = this.u16(slot); return offset ? this.check(t + offset, 1) : 0;
    }
    vector(t, i, width) {
        const f = this.field(t, i); if (!f) return { start: 0, length: 0 };
        const p = this.ptr(f), length = this.u32(p), start = p + 4;
        this.check(start, length * width); return { start, length };
    }
    string(t, i) {
        const f = this.field(t, i); if (!f) return '';
        const p = this.ptr(f), n = this.u32(p); this.check(p + 4, n);
        return decoder.decode(this.bytes.subarray(p + 4, p + 4 + n));
    }
}
export function flatgeobufLevels(count, nodeSize) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100000000 || !Number.isSafeInteger(nodeSize) || nodeSize < 2 || nodeSize > 65535) throw fail();
    const sizes = [count]; while (sizes.at(-1) > 1) sizes.push(Math.ceil(sizes.at(-1) / nodeSize));
    // The format includes a root-parent node even for a one-feature file.
    if (sizes.length === 1) sizes.push(1);
    let offset = 0;
    return sizes.reverse().map(size => { const level = { start: offset, end: offset + size }; offset += size; return level; });
}
export function readFlatgeobufHeader(bytes) {
    const b = new Tables(bytes), t = b.ptr(0), get = (i, method, fallback = 0) => { const p = b.field(t, i); return p ? b[method](p) : fallback; };
    if ([3, 4, 5, 6].some(i => get(i, 'u8'))) throw fail();
    const geometryType = get(2, 'u8'); if (![0, 3, 6].includes(geometryType)) throw fail();
    const columns = b.vector(t, 7, 4);
    if (columns.length > 256) throw fail();
    const schema = Array.from({ length: columns.length }, (_, i) => {
        const c = b.ptr(columns.start + i * 4), type = b.field(c, 1);
        return { name: b.string(c, 0), type: type ? b.u8(type) : 0 };
    });
    const crsField = b.field(t, 10), crs = crsField ? b.ptr(crsField) : 0;
    const code = crs && b.field(crs, 1);
    const envelope = b.vector(t, 1, 8);
    return { name: b.string(t, 0), geometryType, columns: schema,
        featuresCount: get(8, 'u64'), nodeSize: get(9, 'u16', 16), crs: code ? b.i32(code) : 0,
        envelope: Array.from({ length: envelope.length }, (_, i) => b.f64(envelope.start + i * 8)) };
}
export function readFlatgeobufFeature(bytes, header, allowlist) {
    const b = new Tables(bytes), t = b.ptr(0), gf = b.field(t, 0);
    if (!gf || b.field(t, 2)) throw fail();
    function geometry(table, inherited, depth = 0) {
        if (depth > 1) throw fail();
        const tf = b.field(table, 6), type = inherited || (tf ? b.u8(tf) : 0);
        if ([2, 3, 4, 5].some(i => b.vector(table, i, 8).length)) throw fail();
        const parts = b.vector(table, 7, 4);
        if (type === 6) {
            if (!parts.length || parts.length > 10000) throw fail();
            return { type: 'MultiPolygon', coordinates: Array.from({ length: parts.length }, (_, i) => geometry(b.ptr(parts.start + i * 4), 3, depth + 1).coordinates) };
        }
        if (type !== 3 || parts.length) throw fail();
        const xy = b.vector(table, 1, 8), ends = b.vector(table, 0, 4);
        if (xy.length < 8 || xy.length % 2 || xy.length > 2000000) throw fail();
        const points = Array.from({ length: xy.length / 2 }, (_, i) => [b.f64(xy.start + i * 16), b.f64(xy.start + i * 16 + 8)]);
        const coordinates = []; let start = 0;
        for (let i = 0; i < (ends.length || 1); i++) {
            const end = ends.length ? b.u32(ends.start + i * 4) : points.length;
            if (end <= start || end > points.length) throw fail();
            coordinates.push(points.slice(start, end)); start = end;
        }
        if (start !== points.length) throw fail();
        return { type: 'Polygon', coordinates };
    }
    const shape = geometry(b.ptr(gf), header.geometryType), properties = {}, v = b.vector(t, 1, 1);
    const fixed = [1, 1, 1, 2, 2, 4, 4, 8, 8, 4, 8];
    let p = v.start; const end = p + v.length;
    while (p < end) {
        const index = b.u16(p); p += 2; const c = header.columns[index]; if (!c) throw fail();
        const size = fixed[c.type];
        if (size) {
            b.check(p, size);
            if (allowlist.includes(c.name)) {
                const getters = ['getInt8', 'getUint8', 'getUint8', 'getInt16', 'getUint16', 'getInt32', 'getUint32', 'getBigInt64', 'getBigUint64', 'getFloat32', 'getFloat64'];
                const n = Number(b.v[getters[c.type]](p, true)); if (!Number.isFinite(n)) throw fail(); properties[c.name] = n;
            }
            p += size;
        } else if (c.type >= 11 && c.type <= 14) {
            const size = b.u32(p); p += 4; b.check(p, size);
            if (allowlist.includes(c.name) && c.type === 11) properties[c.name] = decoder.decode(bytes.subarray(p, p + size));
            p += size;
        } else throw fail();
        if (p > end) throw fail();
    }
    return { type: 'Feature', geometry: shape, properties };
}
