// MCP road drafts and edits must commit the same shared junctions and land as the map editor.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { appTurf as turf, intentDesign, corridorRuntime } from '../agents/mcp-geometry.js';
import { joinEditedRoad, joinNewRoads } from '../agents/mcp-road-network.js';
import { cidOfObject, designObject } from '../agents/agreement-objects.js';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';
import { createMcpAssetTools } from '../agents/mcp-assets.js';
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

describe('MCP road tools join the named corridors', () => {
    const read = { siteOfDesign: content => content.site, request: vi.fn(async path => {
        if (path === '/designs/binding') return { parcelSourceId: 'ground', binding: { coverage: 'complete', unknownM2: 0, parcels: [] } };
        throw new Error('Unexpected request');
    }) };
    const drafts = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
    const draft = (points, title, corridors) => drafts.draftRoad({ city: 'birmingham', points, title, width: 7.5, authoredAt: time, ...(corridors ? { corridors } : {}) });
    const checked = (tool, answer) => resultSchemaFor(tool).parse(markUntrusted(answer));

    it('ugt_draft_road returns the joined road, its revised neighbour and the change', async () => {
        const spine = (await draft(spinePoints, 'Spine Street')).design;
        const answer = await draft(gardenPoints, 'Garden Street', [spine]);
        expect(view(answer.design).junctions).toHaveLength(1);
        const [neighbour] = answer.revisedCorridors;
        expect(neighbour.design.origin).toEqual({ cid: cidOfObject(spine) });
        expect(view(neighbour.design).junctions).toHaveLength(1);
        expect(neighbour.cid).toBe(cidOfObject(neighbour.design));
        expect(answer.changes).toEqual([{ type: 'road-junctions', beforeCid: cidOfObject(spine), afterCid: neighbour.cid, title: 'Spine Street' }]);
        expect(checked('ugt_draft_road', answer).revisedCorridors[0].untrusted.design.origin.cid).toBe(cidOfObject(spine));
        const apart = await draft([[-1.89, 52.47], [-1.889, 52.47]], 'Far Street', [spine]);
        expect(apart).toMatchObject({ changes: [], revisedCorridors: [] });
        const park = (await drafts.draftSpace({ city: 'birmingham', outline: spine.site, spaceKind: 'park', authoredAt: time })).design;
        await expect(draft(gardenPoints, 'Garden Street', [park])).rejects.toMatchObject({ code: 'corridor-road-required' });
    });

    it('ugt_import_design joins imported roads to the named corridors and to each other', async () => {
        const spine = (await draft(spinePoints, 'Spine Street')).design;
        const tools = createMcpAssetTools({ read, drafts, appOrigin: 'https://app.example', apiBase: 'https://api.example' });
        const line = (coordinates, name) => ({ type: 'Feature', properties: { name, highway: 'residential' }, geometry: { type: 'LineString', coordinates } });
        const answer = await tools.importDesign({ format: 'geojson', city: 'birmingham', authoredAt: time, corridors: [spine],
            data: { type: 'FeatureCollection', features: [line(gardenPoints, 'Garden Street'), line(northPoints, 'North Street')] } });
        expect(answer.designs.map(row => view(row.design).junctions.length)).toEqual([1, 1]);
        expect(answer.changes).toHaveLength(1);
        expect(view(answer.revisedCorridors[0].design).junctions).toHaveLength(2);
        expect(answer.revisedCorridors[0].design.origin).toEqual({ cid: cidOfObject(spine) });
        checked('ugt_import_design', answer);
    });

    it('ugt_edit_design with corridors joins a road moved onto a named neighbour; without them it leaves junctions alone', async () => {
        const spine = (await draft(spinePoints, 'Spine Street')).design;
        const north = (await draft([[-1.8797, 52.480216], [-1.8794034296804665, 52.48021570313436]], 'North Street', [spine])).design;
        const edits = [{ op: 'replace', path: '/roadProposal/definition/osm/elements/0/lon', value: northPoints[0][0] },
            { op: 'replace', path: '/roadProposal/definition/osm/elements/0/lat', value: northPoints[0][1] }];
        const plain = await drafts.editDesign({ design: north, expectedCid: cidOfObject(north), edits });
        expect(view(plain.design).junctions).toBeUndefined();
        expect(plain.revisedCorridors).toBeUndefined();
        const answer = await drafts.editDesign({ design: north, expectedCid: cidOfObject(north), edits, corridors: [spine] });
        expect(view(answer.design).junctions).toHaveLength(1);
        expect(answer.design.origin).toEqual({ cid: cidOfObject(north) });
        expect(answer.revisedCorridors[0].design.origin).toEqual({ cid: cidOfObject(spine) });
        expect(answer.changes).toHaveLength(1);
        checked('ugt_edit_design', answer);
        const park = { city: 'birmingham', outline: spine.site, spaceKind: 'park', authoredAt: time };
        const space = (await drafts.draftSpace(park)).design;
        await expect(drafts.modifyDesign({ design: space, changes: [{ type: 'retitle', value: 'Park' }], corridors: [spine] }))
            .rejects.toMatchObject({ code: 'corridors-road-only' });
    });
});
