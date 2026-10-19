// Headless coverage for civil-day playback and geographic-to-apartment solar directions.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Sun = require('../../frontend/js/apartment-sun-state.js');
const SunCalc = require('../../frontend/vendor/suncalc.min.js');
const vectorClose = (actual, expected) => ['x', 'y', 'z'].forEach(axis => expect(actual[axis]).toBeCloseTo(expected[axis], 12));

describe('apartment solar clock', () => {
    it('selects the actual local day with a dynamic year, independently of the machine timezone', () => {
        expect(Sun.localDate(new Date('2031-12-31T23:30:00Z'))).toBe('2032-01-01');
        expect(Sun.localDate(new Date('2032-06-01T22:30:00Z'))).toBe('2032-06-02');
        expect(Sun.formatTime(new Date('2032-01-01T23:30:00Z'))).toBe('00:30');
        expect(Sun.formatTime(new Date('2032-06-01T22:30:00Z'))).toBe('00:30');
    });
    it.each([
        ['2026-01-15', '2026-01-14T23:00:00.000Z', 24],
        ['2026-06-15', '2026-06-14T22:00:00.000Z', 24],
        ['2026-03-29', '2026-03-28T23:00:00.000Z', 23],
        ['2026-10-25', '2026-10-24T22:00:00.000Z', 25]
    ])('cycles the full civil day %s, including DST', (date, start, hours) => {
        const day = Sun.dayBounds(date);
        expect(day.start.toISOString()).toBe(start);
        expect(day.durationMs).toBe(hours * 3600000);
        expect(Sun.formatTime(day.start)).toBe('00:00');
        expect(Sun.formatTime(day.end)).toBe('00:00');
        expect(Sun.formatTime(Sun.dateAtProgress(day, Sun.progressAtTime(day)))).toBe('12:00');
        expect(Sun.localDate(Sun.dateAtProgress(day, .99999))).toBe(date);
        expect(Sun.dateAtProgress(day, 1).getTime()).toBe(day.start.getTime());
    });
    it('advances 24 normal-day hours in 20 seconds, wraps and pauses continuously', () => {
        expect(Sun.CYCLE_SECONDS).toBe(20);
        expect(Sun.advanceProgress(.5, 5)).toBeCloseTo(.75);
        expect(Sun.advanceProgress(.9, 4)).toBeCloseTo(.1);
        expect(Sun.advanceProgress(.25, 20)).toBeCloseTo(.25);
        expect(Sun.advanceProgress(.25, 120, true)).toBeCloseTo(.25);
        expect(Sun.formatTime(Sun.dateAtProgress(Sun.dayBounds('2026-06-15'), .25))).toBe('06:00');
    });
    it.each(['2026-02-29', '2026-13-01', '2026-1-01', '', null])('rejects an invalid civil day %s', date => {
        expect(() => Sun.dayBounds(date)).toThrow(RangeError);
    });
    it('rejects a nonexistent DST clock reading instead of silently selecting another hour', () => {
        expect(() => Sun.progressAtTime(Sun.dayBounds('2026-03-29'), 2, 30)).toThrow(RangeError);
    });
});

describe('apartment solar coordinate contract', () => {
    it('remaps the sibling solar convention to apartment east/north/up axes', () => {
        vectorClose(Sun.sunDirection(0, -Math.PI / 2), { x: 1, y: 0, z: 0 });
        vectorClose(Sun.sunDirection(0, 0), { x: 0, y: -1, z: 0 });
        vectorClose(Sun.sunDirection(0, Math.PI / 2), { x: -1, y: 0, z: 0 });
        vectorClose(Sun.sunDirection(0, Math.PI), { x: 0, y: 1, z: 0 });
        vectorClose(Sun.sunDirection(Math.PI / 2, 0), { x: 0, y: 0, z: 1 });
    });
    it('inverts the apartment-to-site rotation, including the manual north bearing convention', () => {
        vectorClose(Sun.sunDirection(0, Math.PI, 90), { x: 1, y: 0, z: 0 });
        vectorClose(Sun.sunDirection(0, 0, 90), { x: -1, y: 0, z: 0 });
        const rotation = 37 * Math.PI / 180, world = Sun.sunDirection(.47, -1.1), local = Sun.sunDirection(.47, -1.1, 37);
        vectorClose({ x: Math.cos(rotation) * local.x - Math.sin(rotation) * local.y,
            y: Math.sin(rotation) * local.x + Math.cos(rotation) * local.y, z: local.z }, world);
        expect(Math.hypot(local.x, local.y, local.z)).toBeCloseTo(1, 12);
    });
    it('uses only an accepted placement and preserves unknown orientation explicitly', () => {
        expect(Sun.orientationFromPlacement({ status: 'placed', best: { rotationDeg: -90 } }))
            .toEqual({ status: 'placed', rotationDeg: 270, basis: 'placement' });
        for (const placement of [null, {}, { status: 'ambiguous', best: { rotationDeg: 30 } },
            { status: 'placed', best: { rotationDeg: null } }, { status: 'placed', best: { rotationDeg: '90' } }]) {
            expect(Sun.orientationFromPlacement(placement)).toEqual({ status: 'unknown', rotationDeg: null, basis: null });
        }
    });
    it('samples real SunCalc summer morning, noon, evening and night in local time', () => {
        const day = Sun.dayBounds('2026-06-21');
        const sample = hour => Sun.sampleSun({ sunCalc: SunCalc, day, progress: Sun.progressAtTime(day, hour), latitude: 45.815, longitude: 15.982 });
        const morning = sample(8), noon = sample(13), evening = sample(19), night = sample(1);
        expect(morning.time).toBe('08:00');
        expect(morning.daylight).toBe(true); expect(morning.direction.x).toBeGreaterThan(0);
        expect(noon.direction.y).toBeLessThan(0); expect(noon.direction.z).toBeGreaterThan(.85);
        expect(evening.daylight).toBe(true); expect(evening.direction.x).toBeLessThan(0);
        expect(night.daylight).toBe(false); expect(night.direction.z).toBeLessThan(0);
    });
    it('does not convert absent locations or angles into valid zero values', () => {
        const input = { sunCalc: SunCalc, day: Sun.dayBounds('2026-06-21'), progress: .5, latitude: 45, longitude: 16 };
        expect(() => Sun.sampleSun({ ...input, latitude: null })).toThrow(RangeError);
        expect(() => Sun.sampleSun({ ...input, longitude: undefined })).toThrow(RangeError);
        expect(() => Sun.sampleSun({ ...input, rotationDeg: null })).toThrow(RangeError);
        expect(() => Sun.advanceProgress(.5, NaN)).toThrow(RangeError);
    });
});
