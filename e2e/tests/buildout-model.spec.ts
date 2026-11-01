// The build-out timeline in the model view: at the clock's month a design not started is absent and
// the context it replaces still stands, one under construction draws its site (built floors, scaffold,
// crane or pit; the laid share of a road with the rest as earth; a ground filling with its cover),
// and closing the clock restores the normal scene. Nothing is unapplied
// (docs/buildout-timeline.md, three-mode.js build-out, buildout-parts.js).
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { closeParcel, drawCorridor, openBlockEditor, openCity, openParcel, showSelectionDesignTab, stubBasemapTiles } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { mockBuildingScene } from '../helpers/mocks/building-data';

// Rebuilds are cooperative and frame-driven; a loaded host needs longer than the default 5 s.
const slow = expect.configure({ timeout: 15_000 });

const TREES = [[15.9822, 45.80025], [15.9827, 45.8003]]; // the first stands in the road

async function createBuildingOn(page: Page, parcelId: string): Promise<string> {
  await openParcel(page, 'proposals', parcelId);
  await openBlockEditor(page);
  await page.locator('#btn-blockify-done').click();
  return appliedBuildingDesign(page, parcelId);
}

async function appliedBuildingDesign(page: Page, parcelId: string): Promise<string> {
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getAllProposals()
    .some((p: any) => p.applied && p.geometry?.buildings?.length && p.cadastreParcelIds?.includes(id)), parcelId)).toBe(true);
  return page.evaluate(id => String((window as any).proposalStorage.getAllProposals()
    .find((p: any) => p.applied && p.geometry?.buildings?.length && p.cadastreParcelIds?.includes(id)).proposalId), parcelId);
}

// Row houses over the sample block: an urban rule with one house per parcel.
async function createRowHouses(page: Page): Promise<string> {
  await openParcel(page, 'proposals', 'HR-335754-1234');
  await page.locator('.multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await closeParcel(page);
  await showSelectionDesignTab(page);
  await page.locator('.parcel-build-btn--row').click();
  await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#btn-rowhouse-done').click();
  const proceed = page.getByRole('button', { name: 'Proceed anyway' });
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
  return appliedBuildingDesign(page, 'HR-335754-1234');
}

async function setUp(page: Page): Promise<void> {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await page.route('**/decor/layers**', route => route.fulfill({ json: { layers: ['trees'] } }));
  await page.route(/\/decor\/near\?/, route => route.fulfill({ json: { trees: TREES } }));
  await openCity(page);
}

async function enterModel(page: Page): Promise<void> {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.()), { timeout: 30_000 }).toBe(true);
}

// What the model view draws of the build-out, read from the scene.
const drawn = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const out = { floors: {} as Record<string, number[]>, scaffolds: 0, pits: 0, cranes: 0, earth: {} as Record<string, number>,
    cover: {} as Record<string, number>, strips: 0, parkGround: 0, trees: [] as number[], building: 0 };
  w.getThreeModeInternals()?.scene.traverseVisible((o: any) => {
    const u = o.userData;
    if (u.buildoutFloors !== undefined) (out.floors[u.buildoutSite] ||= []).push(u.buildoutFloors);
    if (u.buildoutPart === 'scaffold') out.scaffolds += 1;
    if (u.buildoutPart === 'pit') out.pits += 1;
    if (u.buildoutCrane === 'mast') out.cranes += o.count;
    if (u.buildoutPart === 'earth') out.earth[u.buildoutSite] = (out.earth[u.buildoutSite] || 0) + 1;
    if (u.buildoutPart === 'cover') out.cover[u.buildoutSite] = (out.cover[u.buildoutSite] || 0) + 1;
    if (u.isCorridorStrip && !u.buildoutPart) out.strips += 1;
    if (u.isParkGround) out.parkGround += 1;
    if (o.isInstancedMesh && u.treeShadowStandIn) out.trees.push(o.count);
  });
  return out;
});

test.describe('Build-out in the model view @features', () => {
  test('a scheduled plan draws planned, under-construction and built designs and closing restores the scene', async ({ mockApi: page }) => {
    await setUp(page);
    const road = String(await drawCorridor(page, 'road'));
    await openParcel(page, 'proposals', 'HR-335754-1236');
    await page.locator('.parcel-build-btn--park').click();
    await slow.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.structureProposal?.kind === 'park' && p.applied))).toBe(true);
    const park = await page.evaluate(() => String((window as any).proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.kind === 'park').proposalId));
    const building = await createBuildingOn(page, 'HR-335754-1235');
    await page.evaluate(async ({ park, road, building }) => {
      const w = window as any;
      const records = [park, road, building].map(id => w.proposalStorage.getProposal(id));
      const cid = (record: any) => w.DesignRecord.cidOf(record);
      const row = w.PlanComposition.create('Phased model', records, w.MapShare.capture(w), {
        [cid(records[0])]: { start: '2027-03', end: '2027-06' },
        [cid(records[1])]: { start: '2027-05', end: '2027-08' },
        [cid(records[2])]: { start: '2027-01', end: '2027-12' },
      });
      w.PlanWorkspace.save(row);
      await w.ClickStack.showPlan(row, { designs: w.PlanComposition.localRecords(row, { apiBase: w.DesignSync.apiBase() }), draft: true });
    }, { park, road, building });
    await enterModel(page);
    // The model view's modules (buildout-parts.js) load with it.
    const storeys = await page.evaluate(id => {
      const w = window as any;
      const feature = w.proposedBuildings.find((f: any) => String(f.properties.proposalId) === id);
      const rule = feature.properties.urbanRule?.floorHeightM;
      return w.BuildoutParts.storeys(w.estimateBuildingHeightMeters(feature), rule > 0 ? rule : w.STOREY_HEIGHT_M);
    }, building);
    // The settled normal scene: road, park, the tree outside the road, no build-out sites.
    await slow.poll(async () => { const d = await drawn(page); return { strips: d.strips > 0, parkGround: d.parkGround > 0, trees: d.trees, floors: d.floors }; })
      .toEqual({ strips: true, parkGround: true, trees: [1, 1], floors: {} });
    const normal = await drawn(page);

    const at = async (month: string) => {
      await page.evaluate(month => (window as any).BuildoutClock.open(month), month);
      await slow.poll(() => page.evaluate(() => (window as any).BuildoutClock.month())).toBe(month);
    };
    // January 2027: the building is a pit with its crane; the road and park are not there yet, so the
    // tree the road clears still stands.
    await at('2027-01');
    await slow.poll(async () => { const d = await drawn(page); return { floors: d.floors[building], pits: d.pits, cranes: d.cranes, strips: d.strips, parkGround: d.parkGround, trees: d.trees }; })
      .toEqual({ floors: [Math.floor(storeys / 12)], pits: Math.floor(storeys / 12) === 0 ? 1 : 0, cranes: 1, strips: 0, parkGround: 0, trees: [2, 2] });

    // June: the building half up under scaffold, half the road laid and the rest earth, the park's
    // lawn finished but without its trees and furniture.
    await at('2027-06');
    await slow.poll(async () => { const d = await drawn(page); return { floors: d.floors[building], scaffolds: d.scaffolds, cranes: d.cranes, trees: d.trees, roadEarth: !!d.earth[road], parkCover: !!d.cover[park], parkEarth: !!d.earth[park], parkGround: d.parkGround }; })
      .toEqual({ floors: [Math.floor(storeys / 2)], scaffolds: Math.floor(storeys / 2) > 0 ? 1 : 0, cranes: 1, trees: [1, 1], roadEarth: true, parkCover: true, parkEarth: false, parkGround: 0 });
    expect((await drawn(page)).strips).toBeGreaterThan(0);

    // December: every floor stands, the top one still in scaffold, its open ground still earth; the
    // road and park are built.
    await at('2027-12');
    await slow.poll(async () => { const d = await drawn(page); return { floors: d.floors[building], scaffolds: d.scaffolds, cranes: d.cranes, earth: Object.keys(d.earth), parkGround: d.parkGround > 0 }; })
      .toEqual({ floors: [storeys], scaffolds: 1, cranes: 1, earth: [building], parkGround: true });

    // Back to now: exactly the normal scene, and nothing was unapplied.
    await page.evaluate(() => (window as any).BuildoutClock.close());
    await slow.poll(() => drawn(page)).toEqual(normal);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().every((p: any) => p.applied))).toBe(true);
  });

  test('a simulated build-out raises each building of an urban rule by its own window', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await setUp(page);
    const rule = await createRowHouses(page);
    const row = await page.evaluate(id => {
      const w = window as any;
      const row = w.PlanComposition.create('Rule build-out', [w.proposalStorage.getProposal(id)], w.MapShare.capture(w));
      w.PlanWorkspace.save(row);
      return row;
    }, rule);
    await enterModel(page);
    // A month where the rule's buildings are at different stages; each draws by its own state.
    const expected = await page.evaluate(async ({ row, id }) => {
      const w = window as any, S = w.BuildoutSchedule;
      await w.BuildoutClock.simulate(w.PlanWorkspace.list().find((r: any) => r.cid === row.cid), { seed: 'abc' });
      const proposal = w.proposalStorage.getProposal(id);
      const features = w.proposedBuildings.filter((f: any) => String(f.properties.proposalId) === id);
      const site = (feature: any) => {
        const state = w.BuildoutClock.stateOfBuilding(proposal, Number(feature.properties.buildingIndex));
        const height = feature.properties.urbanRule?.floorHeightM;
        return { phase: state.phase, floors: S.builtFloors(w.BuildoutParts.storeys(w.estimateBuildingHeightMeters(feature), height > 0 ? height : w.STOREY_HEIGHT_M), state) };
      };
      const span = S.range(w.BuildoutClock.plan().content);
      let month = null;
      for (let at = span.start; at <= span.end && !month; at = S.addMonths(at, 1)) {
        w.BuildoutClock.setMonth(at);
        const sites = features.map(site);
        if (new Set(sites.map((s: any) => s.phase)).size > 1 && sites.some((s: any) => s.phase === 'construction' && s.floors > 0)) month = at;
      }
      w.BuildoutClock.setMonth(month || span.start);
      const sites = features.map(site);
      const building = sites.filter((s: any) => s.phase === 'construction');
      return { simulated: w.BuildoutClock.plan().simulated, month, buildings: features.length, phases: [...new Set(sites.map((s: any) => s.phase))].length,
        floors: building.map((s: any) => s.floors).sort(), cranes: building.length };
    }, { row, id: rule });
    expect(expected).toMatchObject({ simulated: true });
    expect(expected.month).toBeTruthy();
    expect(expected.buildings).toBeGreaterThan(1);
    expect(expected.phases).toBeGreaterThan(1);
    await slow.poll(async () => { const d = await drawn(page); return { floors: (d.floors[rule] || []).sort(), cranes: d.cranes }; })
      .toEqual({ floors: expected.floors, cranes: expected.cranes });
    await page.evaluate(() => (window as any).BuildoutClock.close());
    await slow.poll(async () => { const d = await drawn(page); return { sites: Object.keys(d.floors).length, cranes: d.cranes }; }).toEqual({ sites: 0, cranes: 0 });
  });
});
