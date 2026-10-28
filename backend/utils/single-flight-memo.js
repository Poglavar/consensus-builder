// A small in-memory memo for public responses that are identical for every caller (the activity
// feeds every world-view visitor polls). Concurrent callers of one key share ONE in-flight promise,
// the settled value is served for `ttlMs` after it settles, and at most `maxKeys` keys are held (the
// oldest dropped first). A rejection is never kept: the next caller after a failure asks again.
// Pure: no I/O; the clock is injectable so expiry is testable without waiting.

export function createSingleFlightMemo({ ttlMs, maxKeys = 50, now = Date.now } = {}) {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error('createSingleFlightMemo: ttlMs must be a positive number of milliseconds.');
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
        throw new Error('createSingleFlightMemo: maxKeys must be a positive integer.');
    }
    // key -> { promise, expiresAt }; expiresAt is null while the load is in flight.
    const entries = new Map();

    function get(key, load) {
        const held = entries.get(key);
        if (held && (held.expiresAt === null || now() < held.expiresAt)) return held.promise;
        // Re-inserted rather than updated, so Map order stays oldest-first for the bound below.
        if (held) entries.delete(key);
        const entry = { promise: null, expiresAt: null };
        entry.promise = Promise.resolve()
            .then(load)
            .then(value => {
                if (entries.get(key) === entry) entry.expiresAt = now() + ttlMs;
                return value;
            }, error => {
                if (entries.get(key) === entry) entries.delete(key);
                throw error;
            });
        entries.set(key, entry);
        // An evicted in-flight entry still answers the callers already holding its promise.
        while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
        return entry.promise;
    }

    return { get, size: () => entries.size, clear: () => entries.clear() };
}
