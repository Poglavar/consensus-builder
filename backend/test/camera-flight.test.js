// Behavioral coverage for bounded flight records, metric curves, speed-derived timing and
// orientation keys owned by route points (holds, turns, looks between views, cues at views).
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const Flight = require('../../frontend/js/camera-flight.js');
const view = { at: '52,-1,18', mode: 'model', city: 'test-city', language: 'en',
    settings: { existing: 'ghost', xray: '0', suggested: '0', suggestedExisting: '0', cutaway: 'all' } };
const frame = { lat: 52, lng: -1, datum: 'model-ground' };
const yaw = degrees => [0, 0, Math.sin(degrees * Math.PI / 360), Math.cos(degrees * Math.PI / 360)];
const copy = x => JSON.parse(JSON.stringify(x));
const point = (position, index, travelSeconds = 10, holdSeconds = 0) => ({ id: `route-${index}`,
    position, quaternion: [0, 0, 0, 1], travelSeconds: index ? travelSeconds : null, holdSeconds, turn: null });
function flight(positions = [[0, 0, 2], [10, 0, 2]], travelSeconds = 10) {
    const record = Flight.create({ view, frame, pose: { position: positions[0], quaternion: [0, 0, 0, 1], fov: 45 } });
    record.route = positions.map((p, i) => point(p, i, travelSeconds));
    return record;
}
const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const close = (a, b, precision = 8) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], precision));
const sameOrientation = (a, b) => Math.abs(a.reduce((sum, x, i) => sum + x * b[i], 0));

describe('camera-flight records', () => {
    it('matches canonical metric anchors and rejects route nodes beyond the 60 km frame radius', () => {
        for (const framePatch of [{ lat: 52.1234567 }, { lng: -1.1234567 }, { lat: 85.01 }, { lng: 180 }]) {
            const r = flight(); Object.assign(r.frame, framePatch); expect(Flight.validate(r)).toMatch(/metric frame/);
        }
        const r = flight([[0, 0, 2], [36000, 48000, 2]]);
        expect(Flight.validate(r)).toBeNull(); expect(Flight.compile(r).evaluate(10).position).toEqual([36000, 48000, 2]);
        r.route[1].position[0] += 0.001; expect(Flight.validate(r)).toMatch(/route/);
    });
    it('creates an isolated normalized zero-duration draft whose first view owns its orientation', () => {
        const source = copy(view), sourceFrame = copy(frame), position = [1, 2, 3];
        const draft = Flight.create({ title: ' New flight ', view: source, frame: sourceFrame,
            pose: { position, quaternion: [0, 0, 0, 2] } });
        expect(draft.schema).toBe(Flight.SCHEMA);
        expect(draft.title).toBe('New flight');
        expect(draft.fov).toBe(45); expect(draft.speedMps).toBe(15);
        expect(Flight.validate(draft, { draft: true })).toBeNull();
        expect(Flight.validate(draft)).toMatch(/last/);
        source.settings.xray = '1'; sourceFrame.lat = 0; position[0] = 99;
        expect(draft.view.settings.xray).toBe('0'); expect(draft.frame.lat).toBe(52);
        expect(draft.route[0]).toEqual({ id: 'route-1', position: [1, 2, 3], quaternion: [0, 0, 0, 1], travelSeconds: null, holdSeconds: 0, turn: null });
        expect(draft.looks).toEqual([]); expect(draft.cues).toEqual([]);
    });

    it('sorts and deduplicates published design identities while allowing city-only flights', () => {
        const a = `bafkrei${'a'.repeat(52)}`, b = `bafybei${'b'.repeat(52)}`;
        const record = Flight.create({ designCids: [b, a, b], view, frame,
            pose: { position: [0, 0, 0], quaternion: yaw(0) } });
        expect(record.designCids).toEqual([a, b]);
        expect(Flight.validate(flight())).toBeNull();
        record.route[0].holdSeconds = 1; record.designCids = [b, a];
        expect(Flight.validate(record)).toMatch(/designs/);
    });

    it.each([
        ['null record', () => null], ['unknown top-level field', r => ({ ...r, backend: 'https://example.test' })],
        ['old schema', r => ({ ...r, schema: 'camera-flight/v1' })],
        ['blank title', r => ({ ...r, title: ' ' })], ['bad CID', r => ({ ...r, designCids: ['invalid'] })],
        ['non-model view', r => ({ ...r, view: { ...r.view, mode: 'photo' } })],
        ['empty coordinate', r => ({ ...r, view: { ...r.view, at: ',0,18' } })],
        ['out of range coordinate', r => ({ ...r, view: { ...r.view, at: '90,0,18' } })],
        ['unknown view field', r => ({ ...r, view: { ...r.view, backend: 'x' } })],
        ['unknown language', r => ({ ...r, view: { ...r.view, language: 'unknown' } })],
        ['null settings', r => ({ ...r, view: { ...r.view, settings: null } })],
        ['numeric setting', r => ({ ...r, view: { ...r.view, settings: { xray: 1 } } })],
        ['malformed cutaway', r => ({ ...r, view: { ...r.view, settings: { cutaway: '1.5' } } })],
        ['bad anchor', r => ({ ...r, frame: { ...r.frame, lat: null } })],
        ['wrong datum', r => ({ ...r, frame: { ...r.frame, datum: 'sea-level' } })],
        ['unknown anchor field', r => ({ ...r, frame: { ...r.frame, elevation: 0 } })],
        ['NaN FOV', r => ({ ...r, fov: NaN })], ['null FOV', r => ({ ...r, fov: null })],
        ['narrow FOV', r => ({ ...r, fov: 19 })], ['wide FOV', r => ({ ...r, fov: 101 })],
        ['zero speed', r => ({ ...r, speedMps: 0 })], ['string speed', r => ({ ...r, speedMps: '15' })],
        ['excessive speed', r => ({ ...r, speedMps: 201 })],
        ['incomplete orbit pose', r => ({ ...r, view: { ...r.view, camera: { range: 10 } } })],
        ['non-finite orbit pose', r => ({ ...r, view: { ...r.view, camera: { targetLat: 52,
            targetLng: -1, headingDeg: NaN, pitchRad: -0.5, range: 10 } } })],
    ])('rejects %s', (_label, change) => expect(Flight.validate(change(flight()))).toBeTypeOf('string'));

    it('validates route IDs, finite metric positions, unit orientations, timing and turns', () => {
        for (const mutate of [
            r => { r.route[1].id = r.route[0].id; }, r => { r.route[1].position[0] = NaN; },
            r => { r.route[1].position[2] = null; }, r => { r.route[0].travelSeconds = 1; },
            r => { r.route[1].travelSeconds = 0; }, r => { delete r.route[1].travelSeconds; },
            r => { r.route[1].holdSeconds = -1; }, r => { r.route[1].holdSeconds = Infinity; },
            r => { r.route[0].extra = 1; }, r => { r.route[1].travelSeconds = 601; },
            r => { r.route[1].quaternion = [0, 0, 0, 2]; }, r => { delete r.route[1].quaternion; },
            r => { r.route[1].turn = { axis: 'yaw', turns: 1 }; },
            r => { r.route[1].holdSeconds = 2; r.route[1].turn = { axis: 'spin', turns: 1 }; },
            r => { r.route[1].holdSeconds = 2; r.route[1].turn = { axis: 'yaw', turns: 0 }; },
            r => { r.route[1].holdSeconds = 2; r.route[1].turn = { axis: 'yaw', turns: 17 }; },
            r => { r.route[1].holdSeconds = 2; r.route[1].turn = { axis: 'yaw', turns: 1.5 }; },
            r => { r.route[1].holdSeconds = 2; r.route[1].turn = { axis: 'yaw' }; },
            r => { r.route = Array.from({ length: 257 }, (_, i) => point([i, 0, 0], i, 1)); },
        ]) { const r = flight(); mutate(r); expect(Flight.validate(r)).toBeTypeOf('string'); }
        const r = flight(); r.route[1].holdSeconds = 2; r.route[1].turn = { axis: 'roll', turns: -3 };
        expect(Flight.validate(r)).toBeNull();
    });

    it('requires looks anchored strictly inside a segment and one cue per view', () => {
        const look = (after, fraction) => ({ id: 'look', after, fraction, quaternion: yaw(90) });
        for (const mutate of [r => { r.looks = [look('missing', .5)]; }, r => { r.looks = [look('route-1', .5)]; },
            r => { r.looks = [look('route-0', 0)]; }, r => { r.looks = [look('route-0', 1)]; },
            r => { r.looks = [{ ...look('route-0', .5), quaternion: [0, 0, 0, 2] }]; },
            r => { r.looks = [look('route-0', .5), { ...look('route-0', .5), id: 'other' }]; },
            r => { r.looks = [{ ...look('route-0', .5), time: 1 }]; },
            r => { r.cues = [{ id: 'cue', at: 'missing', settings: { xray: '1' } }]; },
            r => { r.cues = [{ id: 'cue', at: 'route-1', settings: { existing: 'solid' } }]; },
            r => { r.cues = [{ id: 'cue', at: 'route-1', settings: {} }]; },
            r => { r.cues = [{ id: 'cue', time: 1, settings: { xray: '1' } }]; },
            r => { r.cues = [{ id: 'a', at: 'route-1', settings: { xray: '1' } }, { id: 'b', at: 'route-1', settings: { xray: '0' } }]; },
        ]) { const r = flight(); mutate(r); expect(Flight.validate(r)).toBeTypeOf('string'); }
        const r = flight(); r.looks = [look('route-0', .25), { ...look('route-0', .75), id: 'later' }];
        r.cues = [{ id: 'a', at: 'route-0', settings: { xray: '1' } }, { id: 'b', at: 'route-1', settings: { xray: '0' } }];
        expect(Flight.validate(r)).toBeNull();
    });

    it('rejects sparse arrays, count overruns and duplicate anchors without throwing', () => {
        for (const name of ['route', 'looks', 'interiors', 'cues', 'designCids']) {
            const r = flight(); r[name] = new Array(1);
            expect(Flight.validate(r)).toBeTypeOf('string');
        }
        for (const field of ['position', 'quaternion']) {
            const r = flight(); r.route[0][field] = new Array(field === 'position' ? 3 : 4);
            expect(Flight.validate(r)).toBeTypeOf('string');
        }
        for (const name of ['looks', 'interiors', 'cues']) {
            const r = flight(); r[name] = Array.from({ length: Flight.LIMITS[name] + 1 }, (_, i) => ({ id: `id-${i}` }));
            expect(Flight.validate(r)).toBeTypeOf('string');
        }
        const r = flight(); r.route[1].travelSeconds = 600;
        expect(Flight.validate(r)).toBeNull();
        r.route[1].holdSeconds = 1; expect(Flight.validate(r)).toMatch(/600/);
    });

    it('checks bounded finite interior feature snapshots without interpreting their floor model', () => {
        const r = flight();
        r.interiors = [{ id: 'interior', buildingId: 'building', revision: 'revision', feature: {
            type: 'Feature', properties: { floorPlans: { schema: 'floor-plan/v1' } },
            geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } } }];
        expect(Flight.validate(r)).toBeNull();
        for (const mutate of [s => { s.feature.properties.floorPlans = null; },
            s => { s.feature.geometry.coordinates[0][1][0] = NaN; },
            s => { s.feature.geometry.coordinates[0][3] = [0.5, 0.5]; },
            s => { s.feature.properties.loop = s.feature; }, s => { s.extra = true; },
        ]) { const changed = copy(r); mutate(changed.interiors[0]); expect(Flight.validate(changed)).toBeTypeOf('string'); }
    });
});

describe('speed-derived timing', () => {
    it('derives travel from arc length over cruise speed unless a point overrides it', () => {
        // Both segments of a three-view route curve, so each arc is a little longer than its chord.
        const r = flight([[0, 0, 0], [30, 0, 0], [30, 40, 0]], null); r.speedMps = 10;
        const travel = Flight.timeline(r).travel;
        expect(travel[0]).toBe(0); expect(travel[1]).toBeGreaterThan(3); expect(travel[1]).toBeLessThan(3.3);
        expect(travel[2]).toBeGreaterThan(4); expect(travel[2]).toBeLessThan(4.4);
        expect(Flight.arrivals(r)).toEqual([0, travel[1], travel[1] + travel[2]]);
        r.route[1].travelSeconds = 1; expect(Flight.arrivals(r)[1]).toBe(1); expect(Flight.timeline(r).travel[2]).toBe(travel[2]);
        r.route[1].travelSeconds = null; r.speedMps = 20;
        expect(Flight.timeline(r).travel[1]).toBeCloseTo(travel[1] / 2, 10); expect(Flight.timeline(r).travel[2]).toBeCloseTo(travel[2] / 2, 10);
    });

    it('keeps coincident views apart by the minimum travel time and reports an over-long flight', () => {
        const r = flight([[0, 0, 1], [0, 0, 1]], null);
        expect(Flight.timeline(r).travel).toEqual([0, Flight.LIMITS.minTravelSeconds]);
        const slow = flight([[0, 0, 0], [50000, 0, 0]], null); slow.speedMps = 1;
        expect(Flight.validate(slow)).toMatch(/600/);
        slow.speedMps = 100; expect(Flight.validate(slow)).toBeNull();
    });
});

describe('camera-flight evaluation', () => {
    it('rejects a curved excursion beyond the metric domain even when every authored node is inside', () => {
        const r = flight([[0, 0, 0], [59900, -500, 0], [59900, 500, 0], [0, 1000, 0]]);
        expect(Flight.validate(r)).toMatch(/60 km metric frame/); expect(() => Flight.compile(r)).toThrow(/60 km metric frame/);
    });
    it('includes departure holds, travel and final holds in exact arrivals and duration', () => {
        const r = flight([[0, 0, 0], [10, 0, 0], [20, 0, 0]]);
        r.route[0].holdSeconds = 2; r.route[1].holdSeconds = 3; r.route[2].holdSeconds = 4;
        expect(Flight.arrivals(r)).toEqual([0, 12, 25]); expect(Flight.duration(r)).toBe(29);
        const c = Flight.compile(r);
        expect(c.duration).toBe(29);
        for (const t of [0, 1, 2]) close(c.evaluate(t).position, [0, 0, 0]);
        for (const t of [12, 13, 15]) close(c.evaluate(t).position, [10, 0, 0]);
        for (const t of [25, 28, 29]) close(c.evaluate(t).position, [20, 0, 0]);
    });

    it('samples a two-point segment linearly without easing or stopping during travel', () => {
        const c = Flight.compile(flight([[0, 0, 2], [10, 20, 12]]));
        close(c.evaluate(2.5).position, [2.5, 5, 4.5]);
        close(c.evaluate(5).position, [5, 10, 7]); close(c.evaluate(10).position, [10, 20, 12]);
    });

    it('curves through authored nodes with matching direction across an intermediate node', () => {
        const c = Flight.compile(flight([[0, 0, 0], [10, 0, 0], [10, 10, 0], [20, 10, 0]]));
        close(c.evaluate(0).position, [0, 0, 0]); close(c.evaluate(10).position, [10, 0, 0]);
        close(c.evaluate(20).position, [10, 10, 0]); close(c.evaluate(30).position, [20, 10, 0]);
        expect(c.evaluate(5).position[1]).toBeLessThan(-0.1);
        const a = c.evaluate(9.999).position, b = c.evaluate(10.001).position;
        const incoming = [10 - a[0], -a[1], -a[2]], outgoing = [b[0] - 10, b[1], b[2]];
        expect(incoming.reduce((sum, x, i) => sum + x * outgoing[i], 0) / dist(incoming, [0, 0, 0]) / dist(outgoing, [0, 0, 0])).toBeGreaterThan(0.999);
    });

    it('uses arc distance to avoid a speed surge inside an uneven curved segment', () => {
        const c = Flight.compile(flight([[0, 0, 0], [1, 0, 0], [4, 12, 8], [40, 13, 9]]));
        const lengths = Array.from({ length: 80 }, (_, i) => dist(c.evaluate(10 + i / 8).position, c.evaluate(10 + (i + 1) / 8).position));
        expect(Math.max(...lengths) / Math.min(...lengths)).toBeLessThan(1.02);
    });

    it('keeps duplicate/stationary segments finite and turns in place during a hold', () => {
        const r = flight([[0, 0, 1], [0, 0, 1], [10, 0, 1], [10, 0, 1], [10, 10, 1]]);
        r.route[0].holdSeconds = 10; r.route[0].turn = { axis: 'yaw', turns: 1 };
        const c = Flight.compile(r);
        for (const t of [0, 2.5, 5, 7.5, 10]) close(c.evaluate(t).position, [0, 0, 1]);
        close(c.evaluate(2.5).quaternion, yaw(90));
        for (let t = 0; t <= 50; t += 0.25) expect(c.evaluate(t).position.every(Number.isFinite)).toBe(true);
        close(c.evaluate(35).position, [10, 0, 1]);
    });

    it('plays complete and multiple turns with constant angular speed and ends where it started', () => {
        const r = flight(); r.route[0].holdSeconds = 8; r.route[0].turn = { axis: 'yaw', turns: 1 };
        const c = Flight.compile(r);
        for (let t = 0; t <= 8; t += 0.125) {
            expect(sameOrientation(c.evaluate(t).quaternion, yaw(t * 45))).toBeCloseTo(1, 8);
            close(c.evaluate(t).position, [0, 0, 2]);
        }
        r.route[0].turn = { axis: 'yaw', turns: -2 };
        const twice = Flight.compile(r);
        expect(sameOrientation(twice.evaluate(1).quaternion, yaw(-90))).toBeCloseTo(1, 8);
        expect(sameOrientation(twice.evaluate(8).quaternion, yaw(0))).toBeCloseTo(1, 8);
        const kinds = Flight.timeline(r).looks.map(key => key.kind);
        expect(kinds.filter(kind => kind === 'turn')).toHaveLength(16); expect(kinds[0]).toBe('view');
    });

    it('applies yaw around world Z and pitch/roll around camera-local axes', () => {
        const base = flight([[0, 0, 2]]); base.route[0].holdSeconds = 4; base.route[0].quaternion = yaw(90);
        const pitch = copy(base); pitch.route[0].turn = { axis: 'pitch', turns: 1 };
        Flight.compile(pitch).evaluate(1).quaternion.forEach(x => expect(Math.abs(x)).toBeCloseTo(0.5, 10));
        const roll = copy(base); roll.route[0].turn = { axis: 'roll', turns: 1 };
        expect(sameOrientation(Flight.compile(roll).evaluate(1).quaternion, [0, 0, 0, 1])).toBeCloseTo(1, 10);
        const tilted = copy(base); tilted.route[0].quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; tilted.route[0].turn = { axis: 'yaw', turns: 1 };
        Flight.compile(tilted).evaluate(1).quaternion.forEach(x => expect(Math.abs(x)).toBeCloseTo(0.5, 10));
    });

    it('holds a view still between arrival and departure, then turns toward the next view', () => {
        const r = flight([[0, 0, 0], [10, 0, 0]]); r.route[0].holdSeconds = 4; r.route[1].quaternion = yaw(90);
        const c = Flight.compile(r);
        for (const t of [0, 2, 4]) close(c.evaluate(t).quaternion, yaw(0));
        expect(sameOrientation(c.evaluate(9).quaternion, yaw(45))).toBeCloseTo(1, 8);
        close(c.evaluate(14).quaternion, yaw(90));
    });

    it('keeps position independent of looks between views and interpolates pitch/roll across poles', () => {
        const r = flight([[0, 0, 0], [3, 4, 5], [10, 1, 8]]), plain = Flight.compile(r);
        r.looks = [{ id: 'a', after: 'route-0', fraction: .5, quaternion: [0.5, 0.5, 0.5, 0.5] },
            { id: 'b', after: 'route-1', fraction: .5, quaternion: [0, 1, 0, 0] }];
        const changed = Flight.compile(r), times = Flight.timeline(r);
        expect(times.looks.filter(key => key.kind === 'look').map(key => key.time)).toEqual([5, 15]);
        for (const t of [0, 3, 5, 8, 12, 15, 19, 20]) {
            close(changed.evaluate(t).position, plain.evaluate(t).position);
            expect(Math.hypot(...changed.evaluate(t).quaternion)).toBeCloseTo(1, 10);
        }
        close(changed.evaluate(5).quaternion, [0.5, 0.5, 0.5, 0.5]); close(changed.evaluate(15).quaternion, [0, 1, 0, 0]);
        close(changed.evaluate(20).quaternion, [0, 0, 0, 1]);
    });

    it('applies view cues on arrival at their view, including explicit off and negative floor cutaway', () => {
        const r = flight([[0, 0, 0], [10, 0, 0], [20, 0, 0]]);
        r.cues = [{ id: 'b', at: 'route-2', settings: { xray: '0', cutaway: 'all' } },
            { id: 'a', at: 'route-1', settings: { xray: '1', suggested: '1', cutaway: '-1' } }];
        const c = Flight.compile(r);
        expect(c.evaluate(9.9).settings).toEqual(view.settings);
        expect(c.evaluate(10).settings).toMatchObject({ existing: 'ghost', xray: '1', suggested: '1', cutaway: '-1' });
        expect(c.evaluate(20).settings).toMatchObject({ xray: '0', suggested: '1', cutaway: 'all' });
    });

    it('seeks deterministically in any order, clamps endpoints and isolates compiled state', () => {
        const r = flight([[0, 0, 0], [3, 4, 5], [10, 1, 8]]), c = Flight.compile(r);
        const pose = c.evaluate(13.125);
        c.evaluate(20); c.evaluate(0); expect(c.evaluate(13.125)).toEqual(pose);
        expect(c.evaluate(-100)).toEqual(c.evaluate(0)); expect(c.evaluate(100)).toEqual(c.evaluate(20));
        r.route[1].position[0] = 500; expect(c.evaluate(13.125)).toEqual(pose);
        const result = c.evaluate(13.125); result.position[0] = 100; result.settings.xray = '1';
        expect(c.evaluate(13.125)).toEqual(pose);
        for (const t of [NaN, Infinity, null, '1']) expect(() => c.evaluate(t)).toThrow(/playhead/);
    });

    it('supports a stationary published hold and rejects an invalid frame at compile time', () => {
        const r = flight([[1, 2, 3]]); r.route[0].holdSeconds = 5;
        expect(Flight.validate(r)).toBeNull(); close(Flight.compile(r).evaluate(3).position, [1, 2, 3]);
        close(Flight.compile(r).evaluate(3).quaternion, [0, 0, 0, 1]);
        r.frame.datum = 'invalid'; expect(() => Flight.compile(r)).toThrow(/frame/);
    });

    it('uses shortest quaternion intervals including antipodal representations', () => {
        close(Flight.slerp(yaw(10), yaw(350), 0.5), yaw(0));
        const q = [0.5, 0.5, 0.5, 0.5]; close(Flight.slerp(q, q.map(x => -x), 0.5), q);
    });
});
