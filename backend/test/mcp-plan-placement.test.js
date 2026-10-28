// An agent's working plan is its applied map: placing a design joins roads, refuses ground another
// member holds unless displaced, and reports road cuts, with the browser's own apply rules.
import { describe, expect, it } from 'vitest';
import { appTurf as turf, intentDesign, corridorRuntime } from '../agents/mcp-geometry.js';
import { buildTypedDesign } from '../agents/mcp-constructors.js';
import { cidOfObject, designObject } from '../agents/agreement-objects.js';
import { placeInPlan } from '../agents/mcp-plan-placement.js';
import { createMcpNamedPlanTools } from '../agents/mcp-named-plans.js';
import { createMcpDraftTools } from '../agents/mcp-drafts.js';

const time = '2026-10-24T00:00:00.000Z', later = '2026-10-25T00:00:00.000Z';
const row = content => ({ cid: cidOfObject(content), content, parcelSourceId: null });
const road = (points, title, authoredAt = time) => row(intentDesign.build({ kind: 'road', city: 'birmingham', points, title, width: 7.5, authoredAt }, { turf }));
const box = (west, south, east, north) => ({ type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] });
const building = (site, title, authoredAt = time) => {
    const parcel = { type: 'Feature', id: 'A', properties: { parcelId: 'A' }, geometry: site };
    const content = buildTypedDesign({ kind: 'building', typology: 'freeform', site, height: 12, city: 'birmingham', title, authoredAt }, { parcels: [parcel] });
    return row(designObject({ ...content, createdAt: authoredAt }).content);
};
const park = (site, title, authoredAt = time) => row(intentDesign.build({ kind: 'space', spaceKind: 'park', city: 'birmingham', site, title, authoredAt }, { turf }));
const junctionCount = content => corridorRuntime.osm.toView(content.roadProposal.definition).junctions?.length || 0;

// Spine Street runs north–south; Garden Street crosses it east–west.
const spinePoints = [[-1.880016725476338, 52.47886329498563], [-1.880011832795665, 52.4806658184481]];
const gardenPoints = [[-1.881083063504772, 52.479174563726865], [-1.8797053898578264, 52.47917317410462]];
// A plot astride Spine Street, and one well clear of both streets.
const onSpine = box(-1.88012, 52.47960, -1.87990, 52.47980);
const clear = box(-1.87900, 52.47960, -1.87880, 52.47980);

describe('placing a design into a working plan', () => {
    it('joins a new road to the plan roads it crosses and swaps the revised neighbour into the plan', () => {
        const spine = road(spinePoints, 'Spine Street');
        const result = placeInPlan({ members: [spine], incoming: road(gardenPoints, 'Garden Street', later) });
        expect(result.placement.status).toBe('placed');
        const [neighbour] = result.consequences.junctions;
        expect(neighbour).toMatchObject({ beforeCid: spine.cid, title: 'Spine Street' });
        expect(result.members.map(member => member.cid)).toEqual([neighbour.afterCid, result.design.cid]);
        expect(junctionCount(result.members[0].content)).toBe(1);
        expect(junctionCount(result.design.content)).toBe(1);
        expect(result.consequences.removed).toEqual([]);
    });

    it('refuses a building on a plan road, naming the road, and leaves the plan as it was', () => {
        const spine = road(spinePoints, 'Spine Street');
        const result = placeInPlan({ members: [spine], incoming: building(onSpine, 'Corner house', later) });
        expect(result.placement).toMatchObject({ status: 'refused', code: 'ground-occupied' });
        expect(result.placement.conflicts).toEqual([expect.objectContaining({ cid: spine.cid, title: 'Spine Street' })]);
        expect(result.placement.conflicts[0].overlapM2).toBeGreaterThan(2);
        expect(result.placement.message).toMatch(/Spine Street/);
        expect(result.members).toEqual([spine]);
    });

    it('takes the road off the plan when the person chooses to displace it, as an explicit Apply does', () => {
        const spine = road(spinePoints, 'Spine Street');
        const house = building(onSpine, 'Corner house', later);
        const result = placeInPlan({ members: [spine], incoming: house, displace: true });
        expect(result.placement.status).toBe('placed');
        expect(result.consequences.removed.map(member => member.cid)).toEqual([spine.cid]);
        expect(result.members.map(member => member.cid)).toEqual([house.cid]);
    });

    it('refuses a road over a plan building', () => {
        const house = building(onSpine, 'Corner house');
        const result = placeInPlan({ members: [house], incoming: road(spinePoints, 'Spine Street', later) });
        expect(result.placement).toMatchObject({ status: 'refused', code: 'ground-occupied' });
        expect(result.placement.conflicts.map(member => member.cid)).toEqual([house.cid]);
    });

    it('lets a road cut through a plan park and reports the ground it takes', () => {
        const green = park(box(-1.88040, 52.47940, -1.87960, 52.48000), 'Spine Green');
        const result = placeInPlan({ members: [green], incoming: road(spinePoints, 'Spine Street', later) });
        expect(result.placement.status).toBe('placed');
        expect(result.consequences.removed).toEqual([]);
        expect(result.consequences.cuts).toEqual([expect.objectContaining({ designCid: green.cid, roadCid: result.design.cid })]);
        expect(result.consequences.cuts[0].overlapM2).toBeGreaterThan(50);
    });

    it('places a building clear of everything with no consequences', () => {
        const spine = road(spinePoints, 'Spine Street');
        const house = building(clear, 'Quiet house', later);
        const result = placeInPlan({ members: [spine], incoming: house });
        expect(result).toMatchObject({ placement: { status: 'placed' }, consequences: { removed: [], junctions: [], cuts: [] } });
        expect(result.members.map(member => member.cid)).toEqual([spine.cid, house.cid]);
    });

    it('replaces an edited member in place, without treating its own earlier revision as a rival', () => {
        const house = building(clear, 'Quiet house');
        const taller = building(clear, 'Quiet house, taller', later);
        const result = placeInPlan({ members: [house], incoming: taller, before: house.cid });
        expect(result.placement.status).toBe('placed');
        expect(result.members.map(member => member.cid)).toEqual([taller.cid]);
        expect(() => placeInPlan({ members: [house], incoming: taller, before: 'bafkreinotamember' })).toThrow(/not a member/);
    });

    it('lets an edit keep an overlap its earlier revision already had, and refuses only the conflicts it creates', () => {
        const spine = road(spinePoints, 'Spine Street');
        const house = building(onSpine, 'Corner house');
        const renamed = building(onSpine, 'Corner house, renamed', later);
        expect(placeInPlan({ members: [spine, house], incoming: renamed, before: house.cid }).placement.status).toBe('placed');
        const quiet = building(clear, 'Quiet house');
        const moved = building(onSpine, 'Quiet house, moved', later);
        expect(placeInPlan({ members: [spine, quiet], incoming: moved, before: quiet.cid }).placement).toMatchObject({ status: 'refused', code: 'ground-occupied' });
    });
});

describe('ugt_edit_plan places its operations in the working plan', () => {
    const read = { siteOfDesign: content => content.site, request: async path => { throw new Error(`Unexpected request ${path}`); } };
    const drafts = createMcpDraftTools({ read, appOrigin: 'https://app.example' });
    const tools = createMcpNamedPlanTools({ read, drafts, appOrigin: 'https://app.example' });
    const start = async (...designs) => tools.draftPlan({ title: 'Working plan', designs: designs.map(row => row.content) });
    const members = result => result.designs.map(member => member.cid);

    it('refuses an added building on a plan road until the operation displaces it', async () => {
        const spine = road(spinePoints, 'Spine Street');
        const plan = await start(spine);
        const house = building(onSpine, 'Corner house', later);
        await expect(tools.editPlan({ plan, expectedCid: plan.cid, operations: [{ type: 'add', design: house.content }] }))
            .rejects.toMatchObject({ code: 'ground-occupied', conflicts: [expect.objectContaining({ cid: spine.cid })] });
        const placed = await tools.editPlan({ plan, expectedCid: plan.cid, operations: [{ type: 'add', design: house.content, displace: true }] });
        expect(members(placed)).toEqual([house.cid]);
        expect(placed.consequences.removed.map(member => member.cid)).toEqual([spine.cid]);
    });

    it('joins an added road to the plan road it crosses and carries the revised neighbour', async () => {
        const spine = road(spinePoints, 'Spine Street');
        const plan = await start(spine);
        const placed = await tools.editPlan({ plan, expectedCid: plan.cid, operations: [{ type: 'add', design: road(gardenPoints, 'Garden Street', later).content }] });
        const [junction] = placed.consequences.junctions;
        expect(junction.beforeCid).toBe(spine.cid);
        expect(members(placed)).toContain(junction.afterCid);
        expect(members(placed)).not.toContain(spine.cid);
        expect(placed.designs.every(member => junctionCount(member.content) === 1)).toBe(true);
    });
});
