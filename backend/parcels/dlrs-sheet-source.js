// DLRS publishes one complete, small BDS survey sheet per anonymous form request.
// Survey, district, mouza and sheet belong to the configured source namespace; Dag_No is the plot key.
import { createHash } from 'node:crypto';
import { createGeojsonSnapshotParcelSource } from './geojson-snapshot-source.js';
import { upstreamError, providerHttpError } from './source-contract.js';

const ENDPOINT = 'https://settlement.gov.bd/Khatian/GetSheetJsonBySurvey';
const PLOT_KEY = /^[1-9][0-9]{0,11}(?:\/[1-9][0-9]{0,11})?$/;

export function createDlrsSheetParcelSource(descriptor, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    const form = descriptor.sheetForm;
    if (descriptor.endpoint !== ENDPOINT || !form || Object.keys(form).length !== 4
        || !['rsnum', 'comcod', 'unitcod', 'sheetno'].every(key => typeof form[key] === 'string' && /^[0-9]{3,9}$/.test(form[key]))
        || descriptor.idPrefix !== `BD-DLRS-${form.rsnum}-${form.comcod}-${form.unitcod}-${form.sheetno}-`
        || !Number.isSafeInteger(descriptor.expectedSnapshotFeatures) || descriptor.expectedSnapshotFeatures < 1
        || descriptor.expectedSnapshotFeatures > 5000 || !Number.isSafeInteger(descriptor.maxSnapshotBytes)
        || descriptor.maxSnapshotBytes < 1 || descriptor.maxSnapshotBytes > 2 * 1024 * 1024) {
        throw new Error('Invalid DLRS survey-sheet descriptor.');
    }
    const transport = async (_url, options) => {
        let response;
        try {
            response = await fetchImpl(ENDPOINT, {
                ...options, method: 'POST', redirect: 'error',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept-Language': 'bn,en;q=0.7', Referer: 'https://settlement.gov.bd/',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36' },
                body: new URLSearchParams(form).toString()
            });
        } catch (error) {
            if (options.signal?.aborted) throw error;
            throw upstreamError('DLRS survey-sheet provider is unavailable.');
        }
        if (!response.ok) throw providerHttpError(response);
        const reader = response.body?.getReader();
        if (!reader) throw upstreamError('DLRS returned no readable survey sheet.');
        const chunks = [];
        let length = 0;
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.byteLength;
                if (length > descriptor.maxSnapshotBytes) throw upstreamError('DLRS survey sheet exceeds byte limit.');
                chunks.push(chunk.value);
            }
        } catch (error) {
            try { await reader.cancel(); } catch { /* Stream may already be closed. */ }
            throw error;
        } finally { reader.releaseLock(); }
        const declared = response.headers.get('content-length');
        if (declared && !response.headers.get('content-encoding') && Number(declared) !== length) {
            throw upstreamError('DLRS survey sheet has an incomplete response body.');
        }
        const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length);
        let collection;
        try { collection = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw upstreamError('DLRS returned an invalid survey sheet.'); }
        if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)
            || collection.features.length !== descriptor.expectedSnapshotFeatures
            || collection.complete === false || collection.exceededTransferLimit === true) {
            throw upstreamError('DLRS survey-sheet count no longer matches the verified sheet; coverage needs rechecking.');
        }
        const features = collection.features.map(feature => {
            const value = feature?.properties?.Dag_No;
            const key = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
            if (!PLOT_KEY.test(key)) throw upstreamError('DLRS returned an invalid native plot number.');
            // Do not retain any unrelated properties from a future provider response.
            return { type: feature.type, geometry: feature.geometry, properties: { Dag_No: key } };
        });
        // The fixed whole-sheet operation and its independently verified feature count establish
        // completeness. This proxy ETag identifies the bytes read; it is not an upstream validator.
        const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
        return new Response(JSON.stringify({ type: collection.type, crs: collection.crs, features,
            complete: true, numberMatched: features.length }), { status: 200, headers: { ETag: etag } });
    };
    return createGeojsonSnapshotParcelSource({ ...descriptor, adapter: 'geojson-snapshot',
        idFields: ['Dag_No'], outFields: ['Dag_No'], parcelNumberField: 'Dag_No' }, { fetchImpl: transport, now });
}
