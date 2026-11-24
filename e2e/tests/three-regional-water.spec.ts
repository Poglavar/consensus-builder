import { test, expect } from '../helpers/fixtures';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { openLayerSection } from '../helpers/layers';

const target = { targetLat: 45.80025, targetLng: 15.9822, headingDeg: 0, pitchRad: -1.15, range: 160_000 };
const cameraParam = Object.values(target).join(',');

function tilePolygon(z: number, x: number, y: number) {
  const n = 2 ** z;
  const lng = (value: number) => value / n * 360 - 180;
  const lat = (value: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * value / n))) * 180 / Math.PI;
  const west = lng(x), east = lng(x + 1), south = lat(y + 1), north = lat(y);
  const dx = (east - west) * 0.2, dy = (north - south) * 0.2;
  return { type: 'Polygon', coordinates: [[
    [west + dx, south + dy], [east - dx, south + dy], [east - dx, north - dy],
    [west + dx, north - dy], [west + dx, south + dy]
  ]] };
}

function waterTiles(page: any) {
  return page.evaluate(() => {
    const scene = (window as any).getThreeModeInternals()?.scene;
    const names: string[] = [];
    scene?.traverse((object: any) => { if (object.name?.startsWith('WaterTile/')) names.push(object.name); });
    return names.sort();
  });
}

test('regional water follows a restored distant model view, changes detail, and obeys its layer toggle on a narrow screen', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBuildingScene(page);
  const requests: Array<{ z: number; x: number; y: number }> = [];
  await page.route('**/decor/layers**', route => route.fulfill({ json: { layers: ['water'] } }));
  await page.route('**/decor/water/tile/*/*/*', route => {
    const match = new URL(route.request().url()).pathname.match(/\/decor\/water\/tile\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) return route.fallback();
    const z = Number(match[1]), x = Number(match[2]), y = Number(match[3]);
    requests.push({ z, x, y });
    return route.fulfill({ json: { areas: [{ geometry: tilePolygon(z, x, y), kind: 'lake' }] } });
  });
  await page.route('**/decor/water?**', route => route.fulfill({ json: { areas: [] } }));
  await page.route('**/decor/green?**', route => route.fulfill({ json: { areas: [] } }));
  await page.route('**/decor/ground?**', route => route.fulfill({ status: 503, json: { error: 'not needed in this test' } }));

  await page.goto(`/?city=zg&at=45.80025,15.9822,18&3d&camera=${cameraParam}&rotate=0`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as any).getThree3DGeoView()?.range)).toBeGreaterThan(5_000);
  await expect.poll(() => page.evaluate(() => {
    const w = window as any, internals = w.getThreeModeInternals();
    return w.__threeSnapshotNavigation.groundFootprint(internals.camera, w.THREE, internals.xyToLatLng);
  })).not.toBeNull();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await expect.poll(() => waterTiles(page)).not.toEqual([]);
  expect(requests.some(request => request.z < 14)).toBe(true);
  expect((await waterTiles(page)).every(name => /^WaterTile\/\d+\/\d+\/\d+\/-?\d+$/.test(name))).toBe(true);

  const beforeZoom = requests.length;
  await page.evaluate(() => (window as any).applyThree3DGeoView({
    targetLat: 45.80025, targetLng: 15.9822, headingDeg: 0, pitchRad: -1.15, range: 12_000
  }));
  const regionalDetail = Math.max(...requests.slice(0, beforeZoom).map(tile => tile.z));
  await expect.poll(() => waterTiles(page).then(names => Math.max(...names.map((name: string) => Number(name.split('/')[1])))))
    .toBeGreaterThan(regionalDetail);

  await openLayerSection(page, 'scenery');
  const waterToggle = page.getByLabel('Water', { exact: true });
  await expect(waterToggle).toBeVisible();
  await waterToggle.uncheck();
  await expect.poll(() => waterTiles(page)).toEqual([]);
  await waterToggle.check();
  await expect.poll(() => waterTiles(page)).not.toEqual([]);
});
