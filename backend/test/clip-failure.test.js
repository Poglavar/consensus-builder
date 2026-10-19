// A polygon clip that fails is never swallowed: it is a typed ClipFailure that either refuses the
// work it was for or, where only a display degrades, is reported and counted in clipHealth().
//
// turf 6.5 clips with polygon-clipping 0.15, whose segment-state recursion throws "Maximum call
// stack size exceeded" on long chains (MultiPolygon unions of long corridor ribbons over one
// parcel). The arrangement used to drop a take whose intersection threw ("an unclippable take
// cannot reach this parcel"), which left the parcel cut by every other corridor and silently whole
// under that one. These tests stub the clipper to throw at exactly one call and assert what
// happens to that failure.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

let A;
beforeAll(() => {
    globalThis.turf = turf;
    A = require('../../frontend/js/proposals/parcel-arrangement.js');
});
afterEach(() => {
    globalThis.turf = turf;
    vi.restoreAllMocks();
});

const box = (w, s, e, n) => turf.polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
const PARCEL_ID = 'HR-1-100';
const PARCEL = box(16.0000, 46.0000, 16.0010, 46.0010);
PARCEL.properties = { parcelId: PARCEL_ID };
const EAST_WEST = { id: 'road-a', geometry: box(15.9990, 46.00045, 16.0020, 46.00055).geometry };
const NORTH_SOUTH = { id: 'road-b', geometry: box(16.00045, 45.9990, 16.00055, 46.0020).geometry };
const STACK = 'Maximum call stack size exceeded';

// turf with one operation replaced; `fails(callNumber, a, b)` decides which call throws.
function turfFailing(operation, fails) {
    let calls = 0;
    globalThis.turf = new Proxy(turf, {
        get(target, prop) {
            if (prop !== operation) return target[prop];
            return (a, b) => {
                calls += 1;
                if (fails(calls, a, b)) throw new RangeError(STACK);
                return target[prop](a, b);
            };
        }
    });
}

// North-south band is 16.00045–16.00055 wide; an operand reaching there is that take.
const touchesNorthSouth = feature => JSON.stringify(feature.geometry.coordinates).includes('16.00045');

describe('ClipFailure', () => {
    it('names the operation, the site, what it was for and the operands, and is counted', () => {
        turfFailing('intersect', () => true);
        const before = A.clipHealth();
        let thrown = null;
        try {
            A.clip('intersect', PARCEL, turf.feature(EAST_WEST.geometry), { site: 'test.site', parcelId: PARCEL_ID, takeId: 'road-a', proposalId: 'p-1' });
        } catch (error) { thrown = error; }

        expect(thrown).toBeInstanceOf(A.ClipFailure);
        expect(thrown.code).toBe('clip-failed');
        expect(thrown.operation).toBe('intersect');
        expect(thrown.site).toBe('test.site');
        expect(thrown.parcelId).toBe(PARCEL_ID);
        expect(thrown.takeId).toBe('road-a');
        expect(thrown.proposalId).toBe('p-1');
        expect(thrown.vertexCounts).toEqual([5, 5]);
        expect(thrown.originalMessage).toBe(STACK);
        expect(thrown.message).toMatch(/intersect failed at test\.site \(proposal p-1, parcel HR-1-100, take road-a\): Maximum call stack/);

        const after = A.clipHealth();
        expect(after.failed).toBe(before.failed + 1);
        expect(after.bySite['test.site']).toBe((before.bySite['test.site'] || 0) + 1);
        expect(after.recent.at(-1)).toMatchObject({ site: 'test.site', parcelId: PARCEL_ID, takeId: 'road-a', degraded: false });
    });

    it('a failure rethrown up the stack is recorded once and keeps its own site', () => {
        const inner = A.clipFailure('union', new Error(STACK), { site: 'inner.site' }, []);
        const before = A.clipHealth().failed;
        const outer = A.clipFailure('union', inner, { site: 'outer.site' }, []);
        expect(outer).toBe(inner);
        expect(outer.site).toBe('inner.site');
        expect(A.clipHealth().failed).toBe(before);
    });

    it('reportClipFailure logs a degraded display with its context, and stops logging a flooding site', () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => { });
        const before = A.clipHealth();
        for (let i = 0; i < 25; i += 1) {
            A.reportClipFailure('union', new Error(STACK), { site: 'test.flood', proposalId: `p-${i}` }, []);
        }
        const after = A.clipHealth();
        expect(after.degraded).toBe(before.degraded + 25);
        expect(after.bySite['test.flood']).toBe(25);
        // 20 failures, one "counted only from here" note, then silence.
        expect(log).toHaveBeenCalledTimes(21);
        expect(String(log.mock.calls[0][0])).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] \[clip\] Polygon union failed at test\.flood \(proposal p-0\)/);
        expect(log.mock.calls[0][1]).toMatchObject({ site: 'test.flood', proposalId: 'p-0' });
        expect(after.recent.at(-1)).toMatchObject({ site: 'test.flood', degraded: true });
    });
});

describe('a take whose intersection with the parcel throws', () => {
    it('is not dropped: takeHitsOn carries the failure for that take', () => {
        turfFailing('intersect', (_n, _a, b) => touchesNorthSouth(b));
        const hits = A.takeHitsOn(PARCEL, [EAST_WEST, NORTH_SOUTH]);
        expect(hits.map(entry => entry.take.id)).toEqual(['road-a', 'road-b']);
        const failed = hits.find(entry => entry.take.id === 'road-b');
        expect(failed.hit).toBeNull();
        expect(failed.failure).toBeInstanceOf(A.ClipFailure);
        expect(failed.failure).toMatchObject({ site: 'parcel-arrangement.takeHitsOn', parcelId: PARCEL_ID, takeId: 'road-b' });
    });

    it('refuses to arrange the parcel instead of cutting it by the other corridor only', () => {
        turfFailing('intersect', (_n, _a, b) => touchesNorthSouth(b));
        expect(() => A.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST, NORTH_SOUTH])).toThrow(A.ClipFailure);
        expect(() => A.takesOverlapping(PARCEL, [EAST_WEST, NORTH_SOUTH])).toThrow(/take road-b/);
    });

    it('fabricOver records the parcel as failed with the clip, site and take', () => {
        turfFailing('intersect', (_n, _a, b) => touchesNorthSouth(b));
        const { pieces, failed } = A.fabricOver([{ id: PARCEL_ID, feature: PARCEL }], [EAST_WEST, NORTH_SOUTH]);
        expect(pieces).toEqual([]);
        expect(failed).toEqual([expect.objectContaining({
            parcelId: PARCEL_ID,
            code: 'clip-failed',
            site: 'parcel-arrangement.takeHitsOn',
            takeId: 'road-b'
        })]);
        expect(failed[0].error).toMatch(/Maximum call stack/);
    });

    it('a precomputed hit list carrying a failure refuses the same way', () => {
        turfFailing('intersect', (_n, _a, b) => touchesNorthSouth(b));
        const hits = A.takeHitsOn(PARCEL, [EAST_WEST, NORTH_SOUTH]);
        globalThis.turf = turf;
        const { failed } = A.fabricOver([{ id: PARCEL_ID, feature: PARCEL }], [EAST_WEST, NORTH_SOUTH], new Map([[PARCEL_ID, hits]]));
        expect(failed).toHaveLength(1);
        expect(failed[0].takeId).toBe('road-b');
    });
});

describe('the road-piece takers check', () => {
    it('refuses instead of answering "not a taker" when its intersection throws', () => {
        // One take: intersect #1 is takeHitsOn's parcel × take; every later one is the takers check
        // (and its coarser-grid retries, which must all fail too).
        turfFailing('intersect', n => n >= 2);
        let thrown = null;
        try { A.arrangementOf(PARCEL, PARCEL_ID, [EAST_WEST]); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(A.ClipFailure);
        expect(thrown).toMatchObject({ site: 'parcel-arrangement.roadPieceTakers', parcelId: PARCEL_ID, takeId: 'road-a' });
    });
});

describe('the artifact-neck split', () => {
    const fixture = JSON.parse(readFileSync(
        fileURLToPath(new URL('./fixtures/parcel-575-artifact-neck.json', import.meta.url)), 'utf8'));
    const parcel = () => ({ type: 'Feature', properties: {}, geometry: fixture.parcel });
    const takes = () => fixture.takes.map(t => ({ id: t.id, geometry: t.polygon }));

    it('keeps the polygon whole when its clip throws, and reports it as degraded', () => {
        // The neck split clips the parcel against a buffered lobe; tag the buffers to find that call.
        globalThis.turf = new Proxy(turf, {
            get(target, prop) {
                if (prop === 'buffer') {
                    return (...args) => {
                        const out = target.buffer(...args);
                        if (out && args[1] > 0) out.properties = { ...(out.properties || {}), grownLobe: true };
                        return out;
                    };
                }
                if (prop === 'intersect') {
                    return (a, b) => {
                        if (b && b.properties && b.properties.grownLobe) throw new RangeError(STACK);
                        return target.intersect(a, b);
                    };
                }
                return target[prop];
            }
        });
        const log = vi.spyOn(console, 'error').mockImplementation(() => { });
        const before = A.clipHealth();

        const remainders = A.arrangementOf(parcel(), fixture.parcelId, takes()).pieces.filter(p => p.kind === 'remainder');

        expect(remainders).toHaveLength(1);
        const after = A.clipHealth();
        expect(after.bySite['parcel-arrangement.splitAtArtifactNeck']).toBe((before.bySite['parcel-arrangement.splitAtArtifactNeck'] || 0) + 1);
        expect(after.degraded).toBe(before.degraded + 1);
        expect(log).toHaveBeenCalled();
    });
});
