// Feature-at-a-time JSON parsing: the full source and its private attributes are never retained.
import { utf8ByteLength } from './byte-utils.js';
import { upstreamError } from './source-contract.js';

const whitespace = c => c === ' ' || c === '\t' || c === '\r' || c === '\n';

export async function readGeojsonFeatureStream(chunks, { maxRecordBytes, onFeature }) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0 || typeof onFeature !== 'function') {
        throw new Error('Invalid GeoJSON stream reader limits.');
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', position = 0, state = 'open', key, count = 0;
    let scan = 0, depth = 0, quoted = false, escaped = false, started = false, tokenKind;
    const metadata = Object.create(null), keys = new Set();
    const fail = () => { throw upstreamError('Invalid complete GeoJSON snapshot.', 502, 'parcel-snapshot-malformed'); };
    function token(final) {
        if (!started) {
            started = true; scan = position; depth = 0; quoted = false; escaped = false;
            tokenKind = buffer[position] === '"' ? 'string' : ['{', '['].includes(buffer[position]) ? 'container' : 'scalar';
        }
        for (; scan < buffer.length; scan++) {
            const c = buffer[scan];
            if (quoted) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') {
                    quoted = false;
                    if (tokenKind === 'string') { scan++; return finish(); }
                }
            } else {
                if (c === '"') quoted = true;
                else if (c === '{' || c === '[') depth++;
                else if (c === '}' || c === ']') {
                    if (tokenKind === 'scalar') return finish();
                    depth--;
                    if (depth === 0) { scan++; return finish(); }
                } else if (tokenKind === 'scalar' && (whitespace(c) || c === ',')) return finish();
            }
            if (scan - position > maxRecordBytes) throw upstreamError('GeoJSON record exceeds memory limit.');
        }
        if (final && tokenKind === 'scalar') return finish();
        if (final) fail();
        return { ready: false };
    }
    function finish() {
        const text = buffer.slice(position, scan);
        if (utf8ByteLength(text) > maxRecordBytes) throw upstreamError('GeoJSON record exceeds memory limit.');
        let value; try { value = JSON.parse(text); } catch { fail(); }
        position = scan; started = false;
        return { ready: true, value };
    }
    async function consume(final = false) {
        while (position < buffer.length) {
            if (!started && whitespace(buffer[position])) { position++; continue; }
            const c = buffer[position];
            if (state === 'done') fail();
            if (state === 'open') { if (c !== '{') fail(); position++; state = 'key-or-end'; }
            else if (state === 'key-or-end' && c === '}') { position++; state = 'done'; }
            else if (state === 'key-or-end' || state === 'key') {
                if (c !== '"') fail();
                const t = token(final); if (!t.ready) break;
                key = t.value; if (key.length > 256 || keys.has(key) || keys.size >= 32) fail(); keys.add(key); state = 'colon';
            } else if (state === 'colon') { if (c !== ':') fail(); position++; state = key === 'features' ? 'array' : 'value'; }
            else if (state === 'array') { if (c !== '[') fail(); position++; state = 'feature-or-end'; }
            else if (state === 'feature-or-end' && c === ']') { position++; state = 'member-end'; }
            else if (state === 'feature-or-end' || state === 'feature' || state === 'value') {
                const t = token(final); if (!t.ready) break;
                if (state === 'value') {
                    // Retained envelope metadata has its own small budget; arbitrary provider members are discarded.
                    if (key === 'type' && t.value !== 'FeatureCollection'
                        || key === 'name' && (typeof t.value !== 'string' || t.value.length > 1024)
                        || ['complete', 'exceededTransferLimit'].includes(key) && typeof t.value !== 'boolean') fail();
                    if (['type', 'name', 'crs', 'complete', 'exceededTransferLimit'].includes(key)) {
                        if (utf8ByteLength(JSON.stringify(t.value)) > 8192) throw upstreamError('GeoJSON metadata exceeds memory limit.');
                        metadata[key] = t.value;
                    }
                    state = 'member-end';
                }
                else { await onFeature(t.value, count++, metadata); state = 'feature-end'; }
            } else if (state === 'feature-end') {
                if (c === ',') state = 'feature'; else if (c === ']') state = 'member-end'; else fail(); position++;
            } else if (state === 'member-end') {
                if (c === ',') state = 'key'; else if (c === '}') state = 'done'; else fail(); position++;
            }
        }
        // Drop consumed text, including all non-identity provider properties.
        if (position) { buffer = buffer.slice(position); scan -= position; position = 0; }
        if (buffer.length > maxRecordBytes) throw upstreamError('GeoJSON record exceeds memory limit.');
        if (final && (state !== 'done' || !keys.has('features') || metadata.type !== 'FeatureCollection')) fail();
    }
    for await (const chunk of chunks) {
        // Bound decoder input even when a custom transport returns a single huge chunk.
        for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
            buffer += decoder.decode(chunk.subarray(offset, offset + 65536), { stream: true });
            await consume();
        }
    }
    buffer += decoder.decode(); await consume(true);
    if (metadata.complete === false || metadata.exceededTransferLimit === true) throw upstreamError('Parcel snapshot reports incomplete coverage.');
    const crs = metadata.crs;
    if (crs && (crs.type !== 'name' || Object.keys(crs).some(key => !['type', 'properties'].includes(key))
        || !crs.properties || Object.keys(crs.properties).some(key => key !== 'name')
        || !['urn:ogc:def:crs:OGC::CRS84', 'urn:ogc:def:crs:OGC:1.3:CRS84',
        'OGC:CRS84', 'CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326'].includes(crs.properties?.name))) {
        throw upstreamError('Parcel snapshot must use WGS84 GeoJSON coordinates.');
    }
    return { metadata, count };
}
