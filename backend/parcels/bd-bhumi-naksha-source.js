// Reads a bounded Ministry of Land mouza through its anonymous CSRF session.
// The snapshot index preserves every WKT ring and uses the published sheet/plot composite key.
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
import { parseKeralaWktPolygon } from './kerala-wkt.js';
import { canonicalParcelFeature, providerHttpError, upstreamError } from './source-contract.js';
import { HttpError } from '../utils/helpers.js';

const HOME = 'https://map.land.gov.bd/';
const ENDPOINT = `${HOME}getGeomByCode`;
const PREFIX = 'bd-map-land:';
const KEY = /^([a-z0-9]+(?:_[a-z0-9]+)*):plot-(0|[1-9][0-9]{0,11})$/;

async function readText(response, limit) {
    if (!response.ok) throw providerHttpError(response);
    if (Number(response.headers.get('content-length')) > limit || !response.body?.getReader) {
        throw upstreamError('Bhumi Naksha returned an oversized or unreadable response.');
    }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw upstreamError('Bhumi Naksha response exceeds the byte limit.');
            chunks.push(value);
        }
        const length = response.headers.get('content-length');
        if (length && !response.headers.get('content-encoding') && Number(length) !== size) {
            throw upstreamError('Bhumi Naksha response was truncated.');
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
        try { await reader.cancel(); } catch { /* The stream may already be closed. */ }
        throw error;
    } finally { reader.releaseLock(); }
}

export function createBhumiNakshaParcelSource(descriptor, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const form = descriptor.mouzaForm;
    if (descriptor.endpoint !== ENDPOINT || descriptor.catalogueUrl !== HOME || descriptor.idPrefix !== PREFIX
        || !form || Object.keys(form).length !== 4 || form.level !== 'forMauza' || form.plotOrLanduse !== 'plot'
        || !/^[a-z]{3}_[a-z]{3}$/.test(form.tableName) || !/^[0-9]{12}$/.test(form.mauzaVal)
        || !Array.isArray(descriptor.sheetNamespaces) || !descriptor.sheetNamespaces.length
        || descriptor.sheetNamespaces.length > 50 || new Set(descriptor.sheetNamespaces).size !== descriptor.sheetNamespaces.length
        || descriptor.sheetNamespaces.some(code => !new RegExp(`^${form.tableName}_[a-z]{3}_[0-9]{3}_[0-9]{3}_[a-z]{2}$`).test(code))
        || !Number.isSafeInteger(descriptor.expectedSnapshotFeatures) || descriptor.expectedSnapshotFeatures < 1
        || descriptor.expectedSnapshotFeatures > 10000 || !Number.isSafeInteger(descriptor.maxSnapshotBytes)
        || descriptor.maxSnapshotBytes < 1024 || descriptor.maxSnapshotBytes > 16 * 1024 * 1024
        || descriptor.outFields?.length !== 2 || descriptor.outFields[0] !== 'm_code' || descriptor.outFields[1] !== 'plot_no_en'
        || typeof fetchImpl !== 'function') throw new Error('Invalid Bhumi Naksha mouza descriptor.');

    const namespaces = new Set(descriptor.sheetNamespaces);
    const validKey = key => {
        const match = KEY.exec(key);
        return match && namespaces.has(match[1]);
    };
    const transport = async (_url, options) => {
        // Each independent snapshot load starts a fresh public session. Cookies and CSRF
        // state live only in this operation, including when carried by the browser relay.
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
            const home = await fetchImpl(HOME, { signal: options.signal, redirect: 'error',
                headers: { Accept: 'text/html' } });
            const html = await readText(home, 2 * 1024 * 1024);
            const token = /<meta\s+name=["']csrf-token["']\s+content=["']([A-Za-z0-9]{20,256})["']/i.exec(html)?.[1];
            const cookies = typeof home.headers.getSetCookie === 'function' ? home.headers.getSetCookie()
                : [home.headers.get('set-cookie')].filter(Boolean);
            const cookie = cookies.map(value => value.split(';', 1)[0]).join('; ');
            if (!token || !cookie) throw upstreamError('Bhumi Naksha public session was not established.');
            response = await fetchImpl(ENDPOINT, { signal: options.signal, method: 'POST', redirect: 'error',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
                    Referer: HOME, Cookie: cookie },
                body: new URLSearchParams({ ...form, _token: token }).toString() });
            if (response.status !== 419 || attempt === 1) break;
            await response.body?.cancel();
        }
        let data;
        const text = await readText(response, descriptor.maxSnapshotBytes);
        try { data = JSON.parse(text); } catch { throw upstreamError('Bhumi Naksha returned invalid plot JSON.'); }
        if (!Array.isArray(data.plots) || data.plots.length !== descriptor.expectedSnapshotFeatures
            || data.complete === false || data.exceededTransferLimit === true) {
            throw upstreamError('Bhumi Naksha mouza count changed or is incomplete; coverage needs rechecking.');
        }
        const seen = new Set();
        const features = data.plots.map(row => {
            const code = typeof row?.m_code === 'string' ? row.m_code.toLowerCase() : '';
            const plot = Number.isSafeInteger(row?.plot_no_en) && row.plot_no_en >= 0
                ? String(row.plot_no_en) : typeof row?.plot_no_en === 'string' ? row.plot_no_en : '';
            const key = `${code}:plot-${plot}`;
            if (!validKey(key) || seen.has(key)) throw upstreamError('Bhumi Naksha returned a foreign or repeated native plot key.');
            seen.add(key);
            // Only 2D polygon WKT is part of this source contract. Never discard Z/M silently.
            if (typeof row.geom !== 'string' || !/^\s*(?:MULTI)?POLYGON\s*\(/i.test(row.geom)
                || row.geom.replace(/^\s*(?:MULTI)?POLYGON\s*/i, '').split(/[(),]/).some(tuple =>
                    tuple.trim() && tuple.trim().split(/\s+/).length !== 2)) {
                throw upstreamError('Bhumi Naksha returned unsupported plot geometry.');
            }
            const geometry = parseKeralaWktPolygon(row.geom);
            return { type: 'Feature', geometry, properties: { parcelKey: key } };
        });
        const observed = new Set(features.map(feature => KEY.exec(feature.properties.parcelKey)[1]));
        if (observed.size !== namespaces.size) throw upstreamError('Bhumi Naksha omitted a configured survey sheet.');
        return new Response(JSON.stringify({ type: 'FeatureCollection', features, complete: true }), {
            headers: { 'Content-Type': 'application/geo+json' }
        });
    };
    const indexed = createGeojsonSnapshotParcelSource({ ...descriptor, adapter: 'geojson-snapshot',
        idFields: ['parcelKey'], outFields: ['parcelKey'], parcelNumberField: undefined }, { fetchImpl: transport, now });
    function outward(result) {
        const features = result.features.map(feature => {
            const key = feature.properties.sourceProperties.parcelKey;
            const [, m_code, plot_no_en] = KEY.exec(key);
            return canonicalParcelFeature(descriptor, { geometry: feature.geometry, properties: { m_code, plot_no_en } }, key);
        });
        return { ...result, features, coverageScope: 'configured-mouza-only',
            ...(result.absentIds ? { absentIds: result.absentIds.map(id => PREFIX + decodeURIComponent(id.slice(PREFIX.length))) } : {}) };
    }
    return Object.freeze({
        queryBounds: async bbox => outward(await indexed.queryBounds(bbox)),
        queryGeometry: async geometry => outward(await indexed.queryGeometry(geometry)),
        queryIds: async ids => {
            if (!Array.isArray(ids) || !ids.length || ids.length > 80 || ids.some(id => typeof id !== 'string'
                || !id.startsWith(PREFIX) || !validKey(id.slice(PREFIX.length)))) {
                throw new HttpError(400, 'Provide 1–80 native plot IDs from the configured Bhumi Naksha mouza.');
            }
            return outward(await indexed.queryIds(ids.map(id => PREFIX + encodeURIComponent(id.slice(PREFIX.length)))));
        }
    });
}
