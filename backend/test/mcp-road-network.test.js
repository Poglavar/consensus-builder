// MCP road composition must commit the same shared junctions and land as the map editor.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { appTurf as turf, intentDesign, corridorRuntime } from '../agents/mcp-geometry.js';
import { authorPlanRoads } from '../agents/mcp-road-network.js';
import { cidOfObject, designObject, agreementObject, communityRule, noMoney } from '../agents/agreement-objects.js';
import { createUrbanGameTheoryTools } from '../agents/ugt-agent-tools.js';
import { deriveAgreementGround } from '../agents/mcp-ground.js';

const require = createRequire(import.meta.url);
const { buildCorridorJunctionSet, corridorSegmentEntries } = require('../../frontend/js/corridor-profile.js');
const time = '2026-10-24T00:00:00.000Z';
const road = (points, title = 'Street') => {
    const content = intentDesign.build({ kind: 'road', city: 'birmingham', points, title, width: 7.5, authoredAt: time }, { turf });
    return { cid: cidOfObject(content), content };
};
const digbeth = () => [
    road([[-1.880016725476338, 52.47886329498563], [-1.880011832795665, 52.4806658184481]], 'Spine Street'),
    road([[-1.881083063504772, 52.479174563726865], [-1.8797053898578264, 52.47917317410462]], 'Garden Street'),
    road([[-1.8800900346350649, 52.480216399444934], [-1.8794034296804665, 52.48021570313436]], 'North Street')
];
const view = row => corridorRuntime.osm.toView(row.content.roadProposal.definition);
const junctions = rows => buildCorridorJunctionSet(rows.map(row => ({ corridorId: row.cid, entries: corridorSegmentEntries(view(row)) })));
const area = geometry => turf.area(turf.feature(geometry));
function withDefinition(row, edit) {
    const definition = view(row);
    edit(definition);
    const material = corridorRuntime.footprint.materialize(definition);
    Object.assign(definition, material);
    return designObject({ ...row.content, createdAt: time, site: material.polygon,
        roadProposal: { definition: corridorRuntime.osm.toRecord(definition) } });
}

describe('MCP plan road authoring', () => {
    it('forms both actual Digbeth crossroads, saves both sides and includes corner land', () => {
        const input = digbeth(), before = structuredClone(input);
        expect(junctions(input)).toHaveLength(0);
        const result = authorPlanRoads(input, time);
        expect(input).toEqual(before);
        expect(junctions(result.designs).map(j => j.degree)).toEqual([4, 4]);
        expect(result.designs.map(row => view(row).segments.length)).toEqual([3, 2, 2]);
        expect(result.designs.map(row => view(row).junctions.length)).toEqual([2, 1, 1]);
        expect(result.changes).toHaveLength(3);
        result.designs.forEach((row, index) => {
            expect(row.content.origin.cid).toBe(input[index].cid);
            expect(row.cid).not.toBe(input[index].cid);
            expect(area(row.content.site)).toBeGreaterThan(area(input[index].content.site) + 1);
            const replay = corridorRuntime.footprint.materialize(view(row));
            expect(replay.polygon).toEqual(row.content.site);
        });
        const repeated = authorPlanRoads(JSON.parse(JSON.stringify(result.designs)), '2026-10-25T00:00:00.000Z');
        expect(repeated.changes).toEqual([]);
        expect(repeated.designs).toEqual(result.designs);
    });

    it('clears foreign arms when a street is removed from the authored composition', () => {
        const connected = authorPlanRoads(digbeth(), time).designs;
        const remaining = authorPlanRoads([connected[0]], time);
        expect(view(remaining.designs[0]).junctions).toBeUndefined();
        expect(area(remaining.designs[0].content.site)).toBeLessThan(area(connected[0].content.site));
        expect(remaining.changes).toHaveLength(1);
    });

    it('keeps a surface near-miss and an elevated crossing disconnected', () => {
        const east = road([[-1.881, 52.4795], [-1.879, 52.4795]]);
        const north = road([[-1.88, 52.479], [-1.88, 52.48]]);
        const bridge = withDefinition(north, d => {
            d.points.forEach(segment => segment.forEach(point => { point.level = 1; }));
            d.segments = structuredClone(d.points);
        });
        expect(authorPlanRoads([east, bridge], time).changes).toEqual([]);
        const near = road([[-1.88, 52.47951], [-1.88, 52.48]]);
        expect(authorPlanRoads([east, near], time).changes).toEqual([]);
    });

    it('preserves explicitly protected tunnel edges', () => {
        const roads = digbeth().slice(0, 2);
        roads[0] = withDefinition(roads[0], d => {
            const key = p => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`;
            d.tunnels = [{ edgeKey: d.points[0].map(key).sort().join('|') }];
        });
        const result = authorPlanRoads(roads, time);
        expect(result.changes).toEqual([]);
        expect(view(result.designs[0]).segments).toHaveLength(1);
    });

    it('does not mistake coincident authored vertices on different levels for a junction', () => {
        const east = road([[-1.881, 52.4795], [-1.88, 52.4795], [-1.879, 52.4795]]);
        const north = withDefinition(road([[-1.88, 52.479], [-1.88, 52.4795], [-1.88, 52.48]]), d => {
            d.points.forEach(segment => segment.forEach(point => { point.level = 1; }));
            d.segments = structuredClone(d.points);
        });
        const result = authorPlanRoads([east, north], time);
        expect(result.changes).toEqual([]);
        expect(result.designs.every(row => !view(row).junctions)).toBe(true);
    });

    it('normalizes a self-crossing agent stroke and keeps unrelated content unchanged', () => {
        const star = road([[-1.881, 52.479], [-1.879, 52.48], [-1.881, 52.48], [-1.879, 52.479]]);
        const park = { cid: 'park', content: { structureProposal: { kind: 'park' } } };
        const result = authorPlanRoads([star, park], time);
        expect(junctions([result.designs[0]])).toHaveLength(1);
        expect(result.designs[1]).toBe(park);
        expect(result.changes).toHaveLength(1);
    });
});

describe('MCP agreement wiring', () => {
    it('binds the revised road sites and commits their CIDs, while inspection preserves its input', async () => {
        const input = digbeth();
        const sites = [];
        const geometry = turf.bboxPolygon([-1.882, 52.478, -1.878, 52.481]).geometry;
        const parcels = [{ type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry }];
        const tools = createUrbanGameTheoryTools({ mode: 'hosted', env: {}, fetchImpl: async (url, options) => {
            const path = new URL(url).pathname;
            if (path === '/designs/binding') {
                sites.push(JSON.parse(options.body).site);
                return Response.json({ parcelSourceId: 'test', binding: { coverage: 'complete', parcels: [{ parcelId: 'A' }], unsurveyedM2: 0, unknownM2: 0 } });
            }
            if (path === '/parcel-sources/test') return Response.json({ complete: true, features: parcels });
            throw new Error(`Unexpected read or publication: ${path}`);
        } });
        const plan = await tools.draftAgreement({ designs: input, currency: 'GBP', createdAt: time });
        expect(plan.roadChanges).toHaveLength(3);
        expect(plan.agreement.designs.map(d => d.cid)).toEqual(plan.designs.map(d => d.cid));
        expect(sites).toEqual(plan.designs.map(d => d.content.site));
        expect(junctions(plan.designs).map(j => j.degree)).toEqual([4, 4]);
        sites.length = 0;
        const inspected = await tools.inspectPlan({ plan, filter: { kind: 'piece' } });
        expect(inspected.items.length).toBeGreaterThan(0);
        expect(sites).toEqual(plan.designs.map(d => d.content.site));
        const widened = await tools.editPlan({ plan, expectedCid: plan.cid, operations: [
            { type: 'modify', ref: `design:${plan.designs[0].cid}`, changes: [{ type: 'widen', metres: 2, side: 'both' }] }
        ] });
        expect(widened.changes).toHaveLength(3);
        expect(widened.changes.every(change => widened.designs.some(row => row.cid === change.afterCid))).toBe(true);
        expect(junctions(widened.designs).map(j => j.degree)).toEqual([4, 4]);
        expect(view(widened.designs[0]).width).toBeCloseTo(9.5, 2);
        const removed = await tools.editPlan({ plan, expectedCid: plan.cid, operations: [
            { type: 'remove', ref: `design:${plan.designs[1].cid}` },
            { type: 'remove', ref: `design:${plan.designs[2].cid}` }
        ] });
        expect(removed.changes.some(c => c.type === 'road-junctions' && c.beforeCid === plan.designs[0].cid)).toBe(true);
        expect(view(removed.designs[0]).junctions).toBeUndefined();
        expect(removed.agreement.designs[0].cid).toBe(removed.designs[0].cid);

        // Inspecting an already-published unconnected plan must replay its original land exactly,
        // not quietly invoke the new authoring path and invalidate the committed output hashes.
        const originalLand = await deriveAgreementGround({ designs: input.map(row => ({ ...row, parcelIds: ['A'] })), parcels });
        const original = agreementObject({ city: 'birmingham', createdAt: time,
            designs: input.map(row => ({ cid: row.cid, goal: row.content.goal, title: row.content.title })),
            parcels: originalLand.inputs.parcels.map(p => ({ ...p, parcelSourceId: 'test' })),
            openGroundM2: originalLand.inputs.openGroundM2, outputs: originalLand.outputs,
            money: noMoney('GBP'), rule: communityRule() });
        sites.length = 0;
        const oldRead = await tools.inspectPlan({ plan: { agreement: original.content, designs: input }, filter: { kind: 'piece' } });
        expect(oldRead.cid).toBe(original.cid);
        expect(oldRead.items.length).toBeGreaterThan(0);
        expect(sites).toEqual(input.map(row => row.content.site));
        expect(junctions(input)).toHaveLength(0);
    });
});
