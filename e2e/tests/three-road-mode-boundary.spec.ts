// A selected road must not wake Leaflet editing/preloads behind 3D or continually replace buildings.
import { test, expect } from '../helpers/fixtures';
import { openCity, drawCorridor, stubBasemapTiles } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test.setTimeout(90000);

test('3D road selection keeps buildings stable, ground continuous and 2D handles suspended', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);
  const road = await drawCorridor(page, 'road');
  await page.evaluate(id => (window as any).selectAndHighlightProposal(id, null, false, false, true), road);
  await expect(page.locator('.road-node-handle')).toHaveCount(2);
  // openCity suppresses decorative motion; this regression must exercise the real pulsing outline.
  await page.evaluate(() => { (window as any).__reducedMotion = false; });
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('body')).toHaveClass(/three-mode-active/);
  await expect.poll(() => page.evaluate(() => (window as any).__mapModeState?.pending)).toBe(false);
  await expect(page.locator('.road-node-handle')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals()?.scene.traverseVisible((o: any) => { if (o.userData?.isNearbyBuilding3D) count++; });
    return count;
  })).toBeGreaterThan(0);

  const result = await page.evaluate(async id => {
    const w = window as any;
    let preloads = 0;
    let viewportFetches = 0;
    const original = w.ensureRoadOperationBuildings;
    const originalFetch = w.fetchBuildings;
    w.ensureRoadOperationBuildings = (...args: any[]) => { preloads++; return original(...args); };
    w.fetchBuildings = (...args: any[]) => { viewportFetches++; return originalFetch(...args); };
    w.showThreeModeDesign(id, null, { preserveView: true });
    w.map.fire('movestart');
    w.map.fire('moveend');
    w.map.fire('zoomend');
    const { scene } = w.getThreeModeInternals();
    const samples: any[] = [];
    const previous = scene.onAfterRender;
    try {
      await new Promise<void>(resolve => {
        const start = performance.now();
        scene.onAfterRender = (...args: any[]) => {
          previous?.apply(scene, args);
          const ids: number[] = [];
          scene.traverseVisible((o: any) => { if (o.userData?.isNearbyBuilding3D) ids.push(o.id); });
          const line = scene.getObjectByName('click-stack-focus')?.children.find((o: any) => o.userData?.selectionStroke === 'yellow');
          samples.push({ ids: ids.sort((a,b) => a-b).join(','), opacity: line?.material.opacity });
          if (performance.now() - start >= 3000 && samples.length >= 8) { scene.onAfterRender = previous; resolve(); }
        };
      });
      const pavement = scene.getObjectByName('ground-pavement');
      pavement.geometry.computeBoundingBox();
      const size = pavement.geometry.boundingBox.getSize(new w.THREE.Vector3());
      return { preloads, viewportFetches, samples, groundWidth: size.x, groundTriangles: pavement.geometry.index.count / 3 };
    } finally { scene.onAfterRender = previous; w.ensureRoadOperationBuildings = original; w.fetchBuildings = originalFetch; }
  }, road);
  expect(result.preloads).toBe(0);
  expect(result.viewportFetches).toBe(0);
  expect(new Set(result.samples.map(s => s.ids)).size).toBe(1);
  const opacity = result.samples.map(s => s.opacity).filter(Number.isFinite);
  expect(Math.max(...opacity) - Math.min(...opacity)).toBeGreaterThan(0.15);
  expect(result.groundWidth).toBeGreaterThan(100000);
  expect(result.groundTriangles).toBe(2);
  await page.locator('#mode-2d-toggle').click();
  await expect(page.locator('body')).not.toHaveClass(/three-mode-active/);
  await expect(page.locator('.road-node-handle')).toHaveCount(2);
});
