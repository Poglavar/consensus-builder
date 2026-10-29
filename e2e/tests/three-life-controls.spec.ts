// Purpose: verify that people and traffic are usable through real 3D layer controls and stay on valid walkable ground.
import { test, expect } from '../helpers/fixtures';
import { createBuilding, PARCEL_ID } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { waitForMapReady } from '../helpers/app';

const osmLifeWays = {
  type: 'FeatureCollection',
  source: 'e2e-life-fixture',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[15.9808, 45.80025], [15.9837, 45.80025]] },
      properties: { osm_id: 88001, highway_type: 'residential', width_meters: 10, tags: { highway: 'residential', sidewalks: 'both' } },
    },
    {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[15.9820, 45.7999], [15.9820, 45.8006]] },
      properties: { osm_id: 88002, highway_type: 'footway', width_meters: 3, tags: { highway: 'footway' } },
    },
  ],
};

async function installLifeFixture(page: any) {
  await mockBuildingScene(page);
  await page.route('**/osm-road**', route => route.fulfill({ json: osmLifeWays }));
}

async function openLifeCity(page: any, url = '/?city=zg') {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.waitForFunction(() => {
    const w = window as any;
    return !!w.proposalStorage && !!w.CadastralParcelRepository && !!w.ParcelPresenter && !!w.ProposalManager;
  });
  await page.evaluate(async (id) => {
    const w = window as any;
    w.map.setView([45.80025, 15.9822], 18, { animate: false });
    await w.CadastralParcelRepository.ensureIds([id]);
  }, PARCEL_ID);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(true);
}

async function enter3D(page: any) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.()?.scene)).toBe(true);
}

async function openLifeLayers(page: any) {
  if (!(await page.locator('#model-layer-controls').isVisible())) await page.locator('#layers-button').click();
  await expect(page.locator('#model-layer-controls .three-mode-ui-panel')).toBeVisible();
}

async function lifeScene(page: any) {
  return page.evaluate(() => {
    const scene = (window as any).getThreeModeInternals().scene;
    const group = scene.getObjectByName('Life');
    const meshes = group?.children.filter((o: any) => o.isInstancedMesh && o.userData?.isLife) || [];
    return {
      groupVisible: !!group?.visible,
      meshCount: meshes.length,
      instanceCounts: meshes.map((mesh: any) => mesh.count),
      torsoCount: meshes[4]?.count || 0,
    };
  });
}

async function lifeTranslations(page: any) {
  return page.evaluate(() => {
    const group = (window as any).getThreeModeInternals().scene.getObjectByName('Life');
    const meshes = group?.children.filter((o: any) => o.isInstancedMesh && o.userData?.isLife) || [];
    const translations = (mesh: any) => {
      const values = mesh.instanceMatrix.array as Float32Array;
      const points = [];
      for (let i = 0; i < mesh.count; i++) {
        const offset = i * 16;
        if (values[offset + 15] === 0) continue;
        points.push([values[offset + 12], values[offset + 13], values[offset + 14]]);
      }
      return points;
    };
    return { vehicles: translations(meshes[0]), figures: translations(meshes[4]) };
  });
}

test.describe('3D people and traffic layer @features', () => {
  test('fixture streets generate people and vehicles; toggle and 2D re-entry follow the saved state', async ({ mockApi: page }) => {
    await installLifeFixture(page);
    await openLifeCity(page);
    await enter3D(page);
    await expect.poll(async () => (await lifeScene(page)).groupVisible).toBe(true);
    let population = await lifeScene(page);
    // Seven body/figure draws plus vehicle lamps and headlight pools (hidden by day).
    expect(population.meshCount).toBe(9);
    expect(population.instanceCounts[0]).toBeGreaterThan(1); // vehicle bodies
    expect(population.instanceCounts[3]).toBeGreaterThan(1); // heads: people and any riders
    expect(population.instanceCounts[4]).toBeGreaterThan(1); // walking/riding figures

    const initialTransforms = await lifeTranslations(page);
    await expect.poll(async () => {
      const current = await lifeTranslations(page);
      const hasMoved = (before: number[][], after: number[][]) => before.some((point, index) => {
        const next = after[index];
        return !!next && Math.hypot(point[0] - next[0], point[1] - next[1], point[2] - next[2]) > 0.01;
      });
      return hasMoved(initialTransforms.vehicles, current.vehicles)
        && hasMoved(initialTransforms.figures, current.figures);
    }, { timeout: 8000, intervals: [100, 250, 500] }).toBe(true);

    await openLifeLayers(page);
    const toggle = page.getByLabel('Show or hide schematic people and vehicles moving through the 3D view');
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => (await lifeScene(page)).groupVisible).toBe(false);

    await page.locator('#mode-2d-toggle').click();
    await expect(page.locator('#three-container')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive())).toBe(false);
    await enter3D(page);
    await openLifeLayers(page);
    const restoredToggle = page.getByLabel('Show or hide schematic people and vehicles moving through the 3D view');
    await expect(restoredToggle).not.toBeChecked();
    await expect.poll(async () => (await lifeScene(page)).groupVisible).toBe(false);
    await restoredToggle.click();
    await expect(restoredToggle).toBeChecked();
    await expect.poll(async () => (await lifeScene(page)).groupVisible).toBe(true);
    population = await lifeScene(page);
    expect(population.instanceCounts[0]).toBeGreaterThan(1);
    expect(population.instanceCounts[4]).toBeGreaterThan(1);
  });

  test('applied building footprints remain clear of spawned figures', async ({ mockApi: page }) => {
    await installLifeFixture(page);
    await openLifeCity(page);
    await createBuilding(page);
    await enter3D(page);
    await expect.poll(async () => (await lifeScene(page)).groupVisible).toBe(true);

    const result = await page.evaluate(() => {
      const w = window as any;
      const scene = w.getThreeModeInternals().scene;
      const group = scene.getObjectByName('Life');
      // three-life creates bodies, glass, wheels, heads, torsos, arms, legs in that order.
      const torsos = group.children.filter((o: any) => o.isInstancedMesh && o.userData?.isLife)[4];
      const proposals = w.proposedBuildings || [];
      if (!torsos || !proposals.length) return { figures: 0, footprints: proposals.length, inside: -1 };
      const points: Array<[number, number]> = [];
      const matrix = new w.THREE.Matrix4();
      for (let i = 0; i < torsos.count; i++) {
        torsos.getMatrixAt(i, matrix);
        if (matrix.elements[15] === 0) continue; // Empty instance slots use a zero matrix.
        const p = new w.THREE.Vector3().setFromMatrixPosition(matrix);
        group.localToWorld(p);
        const ll = w.getThreeModeInternals().xyToLatLng(p.x, p.y);
        if (ll) points.push([ll.lng, ll.lat]);
      }
      const footprints = proposals.map((feature: any) => feature.type === 'Feature' ? feature : {
        type: 'Feature', geometry: feature.geometry || feature, properties: {}
      });
      const inside = points.filter(point => footprints.some((feature: any) =>
        w.turf.booleanPointInPolygon(w.turf.point(point), feature))).length;
      return { figures: points.length, footprints: footprints.length, inside };
    });
    expect(result.footprints).toBeGreaterThan(0);
    expect(result.figures).toBeGreaterThan(0);
    expect(result.inside).toBe(0);
  });

  test('reduced motion suppresses the default crowd and the URL override enables it', async ({ mockApi: page }) => {
    await installLifeFixture(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await page.waitForFunction(() => !!(window as any).proposalStorage && !!(window as any).CadastralParcelRepository);
    await page.evaluate(async (id) => {
      const w = window as any;
      w.map.setView([45.80025, 15.9822], 18, { animate: false });
      await w.CadastralParcelRepository.ensureIds([id]);
    }, PARCEL_ID);
    await enter3D(page);
    await expect.poll(async () => page.evaluate(() => !!(window as any).getThreeModeInternals()?.scene.getObjectByName('Life'))).toBe(true);
    expect((await lifeScene(page)).groupVisible).toBe(false);

    await page.goto('/?city=zg&reduceMotion=1&life=1', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await page.waitForFunction(() => !!(window as any).proposalStorage && !!(window as any).CadastralParcelRepository);
    await page.evaluate(async (id) => {
      const w = window as any;
      w.map.setView([45.80025, 15.9822], 18, { animate: false });
      await w.CadastralParcelRepository.ensureIds([id]);
    }, PARCEL_ID);
    await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(true);
    await enter3D(page);
    await expect.poll(async () => (await lifeScene(page)).groupVisible).toBe(true);
    expect((await lifeScene(page)).instanceCounts[0]).toBeGreaterThan(1);
  });

  test('people and traffic control is reachable and works at phone width', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await installLifeFixture(page);
    await openLifeCity(page);
    await enter3D(page);
    await openLifeLayers(page);
    const toggle = page.getByLabel('Show or hide schematic people and vehicles moving through the 3D view');
    const hit = await toggle.evaluate((element: HTMLInputElement) => {
      const row = element.closest('label') as HTMLElement;
      const rect = row.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        && !!target && (target === row || row.contains(target));
    });
    expect(hit).toBe(true);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => (await lifeScene(page)).groupVisible).toBe(false);
  });
});
