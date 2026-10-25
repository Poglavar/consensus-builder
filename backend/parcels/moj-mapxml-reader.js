// Ministry of Justice Map XML: retain native parcel IDs and geometry, never parcel attributes.
import { SaxesParser } from 'saxes';
import proj4 from 'proj4';
import { upstreamError, validateGeometry } from './source-contract.js';

export const MOJ_ZONE_10 = '+proj=tmerc +lat_0=40 +lon_0=140.833333333333333 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const MAP = 'http://www.moj.go.jp/MINJI/tizuxml', GEOM = 'http://www.moj.go.jp/MINJI/tizuzumen';
const fail = () => { throw upstreamError('Unsupported or incomplete Ministry of Justice parcel geometry.'); };
const children = (node, name) => node.children.filter(child => child.name === name);
const descendants = (node, name) => node.children.flatMap(child => (child.name === name ? [child] : descendants(child, name)));
const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
const single = nodes => { if (nodes.length !== 1) fail(); return nodes[0]; };
const number = node => { if (!node || !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(node.text.trim())) fail(); return Number(node.text); };
const xy = node => [number(single(children(node, 'Y'))), number(single(children(node, 'X')))];

export function parseMojMapXml(bytes, filename, { maxFeatures = 100000 } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 48 * 1024 * 1024 || !/^\d{5}-\d{4}-\d+\.xml$/.test(filename)) fail();
    const points = new Map(), curves = new Map(), surfaces = new Map(), parcels = new Map();
    const stack = []; let capture = null, coordinateSystem = null, datumClassification = null, nodes = 0;
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', fail);
    parser.on('opentag', tag => {
        if (++nodes > 3000000 || stack.length > 64) fail();
        const root = !capture && ((tag.uri === GEOM && ['GM_Point', 'GM_Curve', 'GM_Surface'].includes(tag.local))
            || (tag.uri === MAP && ['筆', '座標系', '測地系判別'].includes(tag.local)));
        const safe = root || capture && (tag.uri === GEOM || tag.uri === MAP && tag.local === '形状');
        const node = safe ? { name: tag.local, text: '', children: [], id: tag.attributes.id?.value,
            ref: tag.attributes.idref?.value } : null;
        if (root) capture = node;
        else if (node && stack.at(-1)) stack.at(-1).children.push(node);
        stack.push(node);
    });
    parser.on('text', text => { const node = stack.at(-1); if (node && ['X', 'Y', 'GM_OrientablePrimitive.orientation', '座標系', '測地系判別'].includes(node.name)) { node.text += text; if (node.text.length > 1024) fail(); } });
    parser.on('closetag', () => {
        const node = stack.pop(); if (!node || node !== capture) return;
        capture = null;
        const add = (map, value) => { if (!node.id || map.has(node.id)) fail(); map.set(node.id, value); };
        switch (node.name) {
        case '座標系': coordinateSystem = node.text.trim(); break;
        case '測地系判別': datumClassification = node.text.trim(); break;
        case 'GM_Point': add(points, xy(single(descendants(node, 'DirectPosition')))); break;
        case 'GM_Curve': add(curves, node); break;
        case 'GM_Surface': add(surfaces, node); break;
        case '筆': add(parcels, single(children(node, '形状')).ref); if (parcels.size > maxFeatures) fail(); break;
        }
    });
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        for (let i = 0; i < bytes.length; i += 65536) parser.write(decoder.decode(bytes.subarray(i, i + 65536), { stream: true }));
        parser.write(decoder.decode()).close();
    } catch { fail(); }
    if (coordinateSystem !== '公共座標10系') fail();
    const resolved = new Map();
    function curve(id, visited = new Set()) {
        if (resolved.has(id)) return resolved.get(id);
        if (visited.has(id)) fail(); visited.add(id);
        const node = curves.get(id); if (!node) fail();
        const columns = descendants(node, 'GM_PointArray.column');
        let coordinates;
        if (columns.length) coordinates = columns.map(column => {
            const direct = children(column, 'GM_Position.direct');
            if (direct.length) return xy(single(direct));
            const indirect = single(children(column, 'GM_Position.indirect'));
            const ref = single(children(indirect, 'GM_PointRef.point')).ref;
            const point = points.get(ref); if (!point) fail(); return point;
        });
        else {
            const primitive = single(descendants(node, 'GM_OrientablePrimitive.primitive'));
            coordinates = curve(primitive.ref, visited);
        }
        const orientation = descendants(node, 'GM_OrientablePrimitive.orientation');
        if (orientation.length && !['+', '-'].includes(single(orientation).text.trim())) fail();
        if (orientation[0]?.text.trim() === '-') coordinates = [...coordinates].reverse();
        if (coordinates.length < 2) fail();
        resolved.set(id, coordinates); return coordinates;
    }
    function ring(node) {
        const refs = children(node, 'GM_CompositeCurve.generator');
        if (!refs.length || refs.length !== node.children.length) fail();
        const segments = refs.map(ref => curve(ref.ref));
        // Referenced curves have their own stored direction. Traverse their shared native endpoints
        // in the literal ring reference order; never snap gaps or change any source vertex.
        for (const reverseFirst of [false, true]) {
            const output = reverseFirst ? [...segments[0]].reverse() : [...segments[0]];
            let ok = true;
            for (const segment of segments.slice(1)) {
                if (same(output.at(-1), segment[0])) output.push(...segment.slice(1));
                else if (same(output.at(-1), segment.at(-1))) output.push(...[...segment].reverse().slice(1));
                else { ok = false; break; }
            }
            if (ok && same(output[0], output.at(-1))) return output;
        }
        fail();
    }
    const transform = proj4(MOJ_ZONE_10, 'EPSG:4326');
    const features = [];
    for (const [id, surfaceId] of parcels) {
        const surface = surfaces.get(surfaceId); if (!surface) fail();
        const polygons = descendants(surface, 'GM_SurfaceBoundary').map(boundary => {
            const exterior = single(children(boundary, 'GM_SurfaceBoundary.exterior'));
            const interiors = children(boundary, 'GM_SurfaceBoundary.interior');
            if (boundary.children.length !== 1 + interiors.length) fail();
            return [exterior, ...interiors].map(part => ring(single(children(part, 'GM_Ring')))
                .map(point => transform.forward(point)));
        });
        const geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
        if (!validateGeometry(geometry)) fail();
        features.push({ type: 'Feature', id: `${filename}#${id}`, properties: { id: `${filename}#${id}` }, geometry });
    }
    return { features, metadata: { filename, coordinateSystem, datumClassification, parcelCount: parcels.size } };
}
