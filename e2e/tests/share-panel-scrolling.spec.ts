import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, stubBasemapTiles } from '../helpers/runtime';

test.setTimeout(90_000);
test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

for (const width of [1280, 390]) {
  test(`Share list scrolls below its fixed link and controls at ${width}px`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await openCity(page);
    const id = await createSpace(page, 'park');
    await page.evaluate(seedId => {
      const w = window as any;
      const source = w.proposalStorage.getProposal(seedId);
      for (let i = 1; i < 24; i++) {
        w.proposalStorage.addProposal({ ...JSON.parse(JSON.stringify(source)), proposalId: `scroll-design-${i}`, title: `Park design ${i}`, author: 'Scroll fixture', applied: true });
      }
      for (const record of w.proposalStorage.getAllProposals()) {
        w.DesignSync.markPublished(record, { cid: w.DesignRecord.cidOf(record), apiBase: w.resolveBackendBaseUrl(), publishedAt: '2026-10-24T12:00:00.000Z' });
      }
    }, id);
    await page.locator('#proposals-button').click();
    await page.locator('#shareAppliedProposalsButton').click();
    const list = page.locator('.share-plan-list');
    const link = page.locator('.share-plan-link');
    await expect(list.locator('.share-plan-row')).toHaveCount(24);
    await expect(link).toBeVisible();
    const before = (await link.boundingBox())!;
    const listBox = (await list.boundingBox())!;
    expect(before.y + before.height).toBeLessThan(listBox.y);
    expect(await list.evaluate(el => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    await list.hover();
    await page.mouse.wheel(0, 3000);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(list.locator('.share-plan-row').last()).toBeInViewport({ ratio: 1 });
    expect((await link.boundingBox())!.y).toBeCloseTo(before.y, 1);
    await expect(link.getByRole('button', { name: 'Copy URL' })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`share-scroll-${width}.png`) });
  });
}

test('an individual design replaces every group highlight without changing share inclusion', async ({ mockApi: page }) => {
  await openCity(page);
  const id = await createSpace(page, 'park');
  await page.locator('#proposals-button').click();
  await page.locator('#shareAppliedProposalsButton').click();
  const row = page.locator('.share-plan-row').first();
  const groups = page.locator('.share-plan-mode-btn');
  await expect(row).toBeVisible();
  for (const mode of ['All', 'Published', 'Not published yet']) {
    await groups.getByText(mode, { exact: true }).click();
    await expect(groups.getByText(mode, { exact: true })).toHaveAttribute('aria-pressed', 'true');
    await row.locator('.share-plan-row__main').click();
    await expect(page.locator('.share-plan-mode-btn[aria-pressed="true"]')).toHaveCount(0);
    await expect(row.locator('.share-plan-row__main')).toHaveAttribute('aria-pressed', 'true');
    await expect(row.locator('input')).toBeChecked();
    await expect(page.locator('body')).not.toHaveClass(/map-pick-highlighting/);
    await expect(page.locator('.leaflet-pick-highlight-pane path')).toHaveCount(0);
    await expect(page.locator('.proposal-hover-outline').first()).toBeVisible();
    expect(await page.evaluate(() => [...document.querySelectorAll('.proposal-hover-outline')].some(el => el.getAttribute('stroke')?.toLowerCase() === '#ffdd00'))).toBe(true);
  }
  await groups.getByText('Not published yet', { exact: true }).click();
  await expect(row.locator('.share-plan-row__main')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.proposal-hover-outline')).toHaveCount(0);
  await expect.poll(() => page.locator('.leaflet-pick-highlight-pane path').count()).toBeGreaterThan(0);
  // A map pick follows the same individual-focus path as a row click.
  await page.evaluate(key => (window as any).MapPick.pick(key), id);
  await expect(page.locator('.share-plan-mode-btn[aria-pressed="true"]')).toHaveCount(0);
  await expect(row.locator('.share-plan-row__main')).toHaveAttribute('aria-pressed', 'true');
});
