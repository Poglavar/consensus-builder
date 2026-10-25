import { test, expect } from '../helpers/fixtures';
import { stubBasemapTiles } from '../helpers/runtime';
import { cidOfObject, fileDesign, pageIndex } from '../helpers/mocks/shared-server';
import { mockBuildingScene } from '../helpers/mocks/building-data';

const records = require('../../frontend/js/design-record.js');
const plans = require('../../frontend/js/plan-record.js');

for (const width of [1280, 390]) {
  test(`parcel-free shared plan retains every ground surface after repeat reloads at ${width}px`, async ({ mockApi: page }, testInfo) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 844 });
    await stubBasemapTiles(page);
    await mockBuildingScene(page);
    const index = pageIndex(page);
    index.cadastre = [];
    const cids = ['park', 'park', 'square', 'lake', 'single'].map((goal, i) => {
      const x = 15.9858 + (i % 3) * 0.0006, y = 45.8000 + Math.floor(i / 3) * 0.0006;
      const geometry = { type: 'Polygon', coordinates: [[[x, y], [x + 0.0004, y],
        [x + 0.0004, y + 0.0004], [x, y + 0.0004], [x, y]]] };
      return fileDesign(index, records.published({ title: `Courtyard ${goal} ${i}`, goal,
        city: 'courtyard-place-label', site: geometry, createdAt: '2026-10-25T00:00:00Z',
        ...(goal === 'single' ? {
          geometry: { buildings: [{ type: 'Feature', geometry,
            properties: { floors: 2, height: 6, type: 'proposedBuilding' } }] },
          buildingProposal: { typologyType: 'single', parameters: { floors: 2, height: 6 } }
        } : { structureProposal: { kind: goal, geometry } }) }));
    });
    const content = plans.create('Courtyard reload', cids, {
      city: null, at: '45.8005,15.9865,18', mode: 'model', language: 'en',
      settings: { existing: 'ghost', proposed: 'solid', permitted: 'off' }
    });
    const cid = cidOfObject(content);
    index.plans.set(cid, { cid, content });
    const state = () => page.evaluate(() => {
      const w = window as any, scene = w.getThreeModeInternals?.()?.scene;
      let parks = 0, squares = 0, lakeShores = 0, buildings = 0;
      scene?.traverseVisible((object: any) => {
        if (object.userData.isParkGround) parks++;
        if (object.userData.isSquareGround) squares++;
        if (object.userData.isLakeShore) lakeShores++;
        if (object.isMesh && object.userData.proposalId === w.__reloadBuildingId) buildings++;
      });
      const applied = w.proposalStorage?.getAllProposals().filter(w.isApplied) || [];
      return { applied: applied.length, bound: applied.flatMap((p: any) => p.cadastreParcelIds || []).length,
        runtimeParks: w.parks?.length, runtimeSquares: w.squares?.length, runtimeLakes: w.lakes?.length,
        parks, squares, lakeShores, hasBuilding: buildings > 0 };
    });
    await page.addInitScript(id => { (window as any).__reloadBuildingId = id; }, `design-${cids[4]}`);
    await page.goto(`/plans/${cid}?city=zg&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
    for (let arrival = 0; arrival < 3; arrival++) {
      if (arrival) await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 30000 });
      await expect.poll(state, { timeout: 30000 }).toEqual({ applied: 5, bound: 0,
        runtimeParks: 2, runtimeSquares: 1, runtimeLakes: 1,
        parks: 2, squares: 1, lakeShores: 1, hasBuilding: true });
    }
    await page.screenshot({ path: testInfo.outputPath(`restored-surfaces-${width}.png`) });
  });
}
