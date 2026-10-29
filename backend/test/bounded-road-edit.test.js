// Editing a road placed into a parcel (docs/road-in-parcel.md) through the real road-drawing.js
// runLocalCorridorGeometryUpdate (helpers/road-drawing-env.js): the land stays the parcel, the
// pavements re-fill after a lane change, a node moved off the parcel or lanes wider than it are
// refused with the reason, and only the parcel itself is declared, not the neighbours it touches.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
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

function harness(site = SITE, parcels = PARCELS) {
    const definition = RoadInSite.boundedDefinition(RoadInSite.roadsInSite(site).roads[0]);
    const source = { proposalId: 'street', title: 'Street', applied: true, createdAt: '2026-10-29T00:00:00.000Z', cadastreParcelIds: [], roadProposal: { definition } };
    env = loadRoadDrawing({ parcels, proposals: [source], globals: { __corridorSiteFit: Fit } });
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

// The cross-section editor's save (frontend/js/corridor-editor.js), taken out of the browser file.
const editorSource = readFileSync(new URL('../../frontend/js/corridor-editor.js', import.meta.url), 'utf8');
function editorFunction(name) {
    let found = null;
    (function find(node) {
        if (!node || typeof node !== 'object' || found) return;
        if (node.type === 'FunctionDeclaration' && node.id?.name === name) { found = node; return; }
        Object.keys(node).forEach(key => {
            if (['loc', 'start', 'end'].includes(key)) return;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(find); else find(value);
        });
    })(parse(editorSource, { sourceType: 'script' }));
    return editorSource.slice(found.start, found.end);
}
const editor = {};
vm.runInNewContext(`${editorFunction('corridorEditorProfileMutator')}\n${editorFunction('corridorEditorOwnProfileCount')}\n`
    + 'out.mutator = corridorEditorProfileMutator; out.ownCount = corridorEditorOwnProfileCount;',
{ out: editor, window: { __corridorSiteFit: Fit } });

describe('the cross-section editor on a road placed into a parcel', () => {
    // A 29 m street with a 12 m street meeting it: stretches with different lanes.
    const T_RING = [[0, 0], [200, 0], [200, 29], [106, 29], [106, 100], [94, 100], [94, 29], [0, 29], [0, 0]]
        .map(([x, y]) => { const p = at(x, y); return [p.lng, p.lat]; });
    const T_SITE = { type: 'Polygon', coordinates: [T_RING] };
    const lanesOf = (definition, id) => Fit.coreOf(definition.segmentProfiles?.[id] || definition.profile).map(strip => strip.type);
    const roadWide = (definition, swap) => editor.mutator({
        scope: 'road', profile: { strips: definition.profile.strips.map(strip => swap[strip.type] ? { type: swap[strip.type], width: 2 } : strip) },
        edgeFill: { limit: 'none' }, replaceStretchProfiles: false
    });

    it('applies a whole-road change to every stretch with the road\'s lanes, edit after edit', async () => {
        const h = harness(T_SITE, [{ id: 'HR-T', ring: T_RING }]);
        const wide = id => lanesOf(h.source.roadProposal.definition, id).includes('driving') && Fit.widthOf(h.source.roadProposal.definition.segmentProfiles?.[id]?.strips || h.source.roadProposal.definition.profile.strips) > 20;
        const before = h.source.roadProposal.definition;
        expect(before.profile.strips.map(strip => strip.type)).toContain('parking');
        // Every stretch has a cross-section of its own once the road is re-fitted; only the 12 m
        // street's lanes differ from the road's.
        await h.run(roadWide(before, { parking: 'cycleway' }));
        const once = h.source.roadProposal.definition;
        const wideIds = once.segmentIds.filter(wide);
        expect(wideIds.length).toBeGreaterThan(0);
        wideIds.forEach(id => expect(lanesOf(once, id)).toEqual(['cycleway', 'driving', 'driving', 'cycleway']));
        expect(editor.ownCount(once)).toBe(once.segmentIds.length - wideIds.length);
        // The second change of the whole road lands too: it was dropped while every stretch counted
        // as having lanes of its own.
        await h.run(roadWide(once, { cycleway: 'parking' }));
        const twice = h.source.roadProposal.definition;
        wideIds.forEach(id => expect(lanesOf(twice, id)).toEqual(['parking', 'driving', 'driving', 'parking']));
        twice.segmentIds.filter(id => !wideIds.includes(id)).forEach(id => expect(lanesOf(twice, id)).not.toContain('parking'));
    });
});
