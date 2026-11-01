// Admission to an Overpass endpoint (backend/buildings/overpass-gate.js): priority order, the
// concurrency a provider's 429s allow, backoff from its own signals, and failures that block nothing.
import { describe, expect, it } from 'vitest';
import { createOverpassGate, PRIORITY, retryAfterMs, REFUSED_MS } from '../buildings/overpass-gate.js';

function clock() { let t = 1000; return { now: () => t, advance: ms => { t += ms; } }; }

describe('Overpass gate', () => {
    it('lets roads go first, then buildings, then the rest, once a slot frees', async () => {
        const c = clock();
        const gate = createOverpassGate('tracestrack', { now: c.now });
        for (let i = 0; i < 4; i++) await gate.acquire(PRIORITY.other); // Tracestrack starts at four at once
        const order = [];
        const queued = [
            gate.acquire(PRIORITY.other).then(() => order.push('trees')),
            gate.acquire(PRIORITY.buildings).then(() => order.push('buildings')),
            gate.acquire(PRIORITY.roads).then(() => order.push('roads'))
        ];
        expect(gate.state().waiting).toBe(3);
        for (let i = 0; i < 3; i++) gate.release('ok');
        await Promise.all(queued);
        expect(order).toEqual(['roads', 'buildings', 'trees']);
    });

    it('a 429 halves the requests at once and backs off, doubling from 2 s; success resets the backoff', async () => {
        const c = clock();
        const gate = createOverpassGate('tracestrack', { now: c.now });
        await gate.acquire(); gate.release('throttled');
        expect(gate.state()).toMatchObject({ limit: 2, backoffMs: 2000, blockedUntil: 3000 });
        await expect(gate.acquire()).rejects.toMatchObject({ status: 503, retryAfter: 2 });
        c.advance(2000);
        await gate.acquire(); gate.release('throttled');
        expect(gate.state()).toMatchObject({ limit: 1, backoffMs: 4000 });
        c.advance(4000);
        await gate.acquire(); gate.release('ok');
        expect(gate.state().backoffMs).toBe(0);
    });

    it('waits as long as a Retry-After says, when the provider sends one', async () => {
        const c = clock();
        const gate = createOverpassGate('tracestrack', { now: c.now });
        await gate.acquire(); gate.release('throttled', { retryAfter: '7' });
        expect(gate.state().blockedUntil).toBe(8000);
        expect(retryAfterMs(new Date(c.now() + 5000).toUTCString(), c.now())).toBeGreaterThan(3000);
        expect(retryAfterMs('soon')).toBeNull();
    });

    it('gives a slot back after a run of successes', async () => {
        const c = clock();
        const gate = createOverpassGate('tracestrack', { now: c.now });
        await gate.acquire(); gate.release('throttled');
        c.advance(2000);
        expect(gate.state().limit).toBe(2);
        for (let i = 0; i < 20; i++) { await gate.acquire(); gate.release('ok'); }
        expect(gate.state().limit).toBe(3);
    });

    it('sets a refused key aside, and a failed request blocks nothing', async () => {
        const c = clock();
        const gate = createOverpassGate('tracestrack', { now: c.now });
        await gate.acquire(); gate.release('failed');
        expect(gate.state()).toMatchObject({ limit: 4, blockedUntil: 0 });
        await gate.acquire(); gate.release('refused');
        expect(gate.state().blockedUntil).toBe(c.now() + REFUSED_MS);
    });

    it('sends the waiting requests elsewhere when the endpoint pushes back, rather than through the backoff', async () => {
        const c = clock();
        const gate = createOverpassGate('public', { now: c.now });
        await gate.acquire(); await gate.acquire(); // the public server's two slots
        const waiting = gate.acquire(PRIORITY.roads);
        gate.release('throttled');
        await expect(waiting).rejects.toMatchObject({ status: 503 });
        expect(gate.state().backoffMs).toBe(15000); // its manual: try again after 15 s
    });

    it('gives up a request that found no free slot in time', async () => {
        const gate = createOverpassGate('public', { maxWaitMs: 10 });
        await gate.acquire(); await gate.acquire();
        await expect(gate.acquire()).rejects.toMatchObject({ status: 503 });
    });
});
