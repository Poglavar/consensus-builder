// Fetches a live parcel source (another country's land register, proxied by our API) for the
// proposing bots. Bounded read retries recover one-off register failures while keeping incomplete
// replies unavailable; the same policy also covers the runner's local candidate-binding reads.
import { retryParcelRead } from './parcel-read-retry.js';

const PROVIDER_CODES = new Set(['parcel-source-unavailable', 'parcel-source-blocked', 'parcel-source-rate-limited']);

async function responseError(response) {
    const error = Object.assign(new Error(`HTTP ${response.status}`), { status: response.status, code: 'agent-parcel-http' });
    // A gateway can return HTML. Never include its raw body, or an arbitrary upstream error, in the ledger.
    let body;
    try { body = await response.json(); } catch { /* HTTP status remains sufficient for a non-JSON gateway. */ }
    if (PROVIDER_CODES.has(body?.code)) {
        error.code = body.code;
        if (typeof body.error === 'string') error.message += `: ${body.error}`;
        if (Number.isInteger(body.upstreamStatus)) error.upstreamStatus = body.upstreamStatus;
        const counts = body.parcelCounts;
        if (counts && ['matched', 'returned', 'received'].every(k => counts[k] === null || (Number.isSafeInteger(counts[k]) && counts[k] >= 0))) {
            error.parcelCounts = { matched: counts.matched, returned: counts.returned, received: counts.received };
            const detail = `matched=${counts.matched} returned=${counts.returned} received=${counts.received}`;
            if (!error.message.includes(detail)) error.message += ` ${detail}`;
        }
    }
    const header = response.headers?.get('Retry-After');
    const headerSeconds = /^\d+$/.test(header ?? '') ? Number(header)
        : header && Number.isFinite(Date.parse(header)) ? Math.max(0, Math.ceil((Date.parse(header) - Date.now()) / 1000)) : 0;
    error.retryAfterSeconds = Math.max(headerSeconds, Number.isFinite(body?.retryAfterSeconds) && body.retryAfterSeconds >= 0 ? body.retryAfterSeconds : 0);
    return error;
}

export async function fetchSourceParcels(apiBase, sourceId, bbox, {
    fetchImpl = fetch,
    ...retryOptions
} = {}) {
    const url = `${apiBase}/parcel-sources/${encodeURIComponent(sourceId)}?bbox=${bbox.join(',')}`;
    return retryParcelRead(async signal => {
        const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
        if (response.ok) {
            const collection = await response.json();
            if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features) || collection.complete !== true) {
                throw Object.assign(new Error('Parcel source did not return a complete FeatureCollection.'), { code: 'parcel-source-unavailable', status: 502 });
            }
            return collection;
        }
        throw await responseError(response);
    }, { ...retryOptions, sourceId, retryNetworkErrors: true });
}
