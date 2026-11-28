import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { afterFrames } from '../helpers/app';

for (const width of [1280, 390, 320]) {
  test(`settings keeps its brand and build visible while Advanced scrolls at ${width}px`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); await openCity(page);
    await page.locator('#settings-button').click();
    const panel = page.locator('#settings-sheet'), body = panel.locator(':scope > .settings-content');
    await expect(panel).toBeVisible();
    expect(await body.locator(':scope > [data-section]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.section)))
      .toEqual(['appearance', 'read-source', 'assumptions', 'help', 'advanced']);
    await expect(body.locator('details')).toHaveCount(1);
    const advanced = body.locator('details'); await expect(advanced).toHaveJSProperty('open', false);
    await body.evaluate(el => { el.scrollTop = 0; });
    await expect(panel.locator('#theme-choice-system')).toBeVisible();
    await expect(panel.locator('#economic-source-settings-button')).toBeVisible();
    const brand = panel.locator('.settings-brand');
    const rowBoxes = await brand.locator(':scope > *').evaluateAll(nodes => nodes.map(n => {
      const r = n.getBoundingClientRect(); return { middle: r.y + r.height / 2, right: r.right };
    }));
    expect(Math.max(...rowBoxes.map(b => b.middle)) - Math.min(...rowBoxes.map(b => b.middle))).toBeLessThan(2);
    expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const footer = panel.locator('.settings-footer'); await expect(footer).toBeVisible();
    await afterFrames(page);
    const footerBefore = await footer.boundingBox(), brandBefore = await brand.boundingBox();
    await page.screenshot({ path: testInfo.outputPath('overview.png') });
    await advanced.locator('> summary').click();
    await panel.locator('#wipeLocalDataButton').scrollIntoViewIfNeeded();
    await expect(panel.locator('#wipeLocalDataButton')).toHaveText('Reset browser data');
    await expect(panel.locator('.settings-reset')).toContainText('designs, plans, agreements');
    expect(await footer.boundingBox()).toEqual(footerBefore);
    expect(await brand.boundingBox()).toEqual(brandBefore);
    await expect(panel.locator('#app-update-check')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('advanced-scrolled.png') });
    await page.keyboard.press('Escape'); await page.locator('#settings-button').click();
    await expect(advanced).toHaveJSProperty('open', false);
    await advanced.locator('> summary').click();
    await expect(panel.locator('#debugModeCheckbox')).toBeEnabled();
    await expect(panel.locator('#wipeLocalDataButton')).toBeEnabled();
    await expect(panel.locator('#run-simulation-button')).toBeEnabled();
    await advanced.locator('> summary').click();
    for (const kind of ['credits', 'contact', 'about']) {
      await panel.locator(`[data-settings-reference="${kind}"]`).click();
      const dialog = page.locator('.settings-reference-dialog'); await expect(dialog).toBeVisible();
      if (kind === 'credits') {
        await expect(dialog.locator('#map-credits-details')).toContainText('Leaflet');
        await expect(page.locator('#map-credits-details')).toHaveCount(1);
      }
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
      await expect(panel).toBeVisible();
    }
    await panel.locator('#economic-source-settings-button').click();
    await expect(page.locator('#economic-source-settings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
  });
}

// The model view's ground cover is credited under Settings → Sources & software, never on the map
// (ui/map-credits.js reads three-mode.js's __threeModeGroundCredit while the model view shows a cover).
test('Sources & software credits the 3D ground while the model view shows it', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => {
    (window as any).__threeModeGroundCredit = () => '© <a href="https://esa-worldcover.org/">ESA WorldCover project 2021</a> / '
      + 'Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium';
  });
  await page.locator('#settings-button').click();
  await page.locator('[data-settings-reference="credits"]').click();
  const details = page.locator('.settings-reference-dialog #map-credits-details');
  const title = details.locator('dt', { hasText: '3D ground' });
  await expect(title).toHaveCount(1);
  const credit = title.locator('xpath=following-sibling::dd[1]');
  await expect(credit).toContainText('processed by ESA WorldCover consortium');
  await expect(credit.getByRole('link', { name: 'ESA WorldCover project 2021' })).toHaveAttribute('href', 'https://esa-worldcover.org/');
  await expect(page.locator('.map-credits-control')).not.toContainText('WorldCover');
});
