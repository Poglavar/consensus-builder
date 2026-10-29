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
