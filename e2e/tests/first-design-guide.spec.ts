// The getting-started hints of a first visit: they follow the newcomer from the map to a parcel,
// a tool and the first saved design, then stay away.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, expandStackSection, openCity } from '../helpers/runtime';

const SEEN_KEY = 'cb_site_intro_seen_v1';

test('a newcomer is led from the map to a parcel, a tool and a first saved design', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  // The shared fixture marks every visitor as returning; this one has never seen the hints.
  await page.addInitScript(key => {
    try { localStorage.removeItem(key); } catch (_) { /* opaque origin */ }
  }, SEEN_KEY);
  await openCity(page);
  const guide = page.locator('#first-design-guide');
  const seen = () => page.evaluate(key => localStorage.getItem(key), SEEN_KEY);

  await expect(guide).toHaveAttribute('data-step', 'click-parcel');
  await expect(guide).toContainText('Click any parcel');
  await expect(guide.getByRole('button', { name: 'How it works', exact: true })).toBeVisible();

  await clickMapPoint(page, 15.9822, 45.80025);
  await expandStackSection(page, 'parcels');
  await expect(guide).toHaveAttribute('data-step', 'pick-tool');
  expect(await seen()).toBeNull();

  await page.locator('#click-stack').getByRole('button', { name: 'Park', exact: true }).click();
  await page.getByRole('button', { name: 'Use this parcel', exact: true }).click();
  await expect(guide).toHaveAttribute('data-step', 'saved');
  await expect(guide).toContainText('Your first design is saved');
  await expect(guide.getByRole('button', { name: 'See it in 3D', exact: true })).toBeVisible();
  // Stored the moment the design exists, so a reload cannot start the hints again.
  expect(await seen()).toBe('1');

  await guide.getByRole('button', { name: 'Close getting started hints', exact: true }).click();
  await expect(guide).toHaveCount(0);
  // Closed for good: another parcel click brings nothing back.
  await clickMapPoint(page, 15.9822, 45.80025);
  await expect(page.locator('#click-stack')).toBeVisible();
  await expect(guide).toHaveCount(0);
});

test('a returning visitor sees no hints', async ({ mockApi: page }) => {
  await openCity(page);
  await clickMapPoint(page, 15.9822, 45.80025);
  await expandStackSection(page, 'parcels');
  await expect(page.locator('#click-stack').getByRole('button', { name: 'Park', exact: true })).toBeVisible();
  await expect(page.locator('#first-design-guide')).toHaveCount(0);
});
