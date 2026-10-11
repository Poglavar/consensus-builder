import { upstreamError } from './source-contract.js';

export function parseKeralaWktPolygon(wkt) {
    if (typeof wkt !== 'string' || wkt.length > 1000000) throw upstreamError('Kerala parcel geometry is missing or too large.');
    const typeMatch = /^\s*(POLYGON|MULTIPOLYGON)(?:\s+(?:Z|M|ZM))?\s*/i.exec(wkt);
    if (!typeMatch) throw upstreamError('Kerala returned an unsupported parcel geometry.');
    const type = typeMatch[1].toUpperCase() === 'MULTIPOLYGON' ? 'MultiPolygon' : 'Polygon';
    const groupDepth = type === 'Polygon' ? 2 : 3;
    const text = wkt.slice(typeMatch[0].length);
    let at = 0;
    const numberPattern = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/;
    function group(depth = 0) {
        if (depth >= groupDepth) throw upstreamError('Kerala returned excessively nested parcel geometry.');
        while (/\s/.test(text[at] || '')) at++;
        if (text[at++] !== '(') throw upstreamError('Kerala returned malformed parcel geometry.');
        const values = [];
        for (;;) {
            while (/\s/.test(text[at] || '')) at++;
            if (text[at] === '(') {
                if (depth === groupDepth - 1) throw upstreamError('Kerala returned excessively nested parcel geometry.');
                values.push(group(depth + 1));
            } else {
                if (depth !== groupDepth - 1) throw upstreamError('Kerala returned malformed parcel geometry nesting.');
                const point = [];
                for (;;) {
                    while (/\s/.test(text[at] || '')) at++;
                    const match = numberPattern.exec(text.slice(at));
                    if (!match) break;
                    point.push(Number(match[0])); at += match[0].length;
                }
                if (point.length < 2 || point.some(value => !Number.isFinite(value))) throw upstreamError('Kerala returned malformed parcel coordinates.');
                values.push(point.slice(0, 2));
            }
            while (/\s/.test(text[at] || '')) at++;
            if (text[at] === ',') { at++; continue; }
            if (text[at] === ')') { at++; break; }
            throw upstreamError('Kerala returned malformed parcel geometry.');
        }
        return values;
    }
    const coordinates = group();
    while (/\s/.test(text[at] || '')) at++;
    if (at !== text.length) throw upstreamError('Kerala returned malformed parcel geometry.');
    return { type, coordinates };
}
