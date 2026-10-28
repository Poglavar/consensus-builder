// Cover the create dialog's urban-rule typology choices.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

const BLOCK_PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235'];

async function installBlockGround(page: import('@playwright/test').Page): Promise<void> {
  const features = structuredClone(sampleParcels.features.slice(0, 2));
  features[1].geometry.coordinates[0].forEach(point => { if (point[0] === 15.9826) point[0] = 15.9825; });
  await page.route('**/parcels**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !/\/parcels(?:\/parcelIds)?$/.test(url.pathname)) return route.continue();
    const requested = url.searchParams.get('ids')?.split(',');
    return route.fulfill({ json: { type: 'FeatureCollection', features: features.filter(feature => !requested || requested.includes(feature.properties.parcelId)) } });
  });
}

async function openFreshProposalFromBlock(page: import('@playwright/test').Page): Promise<void> {
  await installBlockGround(page);
  await openCity(page);
  await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Urban-rule control tester');
  await page.locator('#welcome-submit-btn').click();

  // Use the real block inspector's Create proposal button, which opens an unrestricted fresh
  // proposal form. Forking an existing Park opens a replacement form and correctly locks its
  // land-use radio buttons, so it cannot exercise the three typology choices.
  const center = await page.evaluate(id => {
    const layer = (window as any).ParcelPresenter.getLayer(id);
    const point = layer.getBounds().getCenter();
    (window as any).map.panTo(point, { animate: false });
    return { lat: point.lat, lng: point.lng };
  }, BLOCK_PARCEL_IDS[1]);
  const screen = await page.evaluate(({ lat, lng }) => {
    const point = (window as any).map.latLngToContainerPoint([lat, lng]);
    const rect = (window as any).map.getContainer().getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  }, center);
  await page.mouse.click(screen.x, screen.y);
  // The click stack's parcel section opens on the parcel panel's Info tab.
  await expect(page.locator('#click-stack .click-stack__section[data-kind="parcels"] #parcel-info-panel')).toBeVisible();
  await page.locator('#layers-button').click();
  const tools = page.locator('#layers-sheet details.accordion-section[data-section="blocks"]');
  if (!(await tools.evaluate((element: HTMLDetailsElement) => element.open))) await tools.locator('> summary').click();
  await tools.locator('[onclick="animateFloodfillFromSelected()"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await tools.locator('[onclick="countBlocks()"]')
    .click();
  await expect.poll(() => page.evaluate(() => (window as any).blockStorage.blocks.size)).toBeGreaterThan(0);
  await page.locator('#showBlockListButton').click();
  await page.locator('#blocks-content .block-item').first().click();
  await expect(page.locator('#layers-sheet')).toBeHidden();
  await expect(page.locator('#block-info-panel')).toBeVisible();
  await page.locator('#block-proposals-tab-button').click();
  await page.locator('#block-proposals-content').getByRole('button', { name: 'Create design', exact: true }).click();
  await expect(page.locator('.create-proposal-modal:visible')).toBeVisible();
}

test.describe('proposal button controls fifth pass @features', () => {
  test('urban-rule typology shows the three real block, row, and parcel-based choices', async ({ mockApi: page }) => {
    await openFreshProposalFromBlock(page);
    const dialog = page.locator('.create-proposal-modal:visible');
    const group = dialog.locator('#proposalTypologyGroup');
    await expect(group).toBeHidden();
    await dialog.locator('.proposal-radio:has(input[name="proposalLandUse"][value="urban-rule"])').click();
    await expect(group).toBeVisible();

    for (const typology of ['block', 'row', 'parcelBased']) {
      const option = group.locator(`.proposal-typology-button[data-proposal-typology="${typology}"]`);
      await expect(option).toBeVisible();
      await option.click();
      await expect(option).toHaveAttribute('aria-pressed', 'true');
      await expect(group.locator('.proposal-typology-button[aria-pressed="true"]')).toHaveCount(1);
      await expect.poll(() => page.evaluate(() => (window as any).proposalFacets?.landUse)).toBe('urban-rule');
    }
  });
});
