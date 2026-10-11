// Browser-safe shared query controls for parcel source adapters.
const COOLDOWN_CODES = new Set(['parcel-source-blocked', 'parcel-source-rate-limited', 'parcel-source-unavailable']);
const wrappedMethods = (adapter, invoke) => Object.freeze({
    queryBounds: invoke('queryBounds'), queryIds: invoke('queryIds'), queryGeometry: invoke('queryGeometry'),
    ...(typeof adapter.queryPoint === 'function' ? { queryPoint: invoke('queryPoint') } : {})
});

export function withSourceCooldown(adapter, { now = Date.now } = {}) {
    let failure = null, until = 0;
    const invoke = method => async (...args) => {
        if (failure && now() < until) throw Object.assign(new Error(failure.message), failure,
            { retryAfterSeconds: Math.ceil((until - now()) / 1000) });
        const previousFailure = failure;
        try {
            const result = await adapter[method](...args);
            if (failure === previousFailure) { failure = null; until = 0; }
            return result;
        } catch (error) {
            if (COOLDOWN_CODES.has(error.code)) {
                failure = error;
                until = now() + Math.max(1, Math.min(3600, error.retryAfterSeconds || (error.code === 'parcel-source-blocked' ? 60 : 30))) * 1000;
                error.retryAfterSeconds = Math.ceil((until - now()) / 1000);
            }
            throw error;
        }
    };
    return wrappedMethods(adapter, invoke);
}

// One FIFO budget is shared by all query methods for this provider.
export function withSourceConcurrency(adapter, { limit = 2 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) {
        throw new TypeError('Parcel source concurrency limit must be an integer from 1 to 16.');
    }
    let active = 0;
    const waiting = [];
    const makeRelease = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = waiting.shift();
            if (next) next(makeRelease());
            else active--;
        };
    };
    const acquire = () => {
        if (active < limit) {
            active++;
            return Promise.resolve(makeRelease());
        }
        return new Promise(resolve => waiting.push(resolve));
    };
    const invoke = method => async (...args) => {
        const release = await acquire();
        try { return await adapter[method](...args); }
        finally { release(); }
    };
    return wrappedMethods(adapter, invoke);
}

export function withSourceControls(adapter, { maxConcurrentQueries, now = Date.now } = {}) {
    const cooled = withSourceCooldown(adapter, { now });
    return maxConcurrentQueries === undefined ? cooled
        : withSourceConcurrency(cooled, { limit: maxConcurrentQueries });
}
