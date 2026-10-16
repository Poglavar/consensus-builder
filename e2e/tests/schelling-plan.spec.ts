// Purpose: cover the Schelling plan through its real entry paths: the Layers sheet section (show,
// local street spacing and width, plot size, all reflected in the drawing and the address bar),
// the painting tool (superblock, clear, paint a block) and Propose roads landing road proposals.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

async function openLayers(page: Page): Promise<void> {
  const sheet = page.locator('#layers-sheet');
  if (!(await sheet.isVisible())) await page.locator('#layers-button').click();
  await expect(sheet).toBeVisible();
}

const count = (page: Page, selector: string) => page.locator(selector).count();
const schellingParam = (page: Page) => new URL(page.url()).searchParams.get('schelling');

test('the Layers section shows the plan and every setting redraws it and follows the address', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => (window as any).map.setView([45.80025, 15.9822], 17, { animate: false }));
  await openLayers(page);
  await expect(page.locator('path.schelling-plan__block')).toHaveCount(0);
  await page.locator('#showSchellingPlan').check();
  await expect.poll(() => count(page, 'path.schelling-plan__block')).toBeGreaterThan(10);
  await expect.poll(() => count(page, 'path.schelling-plan__plot')).toBeGreaterThan(10);
  await expect.poll(() => schellingParam(page)).toBe('120-12-16');
  await expect(page.locator('#schelling-plan-fixed')).toContainText('30 m wide');
  await expect(page.locator('#schelling-plan-blocks')).toContainText('8 × 8 blocks');

  const blocksBefore = await count(page, 'path.schelling-plan__block');
  await page.locator('#schelling-plan-block').focus();
  await page.locator('#schelling-plan-block').press('Home');
  await expect.poll(() => schellingParam(page)).toBe('60-12-16');
  await expect(page.locator('#schelling-plan-blocks')).toContainText('16 × 15 blocks');
  await expect.poll(() => count(page, 'path.schelling-plan__block')).toBeGreaterThan(blocksBefore);

  await page.locator('#schelling-plan-street').focus();
  await page.locator('#schelling-plan-street').press('End');
  await expect.poll(() => schellingParam(page)).toBe('60-20-16');
  await expect(page.locator('#schelling-plan-street-value')).toHaveText('20 m');

  await page.locator('#schelling-plan-plots').selectOption('1');
  await expect.poll(() => schellingParam(page)).toBe('60-20-1');
  await expect(page.locator('path.schelling-plan__plot')).toHaveCount(0);
  await expect(page.locator('#schelling-plan-plot-size')).toHaveText('Whole blocks, no plots.');

  await page.locator('#showSchellingPlan').uncheck();
  await expect(page.locator('path.schelling-plan__block')).toHaveCount(0);
  expect(schellingParam(page)).toBeNull();
});

test('a link with the plan opens it with the same settings', async ({ mockApi: page }) => {
  await page.goto('/?city=zg&at=45.80025,15.9822,17&schelling=90-15-8&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => (window as any).SchellingLayer?.isEnabled?.() ?? false)).toBe(true);
  await openLayers(page);
  await expect(page.locator('#showSchellingPlan')).toBeChecked();
  await expect(page.locator('#schelling-plan-block')).toHaveValue('90');
  await expect(page.locator('#schelling-plan-street')).toHaveValue('15');
  await expect(page.locator('#schelling-plan-plots')).toHaveValue('8');
  await expect.poll(() => count(page, 'path.schelling-plan__plot')).toBeGreaterThan(0);
});

test('Propose from this plan paints blocks and Propose roads lands Schelling road proposals', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await openCity(page);
  await openLayers(page);
  await page.locator('#schelling-plan-propose').click();
  const tool = page.locator('.schelling-propose .on-map-editor__panel');
  await expect(tool).toBeVisible();
  await expect(page.locator('#showSchellingPlan')).toBeChecked();
  const summary = tool.locator('.schelling-propose__summary');
  await expect(summary).toContainText('64 blocks · 18 streets');
  await expect(summary).toContainText('1 road proposal');
  await expect(summary).not.toContainText('1 road proposals');
  const propose = tool.locator('[data-action="propose"]');

  await tool.locator('[data-action="clear"]').click();
  await expect(summary).toHaveText('No blocks chosen.');
  await expect(propose).toBeDisabled();

  await tool.locator('[data-action="superblock"]').click();
  await expect(summary).toContainText('64 blocks');
  // A press on a chosen block takes it out; the summary and the drawn street land follow.
  await page.locator('path.schelling-propose__cell.is-selected').first().click();
  await expect(summary).toContainText('63 blocks');

  // Keep it small for the proposal itself: one block and its four streets.
  await tool.locator('[data-action="clear"]').click();
  await page.locator('path.schelling-propose__cell').nth(5).click();
  await expect(summary).toContainText('1 block · 4 streets');
  await expect.poll(() => count(page, 'path.schelling-propose__street')).toBe(4);

  const schellingRoads = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'schelling-point').length);
  expect(await schellingRoads()).toBe(0);
  await propose.click();
  await expect(tool).toBeHidden({ timeout: 60_000 });
  await expect.poll(schellingRoads).toBe(1);
  const proposed = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'schelling-point')
    .map((proposal: any) => ({ goal: proposal.goal, title: proposal.title })));
  expect(proposed[0].goal).toBe('road-track');
  expect(proposed[0].title).toMatch(/^Schelling roads 45x30-8x8-30-12@46N/);
  await expect(page.locator('#status')).toContainText('Proposed 1 of 1 Schelling road networks');
});
