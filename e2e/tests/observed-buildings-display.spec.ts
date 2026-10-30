import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import { openLayerSection } from '../helpers/layers';

// Zagreb lists DGU and OpenStreetMap for comparison: outlining one draws its buildings as reference
// outlines, from its own cells, and shows every existing building so the outlines have company.
for (const reference of ['osm', 'dgu']) {
  for (const display of [{ existing: 'solid', scope: 'surviving' }, { existing: 'off', scope: 'removed' }]) {
    test(`outlining ${reference} reveals its buildings from ${display.existing}/${display.scope}`, async ({ mockApi: page }) => {
      await stubBasemapTiles(page);
      await page.route('**/buildings/cell', route => {
        const body = route.request().postDataJSON();
        if (body.kind !== 'footprints') return route.fallback();
        return route.fulfill({ json: { supported: true, kind: body.kind, bbox: body.bbox, complete: true,
          items: body.source === reference ? [{ id: 'survey-one', geometry: PARCEL_GEOMETRY }] : [] } });
      });
      await page.goto(`/?city=zg&reduceMotion=1&at=45.80025,15.9822,18&existing=${display.existing}&existingScope=${display.scope}`, { waitUntil: 'domcontentloaded' });
      await openLayerSection(page, 'buildings');
      await page.locator('#showBuildings').check();
      const outline = (on: boolean) => page.evaluate(([id, on]) => {
        const w = window as any;
        const list = w.CityConfigManager.getBuildingSources().map((entry: any) => (entry.id === id ? { ...entry, outline: on } : entry));
        w.SourceList.save(w.CityConfigManager.getCurrentCityId(), list, w);
      }, [reference, on] as const);
      await outline(true);
      const shape = page.locator('.leaflet-observedReferences-pane path').first();
      await expect(shape).toBeVisible();
      expect(await page.evaluate(() => (window as any).PlanningViews.getState())).toMatchObject({
        existing: display.existing === 'off' ? 'ghost' : 'solid', existingScope: 'all',
      });
      expect(new URL(page.url()).searchParams.get('existingScope')).toBe('all');
      await outline(false);
      await expect(shape).toBeHidden();
    });
  }
}

test('observed buildings start off and retain a faint contrasting fill when shown', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await page.route('**/buildings/cell', route => {
    const body = route.request().postDataJSON();
    if (body.kind !== 'footprints') return route.fallback();
    return route.fulfill({ json: { supported: true, kind: body.kind, bbox: body.bbox, complete: true, items: [{ id: 'survey-one', geometry: PARCEL_GEOMETRY }] } });
  });
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
  await expect(row).toContainText('Buildings');
  await page.locator('#planning-views-button').click();
  await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'solid');
  await expect(page.locator('.leaflet-observedBuildings-pane path').first()).toBeVisible();
});
