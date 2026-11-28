import { expect, type Page } from '@playwright/test';

export async function openPlanningDisplay(page: Page): Promise<void> {
  if (!(await page.locator('#planning-views').isVisible())) await page.locator('#planning-views-button').click();
  const display = page.getByRole('tab', { name: 'Display', exact: true });
  if (await display.getAttribute('aria-selected') !== 'true') await display.click();
}

export async function openPlanningSection(page: Page, section: 'floor-plans' | 'building-appearance' | 'use-highlight'): Promise<void> {
  await openPlanningDisplay(page);
  const fold = page.locator(`#planning-${section}`);
  if (!(await fold.evaluate((element: HTMLDetailsElement) => element.open))) await fold.locator('> summary').click();
  await expect(fold).toHaveAttribute('open', '');
}

// Each Permitted/Built/Proposed row keeps its form, scope and source controls in a collapsed disclosure (7a9f5746e).
export async function openPlanningRole(page: Page, role: 'permitted' | 'existing' | 'proposed'): Promise<void> {
  await openPlanningDisplay(page);
  const disclosure = page.locator(`#planning-views .planning-layer-row[data-role="${role}"] details.planning-role-disclosure`);
  if (!(await disclosure.evaluate((element: HTMLDetailsElement) => element.open))) await disclosure.locator('> summary').click();
  await expect(disclosure).toHaveAttribute('open', '');
}

export async function openLayerSection(page: Page, section: string): Promise<void> {
  const sheet = page.locator('#layers-sheet');
  if (!(await sheet.isVisible())) await page.locator('#layers-button').click();
  if (section === 'buildings') {
    await sheet.locator('#layers-open-buildings').click();
    await expect(page.locator('#planning-existing-scope')).toBeVisible();
    return;
  }
  const fold = sheet.locator(`details.accordion-section[data-section="${section}"]`);
  if (!(await fold.evaluate((element: HTMLDetailsElement) => element.open))) await fold.locator('> summary').click();
  await expect(fold).toHaveAttribute('open', '');
}
