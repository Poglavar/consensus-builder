import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import { surveyResponse } from '../helpers/mocks/survey-data';
import { openLayerSection } from '../helpers/layers';

for (const reference of ['Osm', 'Dgu']) {
  for (const display of [{ existing: 'solid', scope: 'surviving' }, { existing: 'off', scope: 'removed' }]) {
    test(`enabling ${reference} reference buildings reveals them from ${display.existing}/${display.scope}`, async ({ mockApi: page }) => {
      await stubBasemapTiles(page);
      await page.route('**/buildings**', route => {
        const url = new URL(route.request().url());
        if (!['/buildings', '/buildings/osm'].includes(url.pathname)) return route.fallback();
        const features = [{
          type: 'Feature', properties: { object_id: 'survey-one', osm_id: 'w1', zgrada_id: 'cadastre-one' }, geometry: PARCEL_GEOMETRY,
        }];
        return route.fulfill({ json: url.pathname === '/buildings/osm'
          ? { type: 'FeatureCollection', features } : surveyResponse(features) });
      });
      await page.goto(`/?city=zg&reduceMotion=1&at=45.80025,15.9822,18&existing=${display.existing}&existingScope=${display.scope}`, { waitUntil: 'domcontentloaded' });
      await openLayerSection(page, 'buildings');
      const checkbox = page.locator(`#showBuildings${reference}`);
      await checkbox.check();
      const shape = page.locator('.leaflet-observedReferences-pane path').first();
      await expect(shape).toBeVisible();
      expect(await page.evaluate(() => (window as any).PlanningViews.getState())).toMatchObject({
        existing: display.existing === 'off' ? 'ghost' : 'solid', existingScope: 'all',
      });
      expect(new URL(page.url()).searchParams.get('existingScope')).toBe('all');
      await checkbox.uncheck();
      await expect(shape).toBeHidden();
    });
  }
}

test('observed buildings start off and retain a faint contrasting fill when shown', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.route('**/buildings?**', route => route.fulfill({json:surveyResponse([{type:'Feature',properties:{id:'survey-one',object_id:'survey-one'},geometry:PARCEL_GEOMETRY}])}));
  await openCity(page);
  expect(await page.evaluate(()=>(window as any).PlanningViews.getState().existing)).toBe('off');
  await expect(page.locator('#showBuildings')).not.toBeChecked();
  await page.locator('#planning-views-button').click();
  const built=page.locator('[data-planning-setting="existing"]');
  await selectNativeOption(built,'solid');
  const shape=page.locator('.leaflet-observedBuildings-pane path').first();
  await expect(shape).toBeVisible();
  const style=await shape.evaluate(element=>{
    const css=getComputedStyle(element);
    return {fill:css.fill,stroke:css.stroke,fillOpacity:Number(css.fillOpacity),strokeOpacity:Number(css.strokeOpacity)};
  });
  expect(style.fillOpacity).toBeGreaterThan(0);
  expect(style.fillOpacity).toBeLessThan(.25);
  expect(style.stroke).not.toEqual(style.fill);
  expect(style.strokeOpacity).toBeGreaterThan(.7);
  await selectNativeOption(built,'ghost');
  expect(await page.locator('.leaflet-observedBuildings-pane').evaluate(element=>Number(getComputedStyle(element).opacity))).toBe(.5);
  await selectNativeOption(built,'off');
  await expect(shape).toBeHidden();
});


test('NYC exposes its source footprints and can display them from the common endpoint', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.route('**/buildings/cell', route => route.fulfill({ json: {
    supported: true, complete: true, source: 'nyc-arcgis', count: 1,
    items: [{ id: '1079147', height_m: 36.57, floors: null, geometry: { type: 'Polygon', coordinates: [
      [[-74.0062,40.7127],[-74.0059,40.7127],[-74.0059,40.7129],[-74.0062,40.7129],[-74.0062,40.7127]]
    ] } }]
  } }));
  await page.goto('/?city=new_york&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => !!(window as any).PlanningViews)).toBe(true);
  const row = page.locator('#showBuildings').locator('..');
  await expect(row).not.toHaveAttribute('hidden');
  await expect(row).not.toHaveAttribute('data-feature-hidden');
  await expect(row).toContainText('Show buildings');
  await page.locator('#planning-views-button').click();
  await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'solid');
  await expect(page.locator('.leaflet-observedBuildings-pane path').first()).toBeVisible();
});
