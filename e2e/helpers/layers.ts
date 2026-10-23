import { expect, type Page } from '@playwright/test';

export async function openLayerSection(page: Page, section: string): Promise<void> {
  const sheet = page.locator('#layers-sheet');
  if (!(await sheet.isVisible())) await page.locator('#layers-button').click();
  const fold = sheet.locator(`details.accordion-section[data-section="${section}"]`);
  if (!(await fold.evaluate((element: HTMLDetailsElement) => element.open))) await fold.locator('> summary').click();
  await expect(fold).toHaveAttribute('open', '');
}
