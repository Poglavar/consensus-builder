// Night in the model view: setting the Sun and shadows clock to night darkens the sky light the
// ground is lit by and turns on the vehicles' headlamps and headlight pools; noon turns them off again.
import { test, expect } from '../helpers/fixtures';
import { PARCEL_ID } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { waitForMapReady } from '../helpers/app';
import { Page } from '@playwright/test';

// One residential street with pavements, so 3D life has vehicles to light.
const osmLifeWays = {
  type: 'FeatureCollection',
  source: 'e2e-night-fixture',
  features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[15.9808, 45.80025], [15.9837, 45.80025]] },
    properties: { osm_id: 88101, highway_type: 'residential', width_meters: 10, tags: { highway: 'residential', sidewalks: 'both' } },
  }],
};

// The sky light (hemisphere) and the Life group's vehicle lamps (three-life.js creates its instanced
// meshes in the order bodies, glass, wheels, heads, torsos, arms, legs, lamps, pools; optional
// animal meshes are appended after them).
async function nightState(page: Page) {
  return page.evaluate(() => {
    const scene = (window as any).getThreeModeInternals().scene;
    let hemi: any = null;
    scene.traverse((object: any) => { if (!hemi && object.isHemisphereLight) hemi = object; });
    const life = scene.getObjectByName('Life');
    const meshes = life?.children.filter((o: any) => o.isInstancedMesh && o.userData?.isLife) || [];
    const lamps = meshes[7], pools = meshes[8];
    const ground = hemi?.groundColor;
    return {
      lifeMeshes: meshes.length,
      vehicles: meshes[0]?.count || 0,
      hemiIntensity: hemi?.intensity ?? null,
      groundLuma: ground ? (ground.r + ground.g + ground.b) / 3 : null,
      skyBlueOverRed: hemi ? hemi.color.b - hemi.color.r : null,
      lampsVisible: !!lamps?.visible,
      poolsVisible: !!pools?.visible,
      lampCount: lamps?.count || 0,
    };
  });
}

test('night darkens the ground light and switches on headlights; noon switches them off', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await page.route('**/osm-road**', route => route.fulfill({ json: osmLifeWays }));
  // 3D life moves only without reduced motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/?city=zg', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.waitForFunction(() => !!(window as any).CadastralParcelRepository && !!(window as any).LiveParcelFabric);
  await page.evaluate(async id => {
    const w = window as any;
    w.map.setView([45.80025, 15.9822], 18, { animate: false });
    await w.CadastralParcelRepository.ensureIds([id]);
  }, PARCEL_ID);

  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await nightState(page)).vehicles, { timeout: 20_000 }).toBeGreaterThan(0);

  await page.locator('#sun-button').click();
  const sheet = page.locator('#sun-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#sun-enabled')).toBeChecked();
  await sheet.locator('#sun-date').fill('2026-06-21');
  const slider = sheet.locator('#sun-time');

  // Noon: full sky light, no lamps.
  await slider.fill('720');
  await expect(sheet.locator('#sun-time-value')).toHaveText('12:00');
  await expect(page.locator('#sun-button')).toHaveAttribute('data-sun', 'day');
  await expect.poll(async () => (await nightState(page)).lampsVisible).toBe(false);
  const noon = await nightState(page);
  expect(noon.lifeMeshes).toBeGreaterThanOrEqual(9);
  expect(noon.poolsVisible).toBe(false);

  // 22:00 in June: the sun is well below the horizon.
  await slider.fill('1320');
  await expect(sheet.locator('#sun-time-value')).toHaveText('22:00');
  await expect(sheet.locator('#sun-status')).toHaveText('Night: the sun is below the horizon.');
  await expect(page.locator('#sun-button')).toHaveAttribute('data-sun', 'night');
  await expect.poll(async () => (await nightState(page)).lampsVisible, { timeout: 10_000 }).toBe(true);
  const night = await nightState(page);
  expect(night.poolsVisible).toBe(true);
  expect(night.lampCount).toBeGreaterThan(0);
  // The sky light falls to about a third of the day's and turns moonlit blue; the ground goes dark.
  expect(night.hemiIntensity!).toBeLessThan(noon.hemiIntensity! * 0.5);
  expect(night.groundLuma!).toBeLessThan(noon.groundLuma! * 0.6);
  expect(night.skyBlueOverRed!).toBeGreaterThan(noon.skyBlueOverRed! + 0.05);

  // Back to noon: the lamps go out and the sky light is the day's again.
  await slider.fill('720');
  await expect.poll(async () => (await nightState(page)).lampsVisible).toBe(false);
  const again = await nightState(page);
  expect(again.poolsVisible).toBe(false);
  expect(again.hemiIntensity).toBeCloseTo(noon.hemiIntensity!, 5);
});
