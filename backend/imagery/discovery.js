// A bounded check of a public XYZ template or WMS: inspect metadata where available, then fetch
// an actual image at the selected WGS84 location. A service exception/XML body is never a tile.
import { SaxesParser } from 'saxes';
import { createCanvas, loadImage } from 'canvas';
import { HttpError } from '../utils/helpers.js';
import { validatePublicSourceUrl } from '../parcels/public-source-fetch.js';
import { canonicalImageryConfig } from './custom-source.js';

const failure = (status, code, message, extra = {}) => Object.assign(new HttpError(status, message), { code, ...extra });
const child = (node, name) => node?.children?.find(entry => entry.name === name);
const children = (node, name) => (node?.children || []).filter(entry => entry.name === name);
const value = (node, name) => child(node, name)?.text.trim().replace(/\s+/g, ' ') || '';
const attribute = (node, name) => Object.entries(node?.attrs || {}).find(([key]) => key.split(':').at(-1) === name)?.[1];

export function readWmsCapabilities(xml) {
    if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
        throw failure(422, 'imagery-capabilities-invalid', 'WMS capabilities are missing or too large.');
    const parser = new SaxesParser({ xmlns: false });
    const stack = [];
    let root = null, count = 0;
    parser.on('opentag', tag => {
        if (++count > 6000 || stack.length > 32) throw new Error('WMS capabilities exceed structural limits.');
        const node = { name: tag.name.split(':').at(-1), attrs: tag.attributes, text: '', children: [] };
        if (stack.length) stack.at(-1).children.push(node); else root = node;
        stack.push(node);
    });
    parser.on('text', text => { if (stack.length) stack.at(-1).text += text.slice(0, 512); });
    parser.on('closetag', () => stack.pop());
    try { parser.write(xml).close(); } catch {
        throw failure(422, 'imagery-capabilities-invalid', 'WMS capabilities could not be parsed.');
    }
    if (!['WMS_Capabilities', 'WMT_MS_Capabilities'].includes(root?.name))
        throw failure(422, 'imagery-capabilities-invalid', 'The endpoint did not return WMS capabilities.');
    const version = attribute(root, 'version');
    if (!['1.1.1', '1.3.0'].includes(version))
        throw failure(422, 'imagery-version-unsupported', 'This WMS version is unsupported.');
    const capability = child(root, 'Capability');
    const getMap = child(child(capability, 'Request'), 'GetMap');
    const formats = children(getMap, 'Format').map(node => node.text.trim().toLowerCase());
    const format = ['image/png', 'image/jpeg'].find(item => formats.includes(item));
    if (!format) throw failure(422, 'imagery-format-unsupported', 'WMS does not advertise PNG or JPEG maps.');
    const service = child(root, 'Service');
    const title = value(service, 'Title');
    const layers = [];
    function walk(node, inherited = { crs: [], bounds: null, attribution: '' }) {
        const ownCrs = [...children(node, 'CRS'), ...children(node, 'SRS')]
            .flatMap(entry => entry.text.trim().split(/\s+/)).filter(Boolean);
        const crs = [...new Set([...inherited.crs, ...ownCrs])];
        const geo = child(node, 'EX_GeographicBoundingBox');
        const oldGeo = child(node, 'LatLonBoundingBox');
        const proposed = geo
            ? ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map(key => Number(value(geo, key)))
            : oldGeo ? ['minx', 'miny', 'maxx', 'maxy'].map(key => Number(attribute(oldGeo, key))) : null;
        const bounds = proposed && proposed.every(Number.isFinite) && proposed[0] < proposed[2] && proposed[1] < proposed[3]
            ? proposed : inherited.bounds;
        const attribution = value(child(node, 'Attribution'), 'Title') || inherited.attribution;
        const name = value(node, 'Name');
        if (name) layers.push({ name, title: value(node, 'Title') || name, crs, bounds, attribution });
        children(node, 'Layer').forEach(next => walk(next, { crs, bounds, attribution }));
    }
    children(capability, 'Layer').forEach(node => walk(node));
    if (!layers.length) throw failure(422, 'imagery-layers-missing', 'WMS has no named map layers.');
    return { version, title, format, layers };
}

export function xyzTileAt(bbox, zoom = null) {
    const [west, south, east, north] = bbox;
    const z = zoom ?? Math.max(0, Math.min(18, Math.round(Math.log2(360 / Math.max(east - west, 0.00001))) - 1));
    const lon = (west + east) / 2, lat = Math.max(-85.05112878, Math.min(85.05112878, (south + north) / 2));
    const n = 2 ** z;
    return { z, x: Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n))),
        y: Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n))) };
}

export function xyzTileBounds(z, x, y) {
    const n = 2 ** z;
    const latitude = row => Math.atan(Math.sinh(Math.PI * (1 - 2 * row / n))) * 180 / Math.PI;
    return [x / n * 360 - 180, latitude(y + 1), (x + 1) / n * 360 - 180, latitude(y)];
}

export function xyzTileUrl(source, z, x, y) {
    const url = source.endpoint.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    return validatePublicSourceUrl(url).href;
}

export function wmsMapUrl(source, bbox, width = 256, height = 256) {
    const url = validatePublicSourceUrl(source.endpoint);
    const [west, south, east, north] = bbox;
    const mercator = (lon, lat) => {
        const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
        return [lon * 20037508.342789244 / 180,
            Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360)) * 6378137];
    };
    let mapped = bbox;
    if (source.crs === 'EPSG:3857') {
        const a = mercator(west, south), b = mercator(east, north);
        mapped = [a[0], a[1], b[0], b[1]];
    } else if (source.crs === 'EPSG:4326' && source.version === '1.3.0') {
        mapped = [south, west, north, east];
    }
    for (const key of [...url.searchParams.keys()]) {
        if (/^(service|request|version|layers|styles|format|transparent|bbox|width|height|crs|srs)$/i.test(key)) url.searchParams.delete(key);
    }
    const params = { SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: source.version,
        LAYERS: source.layers.join(','), STYLES: '', FORMAT: source.format,
        TRANSPARENT: 'TRUE', [source.version === '1.3.0' ? 'CRS' : 'SRS']: source.crs,
        BBOX: mapped.join(','), WIDTH: String(width), HEIGHT: String(height) };
    for (const [key, val] of Object.entries(params)) url.searchParams.set(key, val);
    return url.href;
}

export async function readImageryImage(fetchImpl, url, options = {}) {
    const response = await fetchImpl(url, { signal: options.signal, redirect: 'error' });
    if (!response.ok) {
        const code = [401, 403].includes(response.status) ? 'imagery-source-blocked'
            : response.status === 429 ? 'imagery-source-rate-limited' : 'imagery-source-unavailable';
        throw failure(502, code, `Imagery provider returned HTTP ${response.status}.`, { upstreamStatus: response.status });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && bytes.toString('ascii', 12, 16) === 'IHDR';
    const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8
        && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    if (!png && !jpeg) throw failure(422, 'imagery-not-image', 'Imagery provider did not return a PNG or JPEG map.');
    // Reject image bombs before asking the decoder to allocate their claimed pixel dimensions.
    let dimensions = null;
    if (png) dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    else {
        for (let at = 2; at + 9 < bytes.length;) {
            if (bytes[at] !== 0xff) break;
            const marker = bytes[at + 1], size = bytes.readUInt16BE(at + 2);
            if (size < 2 || at + 2 + size > bytes.length) break;
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                dimensions = [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
                break;
            }
            at += 2 + size;
        }
    }
    if (!dimensions || dimensions.some(size => size < 1 || size > 512))
        throw failure(422, 'imagery-image-size', 'Imagery provider returned an unsupported image size.');
    let decoded;
    try { decoded = await loadImage(bytes); } catch {
        throw failure(422, 'imagery-not-image', 'Imagery provider returned an invalid image.');
    }
    if (decoded.width !== dimensions[0] || decoded.height !== dimensions[1]
        || (options.width && decoded.width !== options.width) || (options.height && decoded.height !== options.height))
        throw failure(422, 'imagery-image-size', 'Imagery provider returned an unexpected image size.');
    if (options.requireVisible && png) {
        const canvas = createCanvas(decoded.width, decoded.height), context = canvas.getContext('2d');
        context.drawImage(decoded, 0, 0);
        const alpha = context.getImageData(0, 0, decoded.width, decoded.height).data;
        let visible = false;
        for (let at = 3; at < alpha.length; at += 4) if (alpha[at] > 0) { visible = true; break; }
        if (!visible) throw failure(422, 'imagery-empty-sample', 'Imagery source returned no visible image at this location.');
    }
    return { bytes, contentType: png ? 'image/png' : 'image/jpeg', width: decoded.width, height: decoded.height, decoded };
}

// A geographic WMS encodes latitude linearly in its rows. A Web Mercator tile does not: output
// rows are linear in Mercator northing. Resample once on the server so the tile lands at the right
// map coordinates even at low zoom. EPSG:3857 WMS images need no warp.
export function warpGeographicImage(image, bbox) {
    const { width, height, decoded } = image;
    const input = createCanvas(width, height);
    const sourceContext = input.getContext('2d');
    sourceContext.drawImage(decoded, 0, 0);
    const source = sourceContext.getImageData(0, 0, width, height).data;
    const output = createCanvas(width, height);
    const outputContext = output.getContext('2d');
    const pixels = outputContext.createImageData(width, height);
    const south = bbox[1] * Math.PI / 180, north = bbox[3] * Math.PI / 180;
    const mercator = latitude => Math.log(Math.tan(Math.PI / 4 + latitude / 2));
    const top = mercator(north), bottom = mercator(south);
    for (let y = 0; y < height; y++) {
        const mercatorY = top + (bottom - top) * (y + 0.5) / height;
        const latitude = 2 * Math.atan(Math.exp(mercatorY)) - Math.PI / 2;
        const sourceY = Math.max(0, Math.min(height - 1, (north - latitude) / (north - south) * height - 0.5));
        const first = Math.floor(sourceY), second = Math.min(height - 1, first + 1), fraction = sourceY - first;
        for (let x = 0; x < width; x++) {
            const dst = (y * width + x) * 4, a = (first * width + x) * 4, b = (second * width + x) * 4;
            for (let channel = 0; channel < 4; channel++)
                pixels.data[dst + channel] = Math.round(source[a + channel] * (1 - fraction) + source[b + channel] * fraction);
        }
    }
    outputContext.putImageData(pixels, 0, 0);
    return { bytes: output.toBuffer('image/png'), contentType: 'image/png', width, height };
}

export async function discoverImagerySource({ url, city, bbox, layers }, { fetchImpl }) {
    const input = validatePublicSourceUrl(url);
    if ([...input.searchParams.keys()].some(key => /(?:auth|token|key|secret|password|signature|^sig$)/i.test(key)))
        throw failure(400, 'invalid-imagery-source', 'Imagery source must be public.');
    const endpoint = input.href;
    const template = endpoint.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
    const attempts = [];
    if (['{z}', '{x}', '{y}'].every(token => template.includes(token))) {
        const source = canonicalImageryConfig({ kind: 'imagery', adapter: 'xyz', endpoint: template,
            ...(city ? { cityIds: [city] } : {}), name: input.hostname });
        const tile = xyzTileAt(bbox);
        await readImageryImage(fetchImpl, xyzTileUrl(source, tile.z, tile.x, tile.y), { requireVisible: true });
        attempts.push({ adapter: 'xyz', status: 'verified' });
        return { descriptor: source, attempts };
    }
    const capabilitiesUrl = new URL(input);
    for (const key of [...capabilitiesUrl.searchParams.keys()]) {
        if (/^(service|request|version|layers|styles|format|transparent|bbox|width|height|crs|srs)$/i.test(key))
            capabilitiesUrl.searchParams.delete(key);
    }
    capabilitiesUrl.searchParams.set('SERVICE', 'WMS');
    capabilitiesUrl.searchParams.set('REQUEST', 'GetCapabilities');
    const response = await fetchImpl(capabilitiesUrl.href, { redirect: 'error' });
    if (!response.ok) throw failure(502, 'imagery-source-unavailable', `WMS capabilities returned HTTP ${response.status}.`,
        { upstreamStatus: response.status });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 1024 * 1024) throw failure(422, 'imagery-capabilities-invalid', 'WMS capabilities are too large.');
    const capabilities = readWmsCapabilities(bytes.toString('utf8'));
    const requested = layers ?? [...input.searchParams].find(([key]) => key.toLowerCase() === 'layers')?.[1]?.split(',');
    const selected = requested
        ? (Array.isArray(requested) && requested.length > 0 && requested.length <= 8
            ? requested.map(name => capabilities.layers.find(layer => layer.name === name)) : [])
        : capabilities.layers.length === 1 ? [capabilities.layers[0]] : [];
    if (!requested && !selected.length) {
        return { selectionRequired: true,
            layers: capabilities.layers.slice(0, 50).map(layer => ({ name: layer.name, title: layer.title })),
            attempts: [{ adapter: 'wms', status: 'layers-required' }] };
    }
    if (!selected.length || selected.some(item => !item)) throw failure(422, 'imagery-layers-invalid', 'Requested WMS layers are unavailable.');
    if (selected.every(layer => layer.bounds && (bbox[0] >= layer.bounds[2] || layer.bounds[0] >= bbox[2]
        || bbox[1] >= layer.bounds[3] || layer.bounds[1] >= bbox[3])))
        throw failure(422, 'imagery-outside-bounds', 'The selected WMS layers do not cover this location.');
    const crs = ['EPSG:3857', 'CRS:84', 'EPSG:4326']
        .find(candidate => !(candidate === 'CRS:84' && capabilities.version === '1.1.1')
            && selected.every(layer => layer.crs.includes(candidate)));
    if (!crs) throw failure(422, 'imagery-crs-unsupported', 'WMS layers have no common web-map CRS.');
    const bounds = selected.length === 1 ? selected[0].bounds : null;
    capabilitiesUrl.searchParams.delete('SERVICE');
    capabilitiesUrl.searchParams.delete('REQUEST');
    const credits = [...new Set(selected.map(layer => layer.attribution).filter(Boolean))].join(' · ');
    const source = canonicalImageryConfig({ kind: 'imagery', adapter: 'wms', endpoint: capabilitiesUrl.href,
        ...(city ? { cityIds: [city] } : {}), name: capabilities.title || input.hostname, layers: selected.map(layer => layer.name),
        version: capabilities.version, crs, format: capabilities.format,
        ...(bounds ? { bounds } : {}), ...(credits && credits.length <= 300 ? { attribution: credits } : {}) });
    await readImageryImage(fetchImpl, wmsMapUrl(source, bbox), { width: 256, height: 256, requireVisible: true });
    attempts.push({ adapter: 'wms', status: 'verified' });
    return { descriptor: source, attempts };
}
