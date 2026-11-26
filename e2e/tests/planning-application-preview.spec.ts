// Download design offers "Planning application (Open Digital Planning)" where the city's jurisdiction
// has a submission target (planning-sources.json submissionTargets, js/planning/application-preview.js),
// and not elsewhere. The preview shows the red line and figures of the design and downloads the red line.
import { readFileSync } from 'node:fs';
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, placeFreeformBuilding, showProposal, stubBasemapTiles, answerBlockScope } from '../helpers/runtime';

test('a design in an English jurisdiction previews its planning application @features', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await answerBlockScope(page);
  await placeFreeformBuilding(page);
  await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²', { timeout: 20_000 });
  await page.locator('#single-building-confirm').click();
  const saved = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.goal === 'single' && p.applied) || null);
  await expect.poll(saved, { timeout: 20_000 }).not.toBeNull();
  const record = await saved();
  await showProposal(page, record.proposalId);
  const download = page.locator('#click-stack').getByRole('button', { name: 'Download', exact: true });
  const dialog = page.locator('.cb-dialog').filter({ hasText: 'Download design' });
  const entry = dialog.getByRole('button', { name: 'Planning application (Open Digital Planning)', exact: true });

  // This city has no English rule set, so no submission target and no entry.
  await download.click();
  await expect(dialog.locator('[data-plan-file-action="cityjson"]')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (window as any).PlanningRestrictionFeed.submissionTarget((window as any).CityConfigManager.getCurrentCityId()))).toBeNull();
  await expect(entry).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The same city under England's rule set gets the entry.
  await page.evaluate(() => {
    const cities = (window as any).CityConfigManager;
    cities.getCityConfig(cities.getCurrentCityId()).planning = { ruleSetIds: ['gb-eng-planning'] };
  });
  await download.click();
  await expect(entry).toBeVisible({ timeout: 15_000 });
  await entry.click();
  const preview = page.locator('.cb-dialog').filter({ hasText: 'Planning application' }).filter({ has: page.locator('.plan-application') });
  await expect(preview).toContainText('Open Digital Planning format, used by PlanX, BOPS');
  await expect(preview.locator('[data-application-figure="redLine"]')).toContainText('m²');
  await expect(preview.locator('[data-application-figure="buildings"]')).toHaveText('1');
  await expect(preview.locator('[data-application-figure="tallest"]')).toContainText('storeys');
  await expect(preview.locator('.plan-application-attachments li')).toHaveText(['Proposed site plan', '3D views of the design']);
  await expect(preview).toContainText('Publish the design to give the application a permanent link.');
  await expect(preview.getByRole('link', { name: 'Ask for it for your council' })).toHaveAttribute('href', '/feedback.html');

  const file = page.waitForEvent('download');
  await preview.getByRole('button', { name: 'Download red line (GeoJSON)', exact: true }).click();
  const redLine = await file;
  expect(redLine.suggestedFilename()).toMatch(/\.red-line\.geojson$/);
  const feature = JSON.parse(readFileSync(await redLine.path(), 'utf8'));
  expect(feature).toMatchObject({ type: 'Feature', properties: { format: 'gb-eng-odp-application' } });
  expect(feature.geometry.type).toMatch(/Polygon$/);
  expect(feature.properties.areaM2).toBeGreaterThan(0);
});
