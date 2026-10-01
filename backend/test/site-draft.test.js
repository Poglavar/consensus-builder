// Site-first authoring, the pure half (frontend/js/proposals/site-draft.js): a drawn ring becomes a
// site, drafts need the ground their goal needs (parcel acts: parcels; material proposals: a site,
// parcels or their own design), drawn corners snap to parcel corners/edges, and a binding is
// summarised into the binding preview's rows (small intrusions flagged with their width, sub-floor
// touches hidden at tolerance 0, open ground). PARCEL-OPTIONAL.md, phase 2.
import { beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const siteBinding = require('../../frontend/js/proposals/site-binding.js');
const siteDraft = require('../../frontend/js/proposals/site-draft.js');

const LNG0 = 15.97;
const LAT0 = 45.8;
const M_LNG = turf.distance([LNG0, LAT0], [LNG0 + 0.01, LAT0], { units: 'meters' }) / 0.01;
const M_LAT = turf.distance([LNG0, LAT0], [LNG0, LAT0 + 0.01], { units: 'meters' }) / 0.01;
const P = (x, y) => [LNG0 + x / M_LNG, LAT0 + y / M_LAT];
const ring = (x0, y0, x1, y1) => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const rect = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[...ring(x0, y0, x1, y1), P(x0, y0)]] });

beforeAll(() => { globalThis.turf = turf; });

describe('siteFromRing', () => {
    it('turns an open ring into a MultiPolygon site with its area', () => {
        const result = siteDraft.siteFromRing(ring(0, 0, 40, 30), { turf });
        expect(result.ok).toBe(true);
        expect(result.site.type).toBe('MultiPolygon');
        expect(result.areaM2).toBeGreaterThan(1195);
        expect(result.areaM2).toBeLessThan(1205);
    });

    it('refuses fewer than three corners, a self-crossing outline and a sliver', () => {
        expect(siteDraft.siteFromRing([P(0, 0), P(10, 0)], { turf })).toEqual({ ok: false, reason: 'too-few-vertices' });
        // A bow tie: (0,0) (10,10) (10,0) (0,10).
        expect(siteDraft.siteFromRing([P(0, 0), P(10, 10), P(10, 0), P(0, 10)], { turf }).reason).toBe('self-intersecting');
        expect(siteDraft.siteFromRing(ring(0, 0, 0.5, 0.5), { turf }).reason).toBe('too-small');
    });

    it('ignores a repeated corner (a double click)', () => {
        const corners = ring(0, 0, 20, 20);
        const result = siteDraft.siteFromRing([corners[0], corners[1], corners[1], corners[2], corners[3]], { turf });
        expect(result.ok).toBe(true);
        expect(result.site.coordinates[0][0]).toHaveLength(5);
    });
});

describe('siteFromFeatures and siteBounds', () => {
    it('unions abutting parcels into one polygon', () => {
        const site = siteDraft.siteFromFeatures([turf.feature(rect(0, 0, 20, 20)), turf.feature(rect(20, 0, 40, 20))], { turf });
        expect(site.coordinates).toHaveLength(1);
        expect(Math.round(turf.area(turf.feature(site)))).toBeGreaterThan(799);
    });

    it('gives the bounds shape calculateProposalBounds returns', () => {
        const bounds = siteDraft.siteBounds(rect(0, 0, 40, 30));
        expect(bounds.fromSite).toBe(true);
        expect(bounds.west).toBeCloseTo(LNG0, 9);
        expect(bounds.north).toBeCloseTo(P(0, 30)[1], 9);
        expect(bounds.center.lng).toBeCloseTo((P(0, 0)[0] + P(40, 0)[0]) / 2, 9);
    });
});

describe('draftGroundIssue', () => {
    const base = fields => ({ goal: 'park', fields: { name: 'x', ...fields }, editorPayload: {} });

    it('a material draft with neither parcels nor site nor design is missing its site', () => {
        expect(siteDraft.draftGroundIssue(base({ selectedParcelIds: [] }))).toMatchObject({ code: 'missing-site', path: 'fields.site' });
    });

    it('a material draft with a site, or its own design geometry, has its ground', () => {
        expect(siteDraft.draftGroundIssue(base({ selectedParcelIds: [], site: rect(0, 0, 10, 10) }))).toBeNull();
        expect(siteDraft.draftGroundIssue({ goal: 'station', fields: {}, editorPayload: { structureProposal: { geometry: rect(0, 0, 5, 30) } } })).toBeNull();
        expect(siteDraft.draftGroundIssue({ goal: 'road-track', fields: {}, editorPayload: { definition: { points: [P(0, 0), P(50, 0)] } } })).toBeNull();
    });

    it('a parcel act keeps needing parcels, a site does not stand in for them', () => {
        expect(siteDraft.draftGroundIssue({ goal: 'ownership-transfer', fields: { site: rect(0, 0, 10, 10) }, editorPayload: {} }))
            .toMatchObject({ code: 'missing-parcels' });
        expect(siteDraft.draftGroundIssue({ goal: 'ownership-transfer', fields: { selectedParcelIds: ['HR-1-1'] }, editorPayload: {} })).toBeNull();
    });
});

describe('snapCoordinate', () => {
    const parcel = rect(0, 0, 40, 30);

    it('prefers the parcel corner within the radius, even with an edge nearer', () => {
        const hit = siteDraft.snapCoordinate(P(0.6, 0.2), [parcel], { radiusM: 1 });
        expect(hit.snapped).toBe('vertex');
        expect(hit.coordinate).toEqual(P(0, 0));
    });

    it('lands on the edge when no corner is near', () => {
        const hit = siteDraft.snapCoordinate(P(20, 0.4), [parcel], { radiusM: 1 });
        expect(hit.snapped).toBe('edge');
        expect(turf.distance(hit.coordinate, P(20, 0), { units: 'meters' })).toBeLessThan(0.01);
    });

    it('leaves a coordinate alone out of reach', () => {
        const hit = siteDraft.snapCoordinate(P(20, 5), [parcel], { radiusM: 1 });
        expect(hit).toEqual({ coordinate: P(20, 5), snapped: false });
    });
});

describe('snapToGround (parcel and building outlines)', () => {
    const parcel = rect(0, 0, 40, 30);
    const building = rect(5, 5, 15, 12);

    it('snaps to a building corner and says it is a building', () => {
        const hit = siteDraft.snapToGround(P(5.4, 5.3), { parcels: [parcel], buildings: [building] }, { radiusM: 1 });
        expect(hit).toMatchObject({ snapped: 'vertex', kind: 'building' });
        expect(hit.coordinate).toEqual(P(5, 5));
    });

    it('a building corner beats a nearer parcel edge (corners first, then edges)', () => {
        const near = rect(20.5, 0.8, 30, 10); // its corner is 0.78 m from the cursor, the parcel edge 0.2 m
        const hit = siteDraft.snapToGround(P(20, 0.2), { parcels: [parcel], buildings: [near] }, { radiusM: 1 });
        expect(hit).toMatchObject({ snapped: 'vertex', kind: 'building', coordinate: P(20.5, 0.8) });
        // the nearer corner wins whichever kind it is
        const hit2 = siteDraft.snapToGround(P(0.3, 0.3), { parcels: [parcel], buildings: [rect(0.8, 0.8, 9, 9)] }, { radiusM: 1 });
        expect(hit2).toMatchObject({ snapped: 'vertex', kind: 'parcel', coordinate: P(0, 0) });
    });

    it('lands on a building edge and reports the kind', () => {
        const hit = siteDraft.snapToGround(P(10, 12.4), { parcels: [parcel], buildings: [building] }, { radiusM: 1 });
        expect(hit).toMatchObject({ snapped: 'edge', kind: 'building' });
        expect(turf.distance(hit.coordinate, P(10, 12), { units: 'meters' })).toBeLessThan(0.01);
    });

    it('parcel-only targets behave like snapCoordinate', () => {
        const hit = siteDraft.snapToGround(P(0.6, 0.2), { parcels: [parcel] }, { radiusM: 1 });
        expect(hit).toMatchObject({ snapped: 'vertex', kind: 'parcel', coordinate: P(0, 0) });
        expect(siteDraft.snapToGround(P(20, 5), { parcels: [parcel], buildings: [building] }, { radiusM: 1 }).snapped).toBe(false);
    });

    it('takes box entries from snapTargetsInBox and filters by the radius box', () => {
        const entries = siteDraft.snapTargetsInBox([building], null);
        expect(entries).toHaveLength(1);
        expect(entries[0].box[0]).toBeCloseTo(P(5, 5)[0], 12);
        const hit = siteDraft.snapToGround(P(15.5, 12.2), { buildings: entries }, { radiusM: 1 });
        expect(hit).toMatchObject({ snapped: 'vertex', kind: 'building', coordinate: P(15, 12) });
    });
});

describe('snapTargetsInBox', () => {
    const inside = rect(5, 5, 15, 12);
    const outside = rect(500, 500, 510, 510);
    const viewport = [P(0, 0)[0], P(0, 0)[1], P(100, 100)[0], P(100, 100)[1]];

    it('keeps only outlines that overlap the box', () => {
        const entries = siteDraft.snapTargetsInBox([inside, outside, { type: 'Feature', geometry: inside }], viewport);
        expect(entries).toHaveLength(2);
        expect(entries[1].geometry).toBe(inside);
    });

    it('stops at the cap and drops non-geometries', () => {
        expect(siteDraft.snapTargetsInBox([inside, inside, inside], viewport, { cap: 2 })).toHaveLength(2);
        expect(siteDraft.snapTargetsInBox([null, { type: 'Point', coordinates: P(1, 1) }], viewport)).toHaveLength(0);
    });
});

describe('bindingSummary', () => {
    const A = { id: 'HR-1-A', geometry: rect(0, 0, 40, 30) };
    const B = { id: 'HR-1-B', geometry: rect(40, 0, 80, 30) };

    it('flags a bound parcel reached into by under half a metre, with its width', () => {
        // The site covers A and reaches 0.2 m into B.
        const binding = siteBinding.bindingFromParcels(rect(0, 0, 40.2, 30), [A, B], { turf });
        const summary = siteDraft.bindingSummary(binding);
        expect(summary.bound.map(hit => hit.parcelId)).toEqual(['HR-1-A', 'HR-1-B']);
        expect(summary.warnings).toHaveLength(1);
        expect(summary.warnings[0]).toMatchObject({ parcelId: 'HR-1-B', kind: 'small', width: '20 cm' });
        expect(summary.coverage).toBe('complete');
        expect(summary.isPreview).toBe(true);
    });

    it('shows touched parcels only under a tolerance', () => {
        const binding = siteBinding.bindingFromParcels(rect(0, 0, 40.2, 30), [A, B], { turf, toleranceM: 0.5 });
        const summary = siteDraft.bindingSummary(binding);
        expect(summary.bound.map(hit => hit.parcelId)).toEqual(['HR-1-A']);
        expect(summary.warnings).toEqual([expect.objectContaining({ parcelId: 'HR-1-B', kind: 'touched' })]);
        const atZero = siteDraft.bindingSummary({ ...binding, toleranceM: 0 });
        expect(atZero.warnings).toEqual([]);
    });

    it('marks open ground and an empty binding', () => {
        const binding = siteBinding.bindingFromParcels(rect(-20, 0, 20, 30), [A], { turf });
        const summary = siteDraft.bindingSummary(binding);
        expect(summary.coverage).toBe('partial');
        expect(summary.openGround).toBe(true);
        const none = siteDraft.bindingSummary(siteBinding.bindingFromParcels(rect(0, 0, 10, 10), [], { turf, regionHasCadastre: false }));
        expect(none).toMatchObject({ coverage: 'none', openGround: true, parcelCount: 0 });
    });

    it('lists the small intrusions a publish has not had accepted', () => {
        const binding = siteBinding.bindingFromParcels(rect(0, 0, 40.2, 30), [A, B], { turf });
        expect(siteDraft.unconfirmedSmallIntrusions(binding, []).map(w => w.parcelId)).toEqual(['HR-1-B']);
        expect(siteDraft.unconfirmedSmallIntrusions(binding, ['HR-1-B'])).toEqual([]);
    });
});

describe('openGroundOf', () => {
    it('is the part of the site no parcel covers, without micro-gaps', () => {
        const parcels = [{ id: 'A', geometry: rect(0, 0, 20, 30) }, { id: 'B', geometry: rect(20.0004, 0, 40, 30) }];
        const open = siteDraft.openGroundOf(rect(-10, 0, 40, 30), parcels, { turf });
        // The 10 m strip west of A is open ground; the 0.4 mm seam between A and B is not.
        expect(open.coordinates).toHaveLength(1);
        expect(turf.area(turf.feature(open))).toBeGreaterThan(299);
        expect(turf.area(turf.feature(open))).toBeLessThan(301);
        expect(siteDraft.openGroundOf(rect(0, 0, 40, 30), parcels, { turf })).toBeNull();
    });

    it('is the whole site where the region has no cadastre', () => {
        const site = rect(0, 0, 10, 10);
        expect(siteDraft.openGroundOf(site, [], { turf, regionHasCadastre: false }).type).toBe('MultiPolygon');
    });
});

describe('formatWidth', () => {
    it('reads in the unit a person uses', () => {
        expect(siteDraft.formatWidth(0.004)).toBe('4 mm');
        expect(siteDraft.formatWidth(0.04)).toBe('4 cm');
        expect(siteDraft.formatWidth(1.234)).toBe('1.2 m');
        expect(siteDraft.formatWidth(12.6)).toBe('13 m');
        expect(siteDraft.formatWidth(null)).toBe('');
    });
});

describe('a site wholly inside an unsurveyed hole', () => {
    it('is partial by the binding rule and all open ground for the label', () => {
        const parcels = [{ id: 'A', geometry: rect(0, 0, 40, 30) }];
        const binding = siteBinding.bindingFromParcels(rect(100, 100, 120, 120), parcels, { turf });
        const summary = siteDraft.bindingSummary(binding);
        expect(summary.coverage).toBe('partial');
        expect(summary.allOpen).toBe(true);
        expect(siteDraft.bindingSummary(siteBinding.bindingFromParcels(rect(-20, 0, 20, 30), parcels, { turf })).allOpen).toBe(false);
    });
});
