// Selected map geometry and its inspector use the model-view yellow in both themes.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal } from '../helpers/runtime';
for (const theme of ['light', 'dark']) {
  test(`map selection stays yellow in ${theme} mode`, async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(theme => (window as any).CbTheme.set(theme), theme);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    const outline = page.locator('path.click-stack-map-focus').first();
    await expect(outline).toBeVisible();
    await expect(outline).toHaveCSS('stroke', 'rgb(255, 221, 0)');
    const selected = page.locator('#click-stack .click-stack__section.is-selected > .click-stack__card');
    await expect(selected).toHaveCSS('border-top-color', 'rgb(255, 221, 0)');
    await page.evaluate(id => (window as any).highlightProposalHoverById(id), id);
    const hover = page.locator('path.proposal-hover-outline').first();
    await expect(hover).toBeVisible();
    await expect(hover).toHaveCSS('stroke', 'rgb(255, 221, 0)');
    await page.evaluate(() => (window as any).clearProposalHoverLayers());
    await expect(hover).toHaveCount(0);
    await expect(outline).toHaveCSS('stroke', 'rgb(255, 221, 0)');
    expect(await page.evaluate(() => (window as any).MapHighlight.colorHex)).toBe(0xffdd00);
    await page.keyboard.press('Escape');
    await expect(outline).toHaveCount(0);
  });
}
