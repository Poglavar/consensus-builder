import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';

async function openDetails(page: any) {
  await openCity(page);
  await openParcel(page);
  await expect(page.locator('#info-tab')).toBeVisible();
}

test.describe('Parcel info panel tabs @core', () => {
  test('Info tab is active by default', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#info-tab')).toHaveClass(/active/);
    await expect(page.locator('#proposals-tab')).not.toHaveClass(/active/);
    await expect(page.locator('#tools-tab')).not.toHaveClass(/active/);
  });

  test('clicking Proposals tab shows proposals content', async ({ mockApi: page }) => {
    await openDetails(page);
    await page.locator('.parcel-tab-btn').filter({ hasText: 'Proposals' }).click();
    await expect(page.locator('#proposals-tab')).toHaveClass(/active/);
    await expect(page.locator('#info-tab')).not.toHaveClass(/active/);
    await expect(page.locator('#proposals-content')).toBeVisible();
  });

  test('clicking Tools tab shows claim controls', async ({ mockApi: page }) => {
    await openDetails(page);
    await page.locator('.parcel-tab-btn').filter({ hasText: 'Tools' }).click();
    await expect(page.locator('#tools-tab')).toHaveClass(/active/);
    await expect(page.locator('#tools-tab')).toBeVisible();
    await expect(page.locator('#claimButton')).toBeDisabled();
    await expect(page.locator('#mintAndClaimButton')).toBeDisabled();
  });

  test('switching back restores Info content', async ({ mockApi: page }) => {
    await openDetails(page);
    await page.locator('.parcel-tab-btn').filter({ hasText: 'Proposals' }).click();
    await expect(page.locator('#proposals-tab')).toHaveClass(/active/);
    await page.locator('.parcel-tab-btn').filter({ hasText: 'Info' }).click();
    await expect(page.locator('#info-tab')).toHaveClass(/active/);
    await expect(page.locator('#info-content')).toBeVisible();
  });

  test('multi-select checkbox is available in Info content', async ({ mockApi: page }) => {
    await openDetails(page);
    await expect(page.locator('#multiSelectCheckboxInfo')).toHaveAttribute('type', 'checkbox');
  });
});
