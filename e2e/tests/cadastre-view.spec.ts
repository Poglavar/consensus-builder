import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, clickMapPoint, PARCEL_ID, proposalState } from '../helpers/runtime';
import { Page } from '@playwright/test';

// The original-cadastre toggle moved from the lower-left mode strip into the 2D Layers sheet
// (fbe3758d); the sheet is closed again so the map underneath takes the clicks.
async function toggleCadastreView(page: Page, pressed: boolean) {
  await page.locator('#layers-button').click();
  const toggle = page.locator('#layers-sheet #cadastre-view-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(pressed));
  await page.locator('#layers-sheet [data-sheet-close]').click();
  await expect(page.locator('#layers-sheet')).toBeHidden();
}

test('consumed ground remains reachable through proposal breadcrumbs and the cadastral map', async ({ mockApi: page }) => {
  await openCity(page);
  const original = await page.evaluate(id => JSON.stringify((window as any).CadastralParcelRepository.get(id)), PARCEL_ID);
  const id = await createSpace(page, 'park');
  const proposal = await proposalState(page, id);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(false);
  await showProposal(page, id);
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator(`.claim-breadcrumb-link[title="${PARCEL_ID}"]`).click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  await expect(page.locator('#parcel-info-title')).toContainText('1234');
  await expect(page.locator('#proposal-details-panel')).toBeHidden();
  await page.locator('.parcel-tab-btn').filter({ hasText: 'Proposals' }).click();
  await expect(page.locator('#proposals-content')).toContainText(/park/i);
  await page.locator('#parcel-info-panel .close-button').click();
  await toggleCadastreView(page, true);
  await expect(page.locator('body')).toHaveClass(/cadastre-view/);
  const paths = () => page.evaluate(() => (window as any).map.getPane('cadastreViewPane').querySelectorAll('path').length);
  await expect.poll(paths).toBeGreaterThan(0);
  await clickMapPoint(page, 15.9822, 45.80025);
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
  await expect(page.locator('#parcel-info-title')).toContainText('1234');
  await page.locator('#parcel-info-panel .close-button').click();
  await toggleCadastreView(page, false);
  await expect(page.locator('body')).not.toHaveClass(/cadastre-view/);
  await expect.poll(paths).toBe(0);
  expect(await page.evaluate(id => JSON.stringify((window as any).CadastralParcelRepository.get(id)), PARCEL_ID)).toBe(original);
  expect(await proposalState(page, id)).toEqual(proposal);
});
