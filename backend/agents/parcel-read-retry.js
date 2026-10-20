// Bounded retries for read-only parcel queries; never wrap mint, publication, staking, or database writes.
import { setTimeout as delay } from 'node:timers/promises';
import { safeFailureDiagnostic } from './run-failure.js';

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const NO_RETRY_CODES = new Set(['parcel-source-blocked', 'parcel-source-rate-limited']);

function retryable(error, retryNetworkErrors) {
    if (NO_RETRY_CODES.has(error?.code) || (error?.status >= 400 && error.status < 500)
        || (error?.upstreamStatus >= 400 && error.upstreamStatus < 500)) return false;
    if (error?.code === 'parcel-source-unavailable') return true;
    if (error?.code === 'agent-parcel-http') return error.status >= 500 && error.status <= 599;
    return retryNetworkErrors && (error?.name === 'TimeoutError' || NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.cause?.code));
}

function readBeforeDeadline(read, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => read(signal)).then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

export async function retryParcelRead(read, {
    sourceId, retryDelaysMs = [5_000, 15_000], maxElapsedMs = 180_000,
    sleep = delay, log = () => {}, retryNetworkErrors = false
} = {}) {
    if (typeof read !== 'function' || !Array.isArray(retryDelaysMs) || retryDelaysMs.some(ms => !Number.isFinite(ms) || ms < 0)
        || !Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0) throw new TypeError('Invalid parcel read retry policy');
    const controller = new AbortController();
    const deadline = Object.assign(new Error('parcel read deadline exceeded'), { code: 'parcel-read-deadline' });
    const timer = setTimeout(() => controller.abort(deadline), maxElapsedMs);
    const started = Date.now();
    const maxAttempts = retryDelaysMs.length + 1;
    let attempt = 0;
    const failure = error => {
        const message = `Parcel source ${sourceId}, attempt ${attempt}/${maxAttempts}: ${safeFailureDiagnostic(error)}`;
        log(`FAIL ${message}`);
        return Object.assign(new Error(message, { cause: error }), {
            sourceId, attempts: attempt, code: error?.code, status: error?.status,
            upstreamStatus: error?.upstreamStatus, retryAfterSeconds: error?.retryAfterSeconds, parcelCounts: error?.parcelCounts
        });
    };
    try {
        for (;;) {
            attempt++;
            try {
                const value = await readBeforeDeadline(read, controller.signal);
                if (attempt > 1) log(`OK parcel source ${sourceId}: recovered on attempt ${attempt}/${maxAttempts}`);
                return value;
            } catch (caught) {
                const error = controller.signal.aborted ? deadline : caught;
                const cooldown = Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds * 1000 : 0;
                const wait = Math.max(retryDelaysMs[attempt - 1] ?? 0, cooldown);
                if (controller.signal.aborted || attempt >= maxAttempts || !retryable(error, retryNetworkErrors)
                    || Date.now() - started + wait >= maxElapsedMs) throw failure(error);
                log(`WARN parcel source ${sourceId}, attempt ${attempt}/${maxAttempts}: ${safeFailureDiagnostic(error)}; retrying in ${wait} ms`);
                try { await sleep(wait, undefined, { signal: controller.signal }); }
                catch (error) { throw failure(controller.signal.aborted ? deadline : error); }
            }
        }
    } finally { clearTimeout(timer); }
}
