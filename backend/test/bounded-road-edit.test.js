// Editing a road placed into a parcel (docs/road-in-parcel.md) through the real road-drawing.js
// runLocalCorridorGeometryUpdate (helpers/road-drawing-env.js): the land stays the parcel, the
// pavements re-fill after a lane change, a node moved off the parcel or lanes wider than it are
// refused with the reason, and only the parcel itself is declared, not the neighbours it touches.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { loadRoadDrawing, at, boxRing } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const Fit = require('../../frontend/js/proposals/corridor-site-fit.js');
const RoadInSite = require('../../frontend/js/proposals/road-in-site.js');
const { CORRIDOR_PROFILE_PRESETS } = require('../../frontend/js/corridor-profile.js');

const SITE = { type: 'Polygon', coordinates: [boxRing(0, 0, 120, 12)] };
const PARCELS = [
    { id: 'HR-STREET', ring: boxRing(0, 0, 120, 12) },
    { id: 'HR-NORTH', ring: boxRing(0, 12, 120, 40) },
    { id: 'HR-SOUTH', ring: boxRing(0, -30, 120, 0) }
];
const width = strips => strips.reduce((sum, strip) => sum + strip.width, 0);

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

function harness() {
    const definition = RoadInSite.boundedDefinition(RoadInSite.roadsInSite(SITE).roads[0]);
    const source = { proposalId: 'street', title: 'Street', applied: true, createdAt: '2026-10-29T00:00:00.000Z', cadastreParcelIds: [], roadProposal: { definition } };
    env = loadRoadDrawing({ parcels: PARCELS, proposals: [source], globals: { __corridorSiteFit: Fit } });
    const mutation = { proposals: env.store, afterCommit: () => { } };
    return { source, run: mutate => env.api.runLocalCorridorGeometryUpdate('street', mutate, { _parcelMutation: mutation }) };
}

describe('a road placed into a parcel', () => {
    it('keeps the parcel as its land and declares the parcel, not its neighbours', async () => {
        const h = harness();
        // Any edit: the lanes narrowed to one shared lane.
        const result = await h.run(definition => {
            definition.profile = Fit.profileAround([{ type: 'driving', width: 3, direction: 'both' }], 12);
            delete definition.segmentProfiles;
        });
        expect(result).toBe('street');
        const saved = h.source.roadProposal.definition;
        expect(saved.polygon).toEqual(SITE);
        expect(h.source.cadastreParcelIds).toEqual(['HR-STREET']);
    });

    it('re-fills its pavements around the lanes it is given', async () => {
        const h = harness();
        await h.run(definition => {
            definition.profile = { strips: [{ type: 'sidewalk', width: 1 }, { type: 'driving', width: 3, direction: 'both' }, { type: 'sidewalk', width: 1 }] };
            delete definition.segmentProfiles;
        });
        const saved = h.source.roadProposal.definition;
        const strips = saved.segmentProfiles[saved.segmentIds[0]].strips;
        // The parcel is 12 m in the harness's approximate degrees (about 12.07 m in the frame).
        expect(width(strips)).toBeCloseTo(Fit.availableWidths(saved)[0].widthM, 6);
        expect(width(strips)).toBeCloseTo(12, 0);
        expect(strips[0]).toEqual({ type: 'sidewalk', width: 3 });
        expect(strips[1].type).toBe('verge');
    });

    it('refuses lanes the parcel has no room for, with both widths, and leaves the road as it was', async () => {
        const h = harness();
        const before = JSON.stringify(h.source.roadProposal.definition);
        const core18 = Fit.coreOf({ strips: CORRIDOR_PROFILE_PRESETS[18] });
        await expect(h.run(definition => {
            definition.profile = { strips: core18 };
            delete definition.segmentProfiles;
        })).rejects.toMatchObject({ userMessage: expect.stringMatching(/need 14\.0 m.*leaves 12\.\d m/) });
        expect(JSON.stringify(h.source.roadProposal.definition)).toBe(before);
    });

    it('refuses a node moved off the parcel', async () => {
        const h = harness();
        await expect(h.run(definition => { definition.points[0][definition.points[0].length - 1] = at(120, 30); }))
            .rejects.toMatchObject({ userMessage: expect.stringMatching(/stays inside that parcel/) });
    });
});
