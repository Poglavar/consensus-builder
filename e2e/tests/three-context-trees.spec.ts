import { test, expect } from '../helpers/fixtures';
import { drawCorridor, openCity, stubBasemapTiles } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test('context trees clear applied road footprints and return on unapply without refetching', async ({ mockApi: page }, testInfo) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  const trees = [[15.9822, 45.80025], [15.9827, 45.8003]];
  let treeRequests = 0;
  await page.route('**/decor/layers**', route => route.fulfill({ json: { layers: ['trees'] } }));
  await page.route(/\/decor\/near\?/, route => {
    treeRequests++;
    return route.fulfill({ json: { trees } });
  });
  await openCity(page);
  const roadId = await drawCorridor(page, 'road');
  const source = await page.evaluate(id => {
    const w = window as any;
    const p = w.proposalStorage.getProposal(id);
    const footprint = w.collectProposalFeatureSets(p).primaryFeatures.find((f: any) => f.properties.source === 'road-definition');
    return { footprint, definition: JSON.stringify(p.roadProposal.definition) };
  }, roadId);
  expect(source.footprint).toBeTruthy();
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15_000 });
  const instances = () => page.evaluate(() => {
    const w = window as any;
    const counts: number[] = [];
    w.getThreeModeInternals?.()?.scene.traverseVisible((o: any) => {
      // Each drawn tree has one shadow stand-in trunk and crown, whatever its species or tier.
      if (o.isInstancedMesh && o.userData.treeShadowStandIn) counts.push(o.count);
    });
    return counts;
  });
  await expect.poll(instances).toEqual([1, 1]);
  const retained = await page.evaluate(() => {
    const w = window as any;
    const { scene, xyToLatLng } = w.getThreeModeInternals();
    let point: any;
    scene.traverseVisible((o: any) => {
      if (!o.isInstancedMesh || o.material.color.getHexString() !== '5c3d1e') return;
      const matrix = new w.THREE.Matrix4();
      o.getMatrixAt(0, matrix);
      point = xyToLatLng(matrix.elements[12], matrix.elements[13]);
    });
    w.ThreeClickStack.close();
    w.applyThree3DGeoView({ targetLat: 45.80025, targetLng: 15.9822, headingDeg: 20, pitchRad: -.7, range: 100 });
    return point;
  });
  expect(retained.lat).toBeCloseTo(trees[1][1], 6);
  expect(retained.lng).toBeCloseTo(trees[1][0], 6);
  await page.screenshot({ path: testInfo.outputPath('road-applied-tree-excluded.png') });
  const requestsAfterLoad = treeRequests;
  expect(requestsAfterLoad).toBeGreaterThan(0);
  await page.evaluate(async id => { await (window as any).ProposalManager.unapplyProposal(id); }, roadId);
  await expect.poll(instances).toEqual([2, 2]);
  await page.screenshot({ path: testInfo.outputPath('road-unapplied-tree-restored.png') });
  expect(treeRequests).toBe(requestsAfterLoad);
  await page.evaluate(async id => { await (window as any).ProposalManager.applyProposal(id); }, roadId);
  await expect.poll(instances).toEqual([1, 1]);
  expect(treeRequests).toBe(requestsAfterLoad);
  expect(await page.evaluate(id => JSON.stringify((window as any).proposalStorage.getProposal(id).roadProposal.definition), roadId)).toBe(source.definition);
});
