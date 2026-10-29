// The cross-section of a road placed into a parcel (frontend/js/proposals/corridor-site-fit.js,
// docs/road-in-parcel.md): the chosen lanes kept, pavements to 3 m and verges beyond filling the
// room, the Schelling streets reproduced exactly, and a bounded road's room measured from its site.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Fit = require('../../frontend/js/proposals/corridor-site-fit.js');
const Streets = require('../../frontend/js/schelling/schelling-streets.js');
const { CORRIDOR_PROFILE_PRESETS } = require('../../frontend/js/corridor-profile.js');

const width = strips => strips.reduce((sum, strip) => sum + strip.width, 0);
const types = profile => profile.strips.map(strip => strip.type);

// Metres east and north of a point near Zagreb, exactly, through the app's own metric frame.
const frame = require('../../frontend/js/metric-frame.js').frameAt([15.977, 45.813]);
const at = (east, north) => { const [lng, lat] = frame.toLngLat([east, north]); return { lat, lng }; };
const ring = (x0, y0, x1, y1) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)].map(p => [p.lng, p.lat]);

describe('the automatic cross-section', () => {
    it('is the Schelling arterial at 30 m, strip for strip', () => {
        expect(Fit.autoProfile(30).strips).toEqual(Streets.ARTERIAL_STRIPS.map(strip => ({ ...strip })));
    });

    it('is the Schelling local street at 12 and 16 m: two lanes, parking once 8 m are left', () => {
        expect(types(Fit.autoProfile(12))).toEqual(['sidewalk', 'driving', 'driving', 'sidewalk']);
        expect(Fit.autoProfile(12).strips[0].width).toBeCloseTo(2.75, 6);
        expect(types(Fit.autoProfile(16))).toEqual(['sidewalk', 'parking', 'driving', 'driving', 'parking', 'sidewalk']);
        for (const metres of [7, 9.5, 12, 16, 24, 30, 36]) expect(width(Fit.autoProfile(metres).strips)).toBeCloseTo(metres, 6);
    });

    it('gives a wide street a 3 m pavement and the rest to a verge, with trees from 2 m', () => {
        const strips = Fit.autoProfile(24).strips;
        expect(strips[0]).toEqual({ type: 'sidewalk', width: 3 });
        expect(strips[1]).toEqual({ type: 'verge', width: 3.75, landscape: 'trees' });
        expect(Fit.autoProfile(20).strips[1]).toEqual({ type: 'verge', width: 1.75, landscape: 'grass' });
    });

    it('is one shared lane from 3.5 m and nothing below', () => {
        expect(types(Fit.autoProfile(6))).toEqual(['sidewalk', 'driving', 'sidewalk']);
        expect(Fit.autoProfile(3)).toBeNull();
        expect(Fit.fitArm(3).fits).toBe(false);
    });
});

describe('chosen lanes', () => {
    const core18 = Fit.coreOf({ strips: CORRIDOR_PROFILE_PRESETS[18] });

    it('keep their order and leave the edges out', () => {
        expect(core18.map(strip => strip.type)).toEqual(['cycleway', 'parking', 'driving', 'driving', 'parking', 'cycleway']);
    });

    it('fit only with 1.5 m of pavement each side', () => {
        expect(Fit.fitArm(16.9, core18)).toMatchObject({ fits: false, requiredM: 17 });
        const fitted = Fit.fitArm(20, core18);
        expect(fitted.fits).toBe(true);
        expect(width(fitted.profile.strips)).toBeCloseTo(20, 6);
        expect(fitted.profile.strips[0]).toEqual({ type: 'sidewalk', width: 3 });
    });

    it('offer only the presets that fit', () => {
        expect(Fit.corePresetsFor(12).map(entry => entry.key)).toEqual(['7.5', '10']);
        expect(Fit.corePresetsFor(30).map(entry => entry.key)).toEqual(['7.5', '10', '18', '26']);
    });
});

describe('a bounded road', () => {
    // A 12 m strip 120 m long, the road along its middle with the automatic lanes.
    const site = { type: 'Polygon', coordinates: [ring(0, 0, 120, 12)] };
    const road = (north = 6, profile = Fit.autoProfile(12)) => ({
        points: [[at(0, north), at(120, north)]], segments: [[at(0, north), at(120, north)]], segmentIds: ['s1'],
        profile, bound: { site }
    });

    it('measures the room its site leaves', () => {
        const [room] = Fit.availableWidths(road());
        expect(room.widthM).toBeCloseTo(12, 2);
    });

    it('has nothing to refuse while its lanes fit', () => {
        expect(Fit.boundedRoadIssues(road())).toEqual([]);
    });

    it('refuses lanes wider than the room, with both numbers', () => {
        const wide = Fit.profileAround(Fit.coreOf({ strips: CORRIDOR_PROFILE_PRESETS[18] }), 17);
        const [issue] = Fit.boundedRoadIssues(road(6, wide));
        expect(issue).toMatchObject({ code: 'core-too-wide', segmentId: 's1', requiredM: 14 });
        expect(issue.availableM).toBeCloseTo(12, 1);
    });

    it('refuses a node moved off its site', () => {
        const moved = road();
        moved.points[0][1] = at(120, 30);
        expect(Fit.boundedRoadIssues(moved)[0].code).toBe('outside-site');
    });

    it('re-fills its edges for the room a move leaves: off-centre, the narrower side sets the room', () => {
        const refitted = Fit.refitBounded(road(5));
        expect(width(refitted.segmentProfiles.s1.strips)).toBeCloseTo(10, 2);
        expect(refitted.segmentProfiles.s1.strips.filter(strip => strip.type === 'driving').map(strip => strip.width)).toEqual([3.25, 3.25]);
    });
});
