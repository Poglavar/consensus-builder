// Admission to one Overpass endpoint, shared by every OSM layer that reads it: how many requests it
// takes at once, in what order they go (roads, then buildings, then the rest), and how long it is
// left alone after it pushes back. The policy follows the provider's own signals, not fixed pauses:
//
//   - Tracestrack (our paid instance, the one we rely on) documents 429 "rate limit exceeded for
//     this key" and 403 "key missing, invalid, blocked, or referer mismatch", and no request rate,
//     concurrency cap, status endpoint or Retry-After header (tracestrack.com/docs, checked
//     2026-10-31). So a 429 halves how many requests we send at once (down to one) and starts a
//     backoff that doubles from 2 s to 60 s, or lasts what a Retry-After says if one ever comes; a
//     run of successes restores both. 401/402/403 will not fix themselves: the key is set aside.
//   - The public overpass-api.de is a last resort only. Its manual: limits are slots per IP, a
//     request waits up to 15 s for a slot and then gets 429, and a query over its time or memory
//     budget gets 504 after 15 s; the reference client tries again after 15 s.
//
// A slow answer or a network failure is not a throttle: that request fails and falls back, and the
// other layers keep their turn.

export const PRIORITY = Object.freeze({ roads: 0, buildings: 1, other: 2 });

const KINDS = Object.freeze({
    tracestrack: { concurrency: 4, backoffBaseMs: 2000, backoffMaxMs: 60000 },
    public: { concurrency: 2, backoffBaseMs: 15000, backoffMaxMs: 60000 },
    mirror: { concurrency: 2, backoffBaseMs: 15000, backoffMaxMs: 60000 }
});
// Successes in a row that give one request slot back after a 429 took it.
const RECOVERY_STREAK = 20;
// A key the provider refused stays set aside this long before it is tried again.
export const REFUSED_MS = 15 * 60 * 1000;
// Longest a request waits for a free slot before it is given up (our own fetch timeout).
export const MAX_QUEUE_WAIT_MS = 25000;

// Seconds or an HTTP date → milliseconds from now, or null.
export function retryAfterMs(value, now = Date.now()) {
    if (value == null || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(String(value));
    return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function createOverpassGate(kind = 'mirror', { now = () => Date.now(), maxWaitMs = MAX_QUEUE_WAIT_MS } = {}) {
    const policy = KINDS[kind] || KINDS.mirror;
    let limit = policy.concurrency;
    let active = 0;
    let blockedUntil = 0;
    let backoffMs = 0;
    let streak = 0;
    let sequence = 0;
    const waiting = [];

    function admitWaiting() {
        // Pushed back meanwhile: the waiting requests go to the next endpoint rather than wait it out.
        if (blockedUntil > now()) {
            for (const entry of waiting.splice(0)) {
                clearTimeout(entry.timer);
                entry.reject(Object.assign(new Error('Overpass endpoint is backing off'), { status: 503, retryAfter: Math.ceil((blockedUntil - now()) / 1000) }));
            }
            return;
        }
        waiting.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
        while (active < limit && waiting.length) {
            const next = waiting.shift();
            clearTimeout(next.timer);
            active += 1;
            next.resolve();
        }
    }

    // A slot for one request, in priority order. Rejects (status 503) when the endpoint is backing
    // off or refused, or no slot came free within maxWaitMs; the caller then tries the next endpoint.
    function acquire(priority = PRIORITY.other) {
        if (blockedUntil > now()) {
            return Promise.reject(Object.assign(new Error('Overpass endpoint is backing off'), { status: 503, retryAfter: Math.ceil((blockedUntil - now()) / 1000) }));
        }
        if (active < limit && !waiting.length) { active += 1; return Promise.resolve(); }
        return new Promise((resolve, reject) => {
            const entry = { priority, sequence: sequence++, resolve, reject };
            entry.timer = setTimeout(() => {
                const index = waiting.indexOf(entry);
                if (index >= 0) waiting.splice(index, 1);
                reject(Object.assign(new Error('No Overpass slot came free in time'), { status: 503 }));
            }, maxWaitMs);
            waiting.push(entry);
            admitWaiting();
        });
    }

    // The outcome of a request that held a slot: 'ok', 'throttled' (429, or the public server's
    // 504), 'refused' (401/402/403) or 'failed' (timeout, network, other errors).
    function release(outcome, { retryAfter = null } = {}) {
        active = Math.max(0, active - 1);
        if (outcome === 'ok') {
            backoffMs = 0;
            streak += 1;
            if (streak >= RECOVERY_STREAK && limit < policy.concurrency) { limit += 1; streak = 0; }
        } else if (outcome === 'throttled') {
            streak = 0;
            limit = Math.max(1, Math.floor(limit / 2));
            backoffMs = backoffMs ? Math.min(policy.backoffMaxMs, backoffMs * 2) : policy.backoffBaseMs;
            const wait = retryAfterMs(retryAfter, now());
            blockedUntil = Math.max(blockedUntil, now() + (wait ?? backoffMs));
        } else if (outcome === 'refused') {
            streak = 0;
            blockedUntil = now() + REFUSED_MS;
        }
        admitWaiting();
    }

    function state() {
        return { limit, active, waiting: waiting.length, blockedUntil, backoffMs };
    }

    return { acquire, release, state, blockedUntil: () => blockedUntil };
}
