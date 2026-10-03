// DGU's composite cadastral key preserves HR IDs independently of imported row IDs.
import { createWfsParcelSource } from './wfs-source.js';
import { upstreamError } from './source-contract.js';

const KEY = /^[0-9]{6}-[0-9]+(?:\/[0-9]+)?$/;

export function createDguParcelSource(descriptor, { fetchImpl = globalThis.fetch,
    token = process.env.OSS_PUBLIC_ACCESS_TOKEN || process.env.OSS_TOKEN } = {}) {
    if (descriptor.endpoint !== 'https://oss.uredjenazemlja.hr/OssWebServices/wfs') {
        throw new Error('Invalid DGU parcel endpoint.');
    }
    const transport = async (url, options) => {
        if (!token) throw upstreamError('DGU public WFS access token is not configured.');
        const target = new URL(url);
        target.searchParams.set('token', token);
        target.searchParams.set('outputFormat', 'json');
        target.searchParams.set('sortBy', 'CESTICA_ID');
        const filter = target.searchParams.get('cql_filter');
        if (filter) {
            const values = /^PARCEL_KEY IN \((.*)\)$/.exec(filter)?.[1]?.split(',');
            if (!values?.length) throw new Error('Invalid DGU ID filter.');
            const clauses = values.map(value => {
                const key = /^'([^']+)'$/.exec(value)?.[1];
                if (!key || !KEY.test(key)) throw new Error('Invalid DGU cadastral key.');
                const [municipality, number] = key.split('-');
                return `(MATICNI_BROJ_KO=${municipality} AND BROJ_CESTICE='${number}')`;
            });
            target.searchParams.set('cql_filter', clauses.join(' OR '));
        }
        let response;
        try { response = await fetchImpl(target.href, options); }
        catch (error) {
            if (options.signal?.aborted) throw error;
            // Do not include a credential-bearing URL in provider errors.
            throw upstreamError('DGU parcel provider is unavailable.');
        }
        if (!response.ok) return response;
        const payload = await response.json();
        if (!Array.isArray(payload?.features)) throw upstreamError('DGU returned no parcel feature collection.');
        const features = payload.features.map(feature => {
            const p = feature.properties || {};
            const key = `${p.MATICNI_BROJ_KO}-${p.BROJ_CESTICE}`;
            if (!KEY.test(key) || !Number.isSafeInteger(p.CESTICA_ID)) throw upstreamError('DGU returned an invalid cadastral identity.');
            return { ...feature, id: feature.id || `DKP_CESTICE.${p.CESTICA_ID}`,
                properties: { ...p, PARCEL_KEY: key } };
        });
        return { ok: true, json: async () => ({ ...payload, features,
            numberMatched: payload.numberMatched ?? payload.totalFeatures,
            numberReturned: payload.numberReturned ?? features.length }) };
    };
    return createWfsParcelSource(descriptor, { fetchImpl: transport });
}
