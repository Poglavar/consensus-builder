import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity } from '../helpers/runtime';

const SECTION_IDS = ['navigation', 'appearance', 'sources', 'economics', 'data', 'info', 'game', 'diagnostics'];

async function verifySettingsSections(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await openCity(page);
  await page.locator('#settings-button').click();
  const sheet = page.locator('#settings-sheet');
  await expect(sheet).toBeVisible();
  const body = sheet.locator(':scope > .map-sheet-body');
  const sections = body.locator(':scope > details.accordion-section');
  await expect(sections).toHaveCount(SECTION_IDS.length);
  expect(await sections.evaluateAll(elements => elements.map(element => element.getAttribute('data-section')))).toEqual(SECTION_IDS);
  await expect(sheet.locator('#data-source-select')).toHaveCount(0);

  for (const id of SECTION_IDS) {
    const section = body.locator(`:scope > details.accordion-section[data-section="${id}"]`);
    await expect(section).toHaveJSProperty('open', false);
    await expect(section.locator('details')).toHaveCount(0);
    const summary = section.locator(':scope > summary');
    await expect(summary).toBeVisible();
    await summary.click();
    await expect(section).toHaveJSProperty('open', true);
    const contentBoxes = await section.evaluate(element => Array.from(element.children)
      .filter(child => child.tagName !== 'SUMMARY')
      .map(child => child.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0).length);
    expect(contentBoxes, `section ${id} should expose content when expanded`).toBeGreaterThan(0);
    if (id !== 'diagnostics') {
      await expect(section.locator('button:visible, a[href]:visible, input:visible, select:visible, [role="button"]:visible').first()).toBeVisible();
    }
    if (id === 'data') {
      await expect(section.locator('summary')).toHaveText('Local (browser) data');
      await expect(section.locator('#showParcelCoverageButton')).toBeVisible();
      await expect(section.locator('#wipeLocalDataButton')).toBeVisible();
    }
    await expect(section.locator('details')).toHaveCount(0);
    await summary.click();
    await expect(section).toHaveJSProperty('open', false);
  }

  await sections.first().locator(':scope > summary').click();
  await expect(sections.first()).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.locator('#settings-button').click();
  await expect(sheet).toBeVisible();
  for (const id of SECTION_IDS) {
    await expect(body.locator(`:scope > details.accordion-section[data-section="${id}"]`)).toHaveJSProperty('open', false);
  }
}

test.describe('Settings sections @features', () => {
  test('desktop opens each top-level section independently and leaves all collapsed on reopen', async ({ mockApi: page }) => {
    await verifySettingsSections(page, 1280, 900);
  });

  test('phone opens each top-level section independently and leaves all collapsed on reopen', async ({ mockApi: page }) => {
    await verifySettingsSections(page, 390, 844);
  });
});
