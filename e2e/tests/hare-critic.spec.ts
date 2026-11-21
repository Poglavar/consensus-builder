import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';

const builder = require('../../frontend/js/intent-design.js');
const turf = require('../../backend/node_modules/@turf/turf');

test('Hare separates lane grading from destination reachability and traces a chosen ride', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubBasemapTiles(page);
  await openCity(page);

  const lat = 45.80025, lng = 15.9817;
  const site = (x: number) => ({ type: 'Polygon', coordinates: [[
    [x, lat - 0.00015], [x + 0.00008, lat - 0.00015], [x + 0.00008, lat - 0.00009], [x, lat - 0.00009], [x, lat - 0.00015]
  ]] });
  const authoredAt = '2026-10-23T00:00:00.000Z';
  const home = builder.build({ kind: 'building', site: site(lng), city: 'zg', title: 'Starter homes', floors: 3, authoredAt }, { turf });
  const park = builder.build({ kind: 'space', spaceKind: 'park', site: site(lng + 0.001), city: 'zg', title: 'Library garden', authoredAt }, { turf });
  await page.addScriptTag({ url: '/js/intent-design.js' });
  const stored = await page.evaluate(async ({ home, park, lat, lng, authoredAt }) => {
    const w = window as any, apiBase = w.DesignSync.apiBase();
    const street = w.IntentDesign.build({ kind: 'road', points: [[lng - 0.0001, lat], [lng + 0.0013, lat]], city: 'zg',
      title: 'Riding street', preset: '1+1 with cycle lanes', authoredAt });
    const members = [home, park, street].map(content => w.DesignSync.localDesignFromRow({ cid: w.Cid.cidOfObject(content), content }, { apiBase }));
    const plan = w.PlanWorkspace.save(w.PlanComposition.create('Cycling test plan', members, w.MapShare.capture(w)));
    await w.ClickStack.showPlan(plan, { designs: members, draft: true });
    return { cid: plan.cid, snapshot: w.PersistentStorage.getItem('plan:' + plan.cid) };
  }, { home, park, lat, lng, authoredAt });
  const stack = page.locator('#click-stack');
  await stack.getByRole('tab', { name: 'Stats & analysis' }).press('Enter');
  const hare = stack.getByRole('button', { name: 'Hare Cycling', exact: true });
  await hare.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Hare · Cycling' });
  await expect(panel.getByRole('status')).toContainText('Cycling from Starter homes to Library garden');
  await expect(page.locator('.critic-tour-spotlight')).toHaveCount(1);
  const marker = page.locator('.critic-tour-marker--hare');
  const position = await marker.evaluate(el => (el as HTMLElement).style.transform);
  await expect.poll(() => marker.evaluate(el => (el as HTMLElement).style.transform)).not.toEqual(position);
  await expect(panel.locator('[data-hare="score"]')).toHaveText('70/100 lane quality');
  await expect(panel.getByRole('row', { name: /Parks & squares/ }).getByRole('cell')).toHaveText(['1 of 1', '1 of 1']);
  await panel.getByText('Inspect a ride', { exact: true }).press('Enter');
  await panel.getByRole('searchbox', { name: 'Find a residential building' }).fill('Starter');
  await panel.getByRole('combobox', { name: 'Destination', exact: true }).selectOption({ label: 'Library garden' });
  await expect(panel.locator('[data-hare="trip"]')).toHaveText(/min to Library garden/);
  await panel.getByRole('button', { name: 'Show on map', exact: true }).press('Enter');
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(hare).toBeFocused();
  expect(await page.evaluate(cid => (window as any).PersistentStorage.getItem('plan:' + cid), stored.cid)).toBe(stored.snapshot);
  const dog = stack.getByRole('button', { name: 'Dog Walkability' });
  await dog.press('Enter');
  const walking = page.getByRole('dialog', { name: 'Dog · Walkability' });
  await expect(walking.getByRole('status')).toContainText('Walking from Starter homes to Library garden');
  await expect(page.locator('.critic-tour-marker--dog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dog).toBeFocused();
  await expect(walking).toBeHidden();
  await expect(page.locator('.critic-tour-spotlight')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dog.press('Enter');
  await expect(walking.locator('[data-dog="score"]')).toBeVisible();
  await expect(walking.getByRole('button', { name: 'Skip animation' })).toHaveCount(0);
  await expect(page.locator('.critic-tour-marker--dog')).toHaveCount(0);
});
