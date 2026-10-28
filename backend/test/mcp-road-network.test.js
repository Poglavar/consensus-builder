// MCP road drafts and edits must commit the same shared junctions and land as the map editor.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { appTurf as turf, intentDesign, corridorRuntime } from '../agents/mcp-geometry.js';
import { joinEditedRoad, joinNewRoads } from '../agents/mcp-road-network.js';
import { cidOfObject, designObject } from '../agents/agreement-objects.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { resultSchemaFor } from '../agents/mcp-contracts.js';
import { markUntrusted } from '../agents/mcp-results.js';

const require = createRequire(import.meta.url);
const { buildCorridorJunctionSet, corridorSegmentEntries } = require('../../frontend/js/corridor-profile.js');
const time = '2026-10-24T00:00:00.000Z', later = '2026-10-25T00:00:00.000Z';
const build = (points, title = 'Street', authoredAt = time) => intentDesign.build({ kind: 'road', city: 'birmingham', points, title, width: 7.5, authoredAt }, { turf });
const road = (points, title) => { const content = build(points, title); return { cid: cidOfObject(content), content }; };
const spinePoints = [[-1.880016725476338, 52.47886329498563], [-1.880011832795665, 52.4806658184481]];
const gardenPoints = [[-1.881083063504772, 52.479174563726865], [-1.8797053898578264, 52.47917317410462]];
const northPoints = [[-1.8800900346350649, 52.480216399444934], [-1.8794034296804665, 52.48021570313436]];
const view = content => corridorRuntime.osm.toView(content.roadProposal.definition);
const junctions = rows => buildCorridorJunctionSet(rows.map((content, index) => ({ corridorId: String(index), entries: corridorSegmentEntries(view(content)) })));
const area = geometry => turf.area(turf.feature(geometry));
const row = content => ({ cid: cidOfObject(content), content });
function withDefinition(source, edit) {
    const definition = view(source.content);
    edit(definition);
    const material = corridorRuntime.footprint.materialize(definition);
    Object.assign(definition, material);
    return row(designObject({ ...source.content, createdAt: time, site: material.polygon,
        roadProposal: { definition: corridorRuntime.osm.toRecord(definition) } }).content);
}
// An edit is a later revision of the same road: new geometry, its source named by origin.cid.
const editOf = (before, points) => designObject({ ...build(points, before.title, later), origin: { cid: cidOfObject(before) }, createdAt: later }).content;

describe('MCP road junctions on draft', () => {
    it('joins a drafted road to a named road it crosses: junctions on both, the neighbour revised by origin.cid', () => {
        const spine = road(spinePoints, 'Spine Street'), before = structuredClone(spine);
        const garden = build(gardenPoints, 'Garden Street');
        expect(junctions([spine.content, garden])).toHaveLength(0);
        const result = joinNewRoads([garden], [spine], time);
        expect(spine).toEqual(before);
        const [drafted] = result.designs, [revision] = result.revisions;
        expect(junctions([revision.design, drafted]).map(j => j.degree)).toEqual([4]);
        expect(view(drafted).junctions).toHaveLength(1);
        expect(view(revision.design).junctions).toHaveLength(1);
        expect(view(revision.design).segments).toHaveLength(2);
        expect(revision.design.origin).toEqual({ cid: spine.cid });
        expect(revision.design.authoredAt).toBe(time);
        expect(result.changes).toEqual([{ type: 'road-junctions', beforeCid: spine.cid, afterCid: revision.cid, title: 'Spine Street' }]);
        expect(revision.cid).toBe(cidOfObject(revision.design));
        // Corner land for the kerb returns, rebuilt by the shared materializer.
        expect(area(revision.design.site)).toBeGreaterThan(area(spine.content.site) + 1);
        expect(area(drafted.site)).toBeGreaterThan(area(garden.site) + 1);
        expect(corridorRuntime.footprint.materialize(view(drafted)).polygon).toEqual(drafted.site);
        // Naming the revised neighbour again for a second street adds its junction; the first stays.
        const second = joinNewRoads([build(northPoints, 'North Street')], [row(revision.design)], time);
        expect(view(second.revisions[0].design).junctions).toHaveLength(2);
        expect(second.revisions[0].design.origin).toEqual({ cid: revision.cid });
        // Drafting the joined road again against its joined neighbour is a no-op.
        const repeated = joinNewRoads([drafted], [row(revision.design)], later);
        expect(repeated.changes).toEqual([]);
        expect(repeated.designs[0]).toBe(drafted);
    });

    it('revises nothing when the drafted road touches no named road', () => {
        const spine = road(spinePoints, 'Spine Street');
        const far = build([[-1.89, 52.47], [-1.889, 52.47]], 'Far Street');
        const result = joinNewRoads([far], [spine], time);
        expect(result.changes).toEqual([]);
        expect(result.revisions).toEqual([]);
        expect(result.designs[0]).toBe(far);
    });

    it('joins roads of one import with each other in turn', () => {
        const result = joinNewRoads([build(spinePoints, 'Spine Street'), build(gardenPoints, 'Garden Street')], [], time);
        expect(result.changes).toEqual([]);
        expect(junctions(result.designs).map(j => j.degree)).toEqual([4]);
        expect(result.designs.map(content => view(content).junctions.length)).toEqual([1, 1]);
        expect(result.designs.every(content => !content.origin)).toBe(true);
    });

    it('keeps a surface near-miss and an elevated crossing disconnected', () => {
        const east = build([[-1.881, 52.4795], [-1.879, 52.4795]]);
        const north = road([[-1.88, 52.479], [-1.88, 52.48]]);
        const bridge = withDefinition(north, d => {
            d.points.forEach(segment => segment.forEach(point => { point.level = 1; }));
            d.segments = structuredClone(d.points);
        });
        expect(joinNewRoads([east], [bridge], time).changes).toEqual([]);
        const near = road([[-1.88, 52.47951], [-1.88, 52.48]]);
        expect(joinNewRoads([east], [near], time).changes).toEqual([]);
    });

    it('preserves explicitly protected tunnel edges', () => {
        const spine = withDefinition(road(spinePoints), d => {
            const key = p => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
            d.tunnels = [{ edgeKey: d.points[0].map(key).sort().join('|') }];
        });
        const result = joinNewRoads([build(gardenPoints)], [spine], time);
        expect(result.changes).toEqual([]);
    });

    it('does not mistake coincident authored vertices on different levels for a junction', () => {
        const east = build([[-1.881, 52.4795], [-1.88, 52.4795], [-1.879, 52.4795]]);
        const north = withDefinition(road([[-1.88, 52.479], [-1.88, 52.4795], [-1.88, 52.48]]), d => {
            d.points.forEach(segment => segment.forEach(point => { point.level = 1; }));
            d.segments = structuredClone(d.points);
        });
        const result = joinNewRoads([east], [north], time);
        expect(result.changes).toEqual([]);
        expect(view(result.designs[0]).junctions).toBeUndefined();
    });

    it('normalizes a self-crossing agent stroke with no named roads', () => {
        const star = build([[-1.881, 52.479], [-1.879, 52.48], [-1.881, 52.48], [-1.879, 52.479]]);
        const result = joinNewRoads([star], [], time);
        expect(junctions([result.designs[0]])).toHaveLength(1);
        expect(result.changes).toEqual([]);
    });
});

describe('MCP road junctions on edit', () => {
    it('joins a road edited onto a named neighbour, revising the neighbour', () => {
        const spine = road(spinePoints, 'Spine Street');
        // North Street first stops short of Spine Street, then an edit extends it across.
        const before = joinNewRoads([build([[-1.8797, 52.480216], [-1.8794034296804665, 52.48021570313436]], 'North Street')], [spine], time);
        expect(before.changes).toEqual([]);
        const edited = editOf(before.designs[0], northPoints);
        const result = joinEditedRoad(before.designs[0], edited, [spine], later);
        expect(view(result.design).junctions).toHaveLength(1);
        expect(result.design.origin).toEqual({ cid: cidOfObject(before.designs[0]) });
        const [revision] = result.revisions;
        expect(view(revision.design).junctions).toHaveLength(1);
        expect(revision.design.origin).toEqual({ cid: spine.cid });
        expect(revision.design.authoredAt).toBe(later);
        expect(result.changes).toEqual([{ type: 'road-junctions', beforeCid: spine.cid, afterCid: revision.cid, title: 'Spine Street' }]);
        expect(junctions([revision.design, result.design]).map(j => j.degree)).toEqual([4]);
    });

    it('detaches a road edited off a named neighbour, and leaves an unmoved one alone', () => {
        const spine = road(spinePoints, 'Spine Street');
        const joined = joinNewRoads([build(gardenPoints, 'Garden Street')], [spine], time);
        const garden = joined.designs[0], neighbour = row(joined.revisions[0].design);
        const retitled = designObject({ ...garden, title: 'Garden Lane', origin: { cid: cidOfObject(garden) }, createdAt: later }).content;
        const unmoved = joinEditedRoad(garden, retitled, [neighbour], later);
        expect(unmoved.changes).toEqual([]);
        expect(unmoved.design).toBe(retitled);
        const moved = editOf(garden, [[-1.8799, 52.47917], [-1.8797, 52.47917]]);
        const result = joinEditedRoad(garden, moved, [neighbour], later);
        expect(view(result.design).junctions).toBeUndefined();
        expect(result.revisions).toHaveLength(1);
        expect(result.revisions[0].before.cid).toBe(neighbour.cid);
        expect(view(result.revisions[0].design).junctions).toBeUndefined();
    });
});

describe('MCP authoring tools place designs into the working plan', () => {
    const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async url => {
        if (new URL(url).pathname === '/designs/binding') return Response.json({ parcelSourceId: 'ground', binding: { coverage: 'complete', unknownM2: 0, parcels: [] } });
        throw new Error(`Unexpected request ${url}`);
    } });
    const draft = (points, title, plan) => tools.draftRoad({ city: 'birmingham', points, title, width: 7.5, authoredAt: time, ...(plan ? { plan } : {}) });
    const checked = (tool, answer) => resultSchemaFor(tool).parse(markUntrusted(answer));
    const members = answer => answer.plan.designs.map(member => member.cid);

    it('a first draft starts a private plan; a road drafted into it joins the plan road it crosses', async () => {
        const first = await draft(spinePoints, 'Spine Street');
        expect(first.placement).toEqual({ status: 'placed' });
        expect(members(first)).toEqual([first.cid]);
        expect(first.plan.plan.title).toBe('Spine Street');
        const answer = await draft(gardenPoints, 'Garden Street', first.plan);
        expect(view(answer.design).junctions).toHaveLength(1);
        const [junction] = answer.consequences.junctions;
        expect(junction).toMatchObject({ beforeCid: first.cid, title: 'Spine Street' });
        expect(members(answer)).toEqual(expect.arrayContaining([junction.afterCid, answer.cid]));
        expect(members(answer)).not.toContain(first.cid);
        expect(answer.plan.previousCid).toBe(first.plan.cid);
        expect(answer.changes).toBeUndefined();
        checked('ugt_draft_road', answer);
        const apart = await draft([[-1.89, 52.47], [-1.889, 52.47]], 'Far Street', answer.plan);
        expect(apart.consequences).toEqual({ removed: [], junctions: [], cuts: [] });
    });

    it('refuses a building on a plan road until the person agrees to displace it', async () => {
        const street = await draft(spinePoints, 'Spine Street');
        const outline = turf.bboxPolygon([-1.88012, 52.47960, -1.87990, 52.47980]).geometry;
        const house = { city: 'birmingham', outline, typology: 'freeform', height: 12, title: 'Corner house', authoredAt: later };
        const refused = await tools.draftBuilding({ ...house, plan: street.plan });
        expect(refused.placement).toMatchObject({ status: 'refused', code: 'ground-occupied', conflicts: [expect.objectContaining({ cid: street.cid })] });
        expect(refused.plan).toEqual({ cid: street.plan.cid, status: 'unchanged' });
        checked('ugt_draft_building', refused);
        const placed = await tools.draftBuilding({ ...house, plan: street.plan, displace: true });
        expect(placed.consequences.removed.map(member => member.cid)).toEqual([street.cid]);
        expect(members(placed)).toEqual([placed.cid]);
    });

    it('ugt_import_design places imported roads in turn: joined to the plan road and to each other', async () => {
        const street = await draft(spinePoints, 'Spine Street');
        const line = (coordinates, name) => ({ type: 'Feature', properties: { name, highway: 'residential' }, geometry: { type: 'LineString', coordinates } });
        const answer = await tools.importDesign({ format: 'geojson', city: 'birmingham', authoredAt: time, plan: street.plan,
            data: { type: 'FeatureCollection', features: [line(gardenPoints, 'Garden Street'), line(northPoints, 'North Street')] } });
        expect(answer.designs.map(row => view(row.design).junctions.length)).toEqual([1, 1]);
        const spine = answer.plan.designs.find(member => member.content.title === 'Spine Street');
        expect(view(spine.content).junctions).toHaveLength(2);
        expect(answer.plan.designs).toHaveLength(3);
        checked('ugt_import_design', answer);
    });

    it('ugt_edit_design replaces the edited member and re-derives its junctions against the plan roads', async () => {
        const street = await draft(spinePoints, 'Spine Street');
        const north = await draft([[-1.8797, 52.480216], [-1.8794034296804665, 52.48021570313436]], 'North Street', street.plan);
        expect(north.consequences.junctions).toEqual([]);
        const edits = [{ op: 'replace', path: '/roadProposal/definition/osm/elements/0/lon', value: northPoints[0][0] },
            { op: 'replace', path: '/roadProposal/definition/osm/elements/0/lat', value: northPoints[0][1] }];
        const answer = await tools.editDesign({ design: north.design, expectedCid: north.cid, edits, plan: north.plan });
        expect(view(answer.design).junctions).toHaveLength(1);
        expect(answer.design.origin).toEqual({ cid: north.cid });
        expect(answer.consequences.junctions).toEqual([expect.objectContaining({ beforeCid: street.cid })]);
        expect(members(answer)).not.toContain(north.cid);
        expect(members(answer)).toHaveLength(2);
        checked('ugt_edit_design', answer);
    });
});
