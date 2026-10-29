// Roads placed into a parcel (frontend/js/proposals/road-in-site.js, docs/road-in-parcel.md): a real
// Schelling layout's street strips become one road network with shared crossings and the plan's own
// widths; the bound survives the stored record; the land is the site; and the MCP constructor and
// editor build, refit and refuse through the same modules (backend/agents/mcp-geometry.js).
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
globalThis.turf = globalThis.turf || turf;
const Grid = require('../../frontend/js/parcels/schelling-grid.js');
const Layouts = require('../../frontend/js/parcel-layout-layouts.js');
const RoadInSite = require('../../frontend/js/proposals/road-in-site.js');
const OsmForm = require('../../frontend/js/corridor-osm-form.js');
const Footprint = require('../../frontend/js/corridor-footprint.js');
const frame = require('../../frontend/js/metric-frame.js').frameAt([15.977, 45.813]);

const at = (east, north) => frame.toLngLat([east, north]);
const polygon = ring => ({ type: 'Polygon', coordinates: [[...ring.map(([e, n]) => at(e, n)), at(ring[0][0], ring[0][1])]] });
const width = strips => strips.reduce((sum, strip) => sum + strip.width, 0);

// The street strips a Schelling layout leaves over a pool of 2 × 2 blocks, padded a few metres past
// the outer lattice lines (so the outer streets are only partly inside the pool).
function schellingStrips() {
    const plan = Grid.planFor({ lat: 45.8045 });
    const cell = Grid.cellAt(plan, 45.8045, 15.97);
    const [w, s, e, n] = [Grid.lonOfLine(plan, cell.i), Grid.latOfLine(plan, cell.j), Grid.lonOfLine(plan, cell.i + 2), Grid.latOfLine(plan, cell.j + 2)];
    const pad = 0.00005;
    const pool = turf.polygon([[[w - pad, s - pad], [e + pad, s - pad], [e + pad, n + pad], [w - pad, n + pad], [w - pad, s - pad]]]);
    const { plots } = Layouts.schellingPlots(pool, plan, null, { turf, SchellingGrid: Grid });
    const strips = plots.filter(plot => plot.source === 'schelling-remainder');
    return { plan, site: strips.reduce((merged, plot) => turf.union(merged, turf.feature(plot.geometry)), turf.feature(strips[0].geometry)).geometry };
}

describe('roadsInSite', () => {
    it('makes a Schelling layout\'s street strips one road: three streets each way, nine shared crossings', () => {
        const { plan, site } = schellingStrips();
        const planned = RoadInSite.roadsInSite(site);
        expect(planned.issues).toEqual([]);
        expect(planned.roads).toHaveLength(1);
        const [road] = planned.roads;
        const ways = road.form.elements.filter(element => element.type === 'way');
        const nodes = road.form.elements.filter(element => element.type === 'node');
        expect(ways).toHaveLength(6);
        expect(nodes).toHaveLength(9);
        expect(ways.every(way => way.nodes.length === 3)).toBe(true);
        // The inner streets are the plan's own: two lanes and pavements, 12 m.
        const definition = RoadInSite.boundedDefinition(road);
        const widths = (definition.segmentIds || []).map(id => width((definition.segmentProfiles?.[id] || definition.profile).strips));
        expect(widths.some(w => Math.abs(w - plan.streetWidthM) < 0.1)).toBe(true);
        // The outer streets are narrower: only part of them lies in the pool.
        expect(Math.min(...widths)).toBeLessThan(plan.streetWidthM - 1);
        expect(definition.bound.site).toEqual(site);
    });

    it('fits the lanes chosen for one street width and leaves the others automatic', () => {
        const { site } = schellingStrips();
        const auto = RoadInSite.roadsInSite(site);
        const inner = auto.groups.find(group => Math.abs(group.widthM - 12) < 0.1);
        const core = [{ type: 'driving', width: 3, direction: 'backward' }, { type: 'driving', width: 3, direction: 'forward' }];
        const chosen = RoadInSite.roadsInSite(site, { cores: { [inner.key]: core } });
        expect(chosen.issues).toEqual([]);
        const definition = RoadInSite.boundedDefinition(chosen.roads[0]);
        const profiles = [definition.profile, ...Object.values(definition.segmentProfiles || {})];
        expect(profiles.some(profile => profile.strips.filter(s => s.type === 'driving').every(s => s.width === 3))).toBe(true);
    });

    it('refuses lanes that do not fit, naming the street width and the room they need', () => {
        const { site } = schellingStrips();
        const core = Array.from({ length: 4 }, () => ({ type: 'driving', width: 3.5, direction: 'forward' }));
        const planned = RoadInSite.roadsInSite(site, { core });
        const blocking = RoadInSite.blocking(planned.issues);
        expect(blocking[0]).toMatchObject({ code: 'core-too-wide', requiredM: 17 });
    });

    it('makes separate parts of a site separate roads, each bounded by its own part', () => {
        const site = { type: 'MultiPolygon', coordinates: [polygon([[0, 0], [100, 0], [100, 12], [0, 12]]).coordinates, polygon([[0, 50], [100, 50], [100, 62], [0, 62]]).coordinates] };
        const planned = RoadInSite.roadsInSite(site);
        expect(planned.roads).toHaveLength(2);
        expect(planned.roads[0].site.coordinates).toEqual(site.coordinates[0]);
        expect(planned.roads[1].site.coordinates).toEqual(site.coordinates[1]);
    });

    it('refuses a curved site', () => {
        const ring = [];
        for (let k = 0; k <= 20; k += 1) { const t = k / 20 * Math.PI / 2; ring.push([100 * Math.cos(t), 100 * Math.sin(t)]); }
        for (let k = 20; k >= 0; k -= 1) { const t = k / 20 * Math.PI / 2; ring.push([88 * Math.cos(t), 88 * Math.sin(t)]); }
        expect(RoadInSite.blocking(RoadInSite.roadsInSite(polygon(ring)).issues)[0].code).toBe('not-a-grid');
    });

    it('places the readable strips of a selection and names the ragged one it leaves out', () => {
        const arc = [];
        for (let k = 0; k <= 20; k += 1) { const t = k / 20 * Math.PI / 2; arc.push([300 + 100 * Math.cos(t), 100 * Math.sin(t)]); }
        for (let k = 20; k >= 0; k -= 1) { const t = k / 20 * Math.PI / 2; arc.push([300 + 88 * Math.cos(t), 88 * Math.sin(t)]); }
        const site = { type: 'MultiPolygon', coordinates: [polygon([[0, 0], [100, 0], [100, 12], [0, 12]]).coordinates, polygon(arc).coordinates] };
        expect(RoadInSite.blocking(RoadInSite.roadsInSite(site).issues)[0].code).toBe('not-a-grid');
        const planned = RoadInSite.roadsInSite(site, { skipUnreadable: true });
        expect(RoadInSite.blocking(planned.issues)).toEqual([]);
        expect(planned.roads).toHaveLength(1);
        expect(planned.issues).toEqual([{ code: 'skipped', reason: 'not-a-grid', part: 1 }]);
    });
});

// Two street strips of real Schelling layouts (metres), where the pool boundary slants along a
// street: HR-339164-2952 (a 12 m street narrowing to nothing, a stub beyond) and HR-339270-6803
// (a north-south street with one straight kerb).
const WEDGE_STRIPS = {
    'HR-339164-2952': [[-70.6, 7.1], [-55.6, 0.3], [-45.4, -2.5], [-37.3, -4.9], [58.5, -4.9], [58.5, -26.6], [64.5, -27.4], [70.5, -28], [70.5, -6.3], [56.3, -4.6], [39.4, -1.4], [15, 3.6], [-1.1, 7.1], [-50.9, 7.1], [-50.9, 23.2], [-63, 27.9], [-63, 7.1]],
    'HR-339270-6803': [[-25.4, 20.4], [-17.3, 3.8], [-6.1, -16.5], [-2, -23], [4.7, -36.1], [4.7, -34], [25.4, -34], [19.7, -22], [4.7, -22], [4.7, 10.2], [0.2, 19.9], [-16.5, 33.9], [-21.4, 35.1], [-25.4, 36.2]]
};

describe('ragged street strips', () => {
    const lanesOf = road => {
        const definition = RoadInSite.boundedDefinition(road);
        return Footprint.laneFootprintIn(definition, Footprint.frameForDefinition(definition));
    };

    it('stops the lanes at a slanted end, inside the strip', () => {
        const site = polygon([[0, 0], [100, 0], [90, 12], [0, 12]]);
        const [road] = RoadInSite.roadsInSite(site).roads;
        const outside = turf.difference(turf.feature(lanesOf(road)), turf.feature(site));
        expect(outside ? turf.area(outside) : 0).toBeLessThan(0.05);
    });

    Object.entries(WEDGE_STRIPS).forEach(([id, ring]) => {
        it(`places ${id}'s strip as streets that do not meet, each a road on its own share`, () => {
            const site = polygon(ring);
            const planned = RoadInSite.roadsInSite(site);
            expect(planned.issues).toEqual([]);
            expect(planned.roads).toHaveLength(2);
            const lands = planned.roads.map(road => turf.feature(road.site));
            expect(lands.reduce((sum, land) => sum + turf.area(land), 0)).toBeCloseTo(turf.area(turf.feature(site)), 0);
            const shared = turf.intersect(lands[0], lands[1]);
            expect(shared ? turf.area(shared) : 0).toBeLessThan(0.01);
            planned.roads.forEach((road, k) => {
                const outside = turf.difference(turf.feature(lanesOf(road)), lands[k]);
                expect(outside ? turf.area(outside) : 0).toBeLessThan(0.05);
            });
        });
    });

    // Schelling strips of HR-340715-2010/1 and HR-340715-2917 (metres): street ends run into a
    // slanted boundary or the land of the street beside them.
    const RAGGED_ENDS = {
        'HR-340715-2010/1': [[-16.2, 14.7], [-1, 14.7], [-1, -80.1], [11, -62.9], [11, -38.9], [8.2, 26.7], [-1, 36.2], [-1, 26.7], [-8.9, 26.7]],
        'HR-340715-2917': [[-23.7, -1.5], [-0.5, -20.9], [-0.2, -20.4], [14.4, -1.5], [8.5, -1.5], [8.5, 10.1], [0.3, 16.9], [-3.5, 20.1], [-3.5, -1.5]]
    };
    const Fit = require('../../frontend/js/proposals/corridor-site-fit.js');

    it('places only roads its own edit check accepts: a dead end stops where its lanes have room', () => {
        const sites = [...Object.values(WEDGE_STRIPS), ...Object.values(RAGGED_ENDS), [[0, 0], [100, 0], [90, 12], [0, 12]]].map(polygon);
        let roads = 0;
        sites.forEach(site => RoadInSite.roadsInSite(site).roads.forEach(road => {
            roads += 1;
            expect(Fit.boundedRoadIssues(RoadInSite.boundedDefinition(road))).toEqual([]);
        }));
        expect(roads).toBe(8);
    });

    it('leaves a split strip disconnected without turf to share it out', () => {
        const saved = globalThis.turf;
        globalThis.turf = undefined;
        try {
            expect(RoadInSite.blocking(RoadInSite.roadsInSite(polygon(WEDGE_STRIPS['HR-339164-2952'])).issues)[0].code).toBe('disconnected');
        } finally {
            globalThis.turf = saved;
        }
    });
});

// Cadastral parcel HR-339164-2952 (WGS84), whose Schelling layout leaves one ragged strip.
const PARCEL_2952 = { type: 'Polygon', coordinates: [[[15.966418155,45.804398113],[15.966507594,45.804368568],[15.966699509,45.804305038],[15.966714834,45.804316897],[15.966782213,45.804293637],[15.967205347,45.804159472],[15.967335398,45.804134344],[15.967490345,45.804102224],[15.967591173,45.804079029],[15.96779562,45.804036701],[15.967978359,45.80400417],[15.968129472,45.803982828],[15.968299245,45.803960943],[15.968522326,45.803934178],[15.968657038,45.803919328],[15.968749107,45.803910758],[15.968836779,45.803904507],[15.968937689,45.803899577],[15.969020309,45.803896992],[15.969109213,45.803896415],[15.96925239,45.80389789],[15.969274775,45.803897904],[15.969303008,45.803932497],[15.969299935,45.803958037],[15.969300195,45.803971266],[15.969300358,45.803981164],[15.969301024,45.804019409],[15.969301287,45.804032367],[15.969301337,45.804040735],[15.969299339,45.804074918],[15.968892603,45.804095163],[15.968644748,45.804115966],[15.968426543,45.804144014],[15.968113096,45.804189525],[15.967846016,45.804229672],[15.96755077,45.804295691],[15.967283194,45.804360759],[15.966928723,45.804458264],[15.966642098,45.804550955],[15.966391948,45.804650114],[15.96617027,45.80473159],[15.966132947,45.804692634],[15.966064743,45.804721289],[15.966060315,45.804726937],[15.96604839,45.804709335],[15.966025167,45.804675664],[15.966011971,45.804656437],[15.965955045,45.804568531],[15.966261853,45.804464148],[15.966322123,45.804444454],[15.966426272,45.804410389],[15.966418155,45.804398113]]] };

describe('a split strip in its parcel', () => {
    const Arrangement = require('../../frontend/js/proposals/parcel-arrangement.js');

    it('arranges the parcel whichever of the strip\'s roads is placed first', () => {
        const pool = turf.feature(PARCEL_2952);
        const plan = Grid.planFor({ lat: turf.centroid(pool).geometry.coordinates[1] });
        const strip = Layouts.schellingPlots(pool, plan, null, { turf, SchellingGrid: Grid }).plots.find(plot => plot.source === 'schelling-remainder').geometry;
        const planned = RoadInSite.roadsInSite(strip);
        expect(planned.roads).toHaveLength(2);
        [[0], [1], [0, 1]].forEach(set => {
            const takes = set.map(k => ({ id: `take-${k}`, geometry: planned.roads[k].site }));
            expect(Arrangement.fabricOver([{ id: 'HR-339164-2952', feature: pool }], takes).failed).toEqual([]);
        });
    });
});

describe('the bounded record', () => {
    const site = polygon([[0, 0], [120, 0], [120, 12], [0, 12]]);
    const definition = () => RoadInSite.boundedDefinition(RoadInSite.roadsInSite(site).roads[0]);

    it('keeps its bound through the stored OSM form', () => {
        const view = OsmForm.toView(OsmForm.toRecord(definition()));
        expect(view.bound.site).toEqual(site);
    });

    it('takes its site as its land, whatever its lanes cut', () => {
        const built = Footprint.materialize(definition());
        expect(built.polygon).toEqual(site);
        expect(built.constructionFrame.algorithm).toBe(Footprint.BOUNDED_ALGORITHM);
        const lanes = Footprint.laneFootprintIn(definition(), Footprint.frameForDefinition(definition()));
        expect(turf.area(turf.feature(lanes))).toBeLessThan(turf.area(turf.feature(site)) + 1);
    });
});

describe('MCP: a road drafted into a parcel', async () => {
    const { intentDesign, intentEditing, appTurf } = await import('../agents/mcp-geometry.js');
    const outline = polygon([[0, 0], [120, 0], [120, 100], [108, 100], [108, 12], [0, 12]]);
    const draft = () => intentDesign.build({ kind: 'road', bounded: true, site: outline, drivingSide: 'right', authoredAt: '2026-10-29T00:00:00Z' }, { turf: appTurf });

    it('builds a road whose site and land are the outline', () => {
        const record = draft();
        expect(record.site).toEqual(outline);
        expect(record.roadProposal.definition.bound.site).toEqual(outline);
        expect(record.roadProposal.definition.osm.elements.filter(e => e.type === 'way')).toHaveLength(2);
    });

    it('changes its lanes with set_profile, refusing lanes the parcel has no room for', () => {
        expect(() => intentDesign.modify(draft(), [{ type: 'set_profile', preset: '2+2' }], { turf: appTurf })).toThrow(/17 m/);
        const narrow = intentDesign.modify(draft(), [{ type: 'set_profile', lanes: [{ type: 'driving', width: 3, direction: 'both' }] }], { turf: appTurf });
        expect(narrow.site).toEqual(outline);
        expect(() => intentDesign.modify(draft(), [{ type: 'shift', metres: 2, toward: 'north' }], { turf: appTurf })).toThrow(/keeps its parcel/);
    });

    it('drafts each road of a strip whose streets do not meet with part', () => {
        const strip = polygon(WEDGE_STRIPS['HR-339164-2952']);
        const build = part => intentDesign.build({ kind: 'road', bounded: true, site: strip, part, drivingSide: 'right', authoredAt: '2026-10-29T00:00:00Z' }, { turf: appTurf });
        expect(() => build(undefined)).toThrow(/part 0–1/);
        const lands = [0, 1].map(part => build(part).roadProposal.definition);
        const sites = lands.map(definition => OsmForm.toView(definition).bound.site);
        expect(turf.area(turf.feature(sites[0])) + turf.area(turf.feature(sites[1]))).toBeCloseTo(turf.area(turf.feature(strip)), 0);
        expect(() => build(2)).toThrow(/part 0–1/);
    });

    it('refuses an OSM edit that moves a node off the parcel, and one that changes the parcel', () => {
        const original = draft();
        const moved = JSON.parse(JSON.stringify(original));
        const node = moved.roadProposal.definition.osm.elements.find(e => e.type === 'node');
        const [lng, lat] = at(60, 80);
        Object.assign(node, { lon: lng, lat });
        expect(() => intentEditing.reconcile(moved, original, [{ op: 'replace', path: '/roadProposal/definition/osm' }], appTurf)).toThrow(/stays inside that parcel/);
        const regrounded = JSON.parse(JSON.stringify(original));
        regrounded.roadProposal.definition.bound.site = polygon([[0, 0], [200, 0], [200, 12], [0, 12]]);
        expect(() => intentEditing.reconcile(regrounded, original, [{ op: 'replace', path: '/roadProposal/definition/bound' }], appTurf)).toThrow(/keeps its parcel/);
    });
});
