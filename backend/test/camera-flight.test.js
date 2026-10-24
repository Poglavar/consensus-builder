// Behavioral coverage for bounded flight records, metric curves and independent absolute-time looks.
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
    position, travelSeconds: index ? travelSeconds : 0, holdSeconds });
function flight(positions = [[0, 0, 2], [10, 0, 2]]) {
    const record = Flight.create({ view, frame, pose: { position: positions[0], quaternion: [0, 0, 0, 1], fov: 45 } });
    record.route = positions.map((p, i) => point(p, i));
    return record;
}
const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const close = (a, b, precision = 8) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], precision));

describe('camera-flight records', () => {
    it('matches canonical metric anchors and rejects route nodes beyond the 60 km frame radius', () => {
        for (const framePatch of [{ lat: 52.1234567 }, { lng: -1.1234567 }, { lat: 85.01 }, { lng: 180 }]) {
            const r = flight(); Object.assign(r.frame, framePatch); expect(Flight.validate(r)).toMatch(/metric frame/);
        }
        const r = flight([[0, 0, 2], [36000, 48000, 2]]);
        expect(Flight.validate(r)).toBeNull(); expect(Flight.compile(r).evaluate(10).position).toEqual([36000, 48000, 2]);
        r.route[1].position[0] += 0.001; expect(Flight.validate(r)).toMatch(/route/);
    });
    it('creates an isolated normalized zero-duration draft without fabricating a published flight', () => {
        const source = copy(view), sourceFrame = copy(frame), position = [1, 2, 3];
        const draft = Flight.create({ title: ' New flight ', view: source, frame: sourceFrame,
            pose: { position, quaternion: [0, 0, 0, 2] } });
        expect(draft.schema).toBe(Flight.SCHEMA);
        expect(draft.title).toBe('New flight');
        expect(draft.fov).toBe(45);
        expect(Flight.validate(draft, { draft: true })).toBeNull();
        expect(Flight.validate(draft)).toMatch(/last/);
        source.settings.xray = '1'; sourceFrame.lat = 0; position[0] = 99;
        expect(draft.view.settings.xray).toBe('0'); expect(draft.frame.lat).toBe(52);
        expect(draft.route[0].position).toEqual([1, 2, 3]);
        expect(draft.looks[0].quaternion).toEqual([0, 0, 0, 1]);
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
        ['incomplete orbit pose', r => ({ ...r, view: { ...r.view, camera: { range: 10 } } })],
        ['non-finite orbit pose', r => ({ ...r, view: { ...r.view, camera: { targetLat: 52,
            targetLng: -1, headingDeg: NaN, pitchRad: -0.5, range: 10 } } })],
    ])('rejects %s', (_label, change) => expect(Flight.validate(change(flight()))).toBeTypeOf('string'));

    it('validates route IDs, finite metric positions and strictly positive later travel times', () => {
        for (const mutate of [
            r => { r.route[1].id = r.route[0].id; }, r => { r.route[1].position[0] = NaN; },
            r => { r.route[1].position[2] = null; }, r => { r.route[0].travelSeconds = 1; },
            r => { r.route[1].travelSeconds = 0; }, r => { r.route[1].holdSeconds = -1; },
            r => { r.route[1].holdSeconds = Infinity; }, r => { r.route[0].extra = 1; },
            r => { r.route[1].travelSeconds = 601; },
            r => { r.route = Array.from({ length: 257 }, (_, i) => point([i, 0, 0], i, 1)); },
        ]) { const r = flight(); mutate(r); expect(Flight.validate(r)).toBeTypeOf('string'); }
    });

    it('requires sorted independent normalized look keys and bounded cue times', () => {
        for (const mutate of [r => { r.looks = []; }, r => { r.looks[0].quaternion = [0, 0, 0, 2]; },
            r => { r.looks[0].time = -1; }, r => { r.looks[0].time = 11; },
            r => { r.looks.push({ id: 'look-2', time: 0, quaternion: yaw(90) }); },
            r => { r.cues = [{ id: 'cue', time: 11, settings: { xray: '1' } }]; },
            r => { r.cues = [{ id: 'cue', time: 1, settings: { existing: 'solid' } }]; },
            r => { r.cues = [{ id: 'cue', time: 1, settings: {} }]; },
        ]) { const r = flight(); mutate(r); expect(Flight.validate(r)).toBeTypeOf('string'); }
        const r = flight(); r.looks = [];
        expect(Flight.validate(r, { draft: true })).toBeNull();
    });

    it('rejects sparse arrays, count overruns and duplicate timeline identities without throwing', () => {
        for (const name of ['route', 'looks', 'interiors', 'cues', 'designCids']) {
            const r = flight(); r[name] = new Array(1);
            expect(Flight.validate(r)).toBeTypeOf('string');
        }
        for (const field of ['position', 'quaternion']) {
            const r = flight();
            if (field === 'position') r.route[0].position = new Array(3);
            else r.looks[0].quaternion = new Array(4);
            expect(Flight.validate(r)).toBeTypeOf('string');
        }
        for (const name of ['looks', 'interiors', 'cues']) {
            const r = flight(); r[name] = Array.from({ length: Flight.LIMITS[name] + 1 }, (_, i) => ({ id: `id-${i}` }));
            expect(Flight.validate(r)).toBeTypeOf('string');
        }
        const r = flight(); r.looks.push({ ...r.looks[0], time: 2 });
        expect(Flight.validate(r)).toBeTypeOf('string');
        r.looks.pop(); r.route[1].travelSeconds = 600;
        expect(Flight.validate(r)).toBeNull();
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

describe('absolute-time camera-flight evaluation', () => {
    it('rejects a curved excursion beyond the metric domain even when every authored node is inside', () => {
        const r = flight([[0, 0, 0], [59900, -500, 0], [59900, 500, 0], [0, 1000, 0]]);
        expect(Flight.validate(r)).toBeNull(); expect(() => Flight.compile(r)).toThrow(/60 km metric frame/);
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

    it('keeps duplicate/stationary segments finite and still permits independent turns', () => {
        const r = flight([[0, 0, 1], [0, 0, 1], [10, 0, 1], [10, 0, 1], [10, 10, 1]]);
        r.looks = [0, 90, 180, 270, 360].map((angle, i) => ({ id: `look-${i}`, time: i * 2.5, quaternion: yaw(angle) }));
        const c = Flight.compile(r);
        for (const t of [0, 2.5, 5, 7.5, 10]) close(c.evaluate(t).position, [0, 0, 1]);
        close(c.evaluate(2.5).quaternion, yaw(90));
        for (let t = 0; t <= 40; t += 0.25) expect(c.evaluate(t).position.every(Number.isFinite)).toBe(true);
        close(c.evaluate(25).position, [10, 0, 1]);
    });

    it('preserves complete and multiple turns with authored intermediate keys', () => {
        const r = flight(); r.route[0].holdSeconds = 8;
        r.looks = Array.from({ length: 9 }, (_, i) => ({ id: `look-${i}`, time: i, quaternion: yaw(i * 90) }));
        const c = Flight.compile(r);
        for (let t = 0; t <= 8; t += 0.125) {
            const q = c.evaluate(t).quaternion, expected = yaw(t * 90);
            expect(Math.abs(q.reduce((sum, x, i) => sum + x * expected[i], 0))).toBeCloseTo(1, 8);
            close(c.evaluate(t).position, [0, 0, 2]);
        }
    });

    it('keeps position independent of looks and interpolates pitch/roll across poles', () => {
        const r = flight([[0, 0, 0], [3, 4, 5], [10, 1, 8]]), plain = Flight.compile(r);
        r.looks = [{ id: 'a', time: 3, quaternion: [0, 0, 0, 1] },
            { id: 'b', time: 12, quaternion: [0.5, 0.5, 0.5, 0.5] },
            { id: 'c', time: 19, quaternion: [0, 1, 0, 0] }];
        const changed = Flight.compile(r);
        for (const t of [0, 3, 8, 12, 15, 19, 20]) {
            close(changed.evaluate(t).position, plain.evaluate(t).position);
            expect(Math.hypot(...changed.evaluate(t).quaternion)).toBeCloseTo(1, 10);
        }
        close(changed.evaluate(0).quaternion, [0, 0, 0, 1]); close(changed.evaluate(20).quaternion, [0, 1, 0, 0]);
    });

    it('merges timed settings absolutely, including explicit off and negative floor cutaway', () => {
        const r = flight(); r.cues = [{ id: 'a', time: 2, settings: { xray: '1', suggested: '1', cutaway: '-1' } },
            { id: 'b', time: 5, settings: { xray: '0', cutaway: 'all' } }];
        const c = Flight.compile(r);
        expect(c.evaluate(2).settings).toMatchObject({ existing: 'ghost', xray: '1', suggested: '1', cutaway: '-1' });
        expect(c.evaluate(5).settings).toMatchObject({ xray: '0', suggested: '1', cutaway: 'all' });
        expect(c.evaluate(1).settings).toEqual(view.settings);
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

    it('supports a stationary published hold and an empty-look editable draft', () => {
        const r = flight([[1, 2, 3]]); r.route[0].holdSeconds = 5;
        expect(Flight.validate(r)).toBeNull(); close(Flight.compile(r).evaluate(3).position, [1, 2, 3]);
        r.looks = []; close(Flight.compile(r).evaluate(3).quaternion, [0, 0, 0, 1]);
        r.frame.datum = 'invalid'; expect(() => Flight.compile(r)).toThrow(/frame/);
    });

    it('uses shortest quaternion intervals including antipodal representations', () => {
        close(Flight.slerp(yaw(10), yaw(350), 0.5), yaw(0));
        const q = [0.5, 0.5, 0.5, 0.5]; close(Flight.slerp(q, q.map(x => -x), 0.5), q);
    });
});
