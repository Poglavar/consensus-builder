// Fetches a live parcel source (another country's land register, proxied by our API) for the
// proposing bots. A source's server error is retried once before the run fails: these registers
// have one-off hiccups (2026-10-14: Spain's cadastre answered 502 once and the next run was fine).
import { setTimeout as delay } from 'node:timers/promises';

export async function fetchSourceParcels(apiBase, sourceId, bbox, {
    fetchImpl = fetch,
    retryDelayMs = 5_000,
    log = () => {},
} = {}) {
    const url = `${apiBase}/parcel-sources/${encodeURIComponent(sourceId)}?bbox=${bbox.join(',')}`;
    for (let attempt = 1; ; attempt += 1) {
        const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
        if (response.ok) return response.json();
        const retryable = response.status >= 500 && attempt === 1;
        if (!retryable) {
            throw new Error(`${url} returned HTTP ${response.status}${attempt > 1 ? ` (also on retry)` : ''}`);
        }
        log(`parcel source ${sourceId} returned HTTP ${response.status}; retrying once in ${retryDelayMs / 1000} s`);
        await delay(retryDelayMs);
    }
}
