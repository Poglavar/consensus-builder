import { test, expect } from '../helpers/fixtures';
import { openCity, createBuilding } from '../helpers/runtime';

test.describe('Plan arithmetic @features', () => {
  test('applied buildings yield floor area, housing, people and sales; assumptions recalculate the displayed totals', async ({ mockApi: page }) => {
    await openCity(page);
    await createBuilding(page);
    await page.locator('#proposals-button').click();
    // Plan-wide actions sit in the collapsed "Plan actions" group (fbe3758d).
    await page.locator('#proposal-list-actions > summary').click();
    await page.locator('#planStatsButton').click();
    const modal = page.locator('#plan-stats-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-plan-stat="scope"]')).toContainText('1 applied');
    const value = (key: string) => modal.locator(`[data-plan-stat="${key}"]`).innerText();
    const floorArea = await value('floor-area');
    expect(Number(floorArea.replace(/[^\d]/g, ''))).toBeGreaterThan(0);
    const sales = await value('sales-value');
    await modal.locator('#plan-stats-price').fill('10000');
    await modal.locator('#plan-stats-price').press('Tab');
    await expect.poll(() => value('sales-value')).not.toBe(sales);
    const apartments = await value('apartments');
    await modal.locator('#plan-stats-housing-share').fill('0');
    await modal.locator('#plan-stats-housing-share').press('Tab');
    await expect.poll(() => value('apartments')).toBe('0');
    expect(apartments).not.toBe('0');
    await expect.poll(() => value('people')).toBe('0');
    expect(await value('floor-area')).toBe(floorArea);
    await modal.locator('#plan-stats-housing-share').fill('100');
    await modal.locator('#plan-stats-efficiency').fill('100');
    await modal.locator('#plan-stats-apartment-size').fill('20');
    await modal.locator('#plan-stats-persons').fill('4');
    await modal.locator('#plan-stats-persons').press('Tab');
    await expect.poll(async () => Number((await value('people')).replace(/[^\d]/g, ''))).toBeGreaterThan(0);
    await modal.getByRole('button', { name: 'Close plan stats' }).click();
    await expect(modal).toBeHidden();
  });
});
