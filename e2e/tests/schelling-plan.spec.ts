import { openLayerSection } from '../helpers/layers';
// Purpose: cover the Schelling plan through its real entry paths: the Layers switch opening the
// plan's own panel (local street spacing and width, plot size, all reflected in the drawing and the
// address bar; fold and close), the painting tool as the panel's next step (superblock, clear,
// paint a block, Escape back with the blocks kept) and Propose roads landing road proposals.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { openCity, expectStatusLogged } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';

async function openLayers(page: Page): Promise<void> {
  const sheet = page.locator('#layers-sheet');
  if (!(await sheet.isVisible())) await page.locator('#layers-button').click();
  await expect(sheet).toBeVisible();
  await openLayerSection(page, 'schelling-plan');
}

const count = (page: Page, selector: string) => page.locator(selector).count();
const schellingParam = (page: Page) => new URL(page.url()).searchParams.get('schelling');

async function clickVisibleCell(page: Page, selected = false): Promise<void> {
  const cells = page.locator(`path.schelling-propose__cell${selected ? '.is-selected' : ''}`);
  const id = await cells.evaluateAll(nodes => nodes.find(node => {
    const box = node.getBoundingClientRect();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    return x > 0 && y > 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y) === node;
  })?.getAttribute('data-schelling-cell'));
  expect(id, 'an unobstructed block is available to paint').toBeTruthy();
  await page.locator(`path.schelling-propose__cell[data-schelling-cell="${id}"]`).click();
}

test('the Layers switch opens the plan with its own panel, whose settings redraw it and follow the address', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => (window as any).map.setView([45.80025, 15.9822], 17, { animate: false }));
  await openLayers(page);
  const panel = page.locator('#schelling-panel');
  await expect(panel).toBeHidden();
  await expect(page.locator('path.schelling-plan__block')).toHaveCount(0);
  await page.locator('#showSchellingPlan').check();
  // The sheet gives way to the plan's panel.
  await expect(page.locator('#layers-sheet')).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(page.locator('#schelling-panel-title')).toBeFocused();
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

  await selectNativeOption(page.locator('#schelling-plan-plots'), '1');
  await expect.poll(() => schellingParam(page)).toBe('60-20-1');
  await expect(page.locator('path.schelling-plan__plot')).toHaveCount(0);
  await expect(page.locator('#schelling-plan-plot-size')).toHaveText('Whole blocks, no plots.');

  // Folding hides the settings, not the plan; Propose stays at hand.
  const fold = page.locator('#schelling-panel-collapse');
  await fold.click();
  await expect(page.locator('#schelling-panel-body')).toBeHidden();
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#schelling-plan-propose')).toBeVisible();
  expect(await count(page, 'path.schelling-plan__block')).toBeGreaterThan(10);
  expect(schellingParam(page)).toBe('60-20-1');
  await fold.click();
  await expect(page.locator('#schelling-plan-block')).toBeVisible();

  // Closing the panel hides the plan and switches Layers off.
  await expect(page.locator('#schelling-panel-close')).toHaveAttribute('aria-label', 'Close and hide the plan');
  await page.locator('#schelling-panel-close').click();
  await expect(panel).toBeHidden();
  await expect(page.locator('path.schelling-plan__block')).toHaveCount(0);
  expect(schellingParam(page)).toBeNull();
  await openLayers(page);
  await expect(page.locator('#showSchellingPlan')).not.toBeChecked();
});

test('a link with the plan opens it and its panel with the same settings', async ({ mockApi: page }) => {
  await page.goto('/?city=zg&at=45.80025,15.9822,17&schelling=90-15-8&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => (window as any).SchellingLayer?.isEnabled?.() ?? false)).toBe(true);
  await expect(page.locator('#schelling-panel')).toBeVisible();
  await expect(page.locator('#schelling-plan-block')).toHaveValue('90');
  await expect(page.locator('#schelling-plan-street')).toHaveValue('15');
  await expect(page.locator('#schelling-plan-plots')).toHaveValue('8');
  await expect.poll(() => count(page, 'path.schelling-plan__plot')).toBeGreaterThan(0);
  await openLayers(page);
  await expect(page.locator('#showSchellingPlan')).toBeChecked();
});

test('Propose from this plan is the panel\'s next step: painted blocks wait while away, and Propose roads lands road proposals', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await openCity(page);
  await openLayers(page);
  await page.locator('#showSchellingPlan').check();
  const panel = page.locator('#schelling-panel');
  await expect(panel).toBeVisible();
  await page.locator('#schelling-plan-propose').click();
  const tool = page.locator('.schelling-propose .on-map-editor__panel');
  await expect(tool).toBeVisible();
  // The tool takes the panel's place; the panel stands down while it is open.
  await expect(panel).toBeHidden();
  const summary = tool.locator('.schelling-propose__summary');
  await expect(summary).toContainText('64 blocks · 18 streets');
  await expect(summary).toContainText('1 road design');
  await expect(summary).not.toContainText('1 road designs');
  const propose = tool.locator('[data-action="propose"]');

  await tool.locator('[data-action="clear"]').click();
  await expect(summary).toHaveText('No blocks chosen.');
  await expect(propose).toBeDisabled();

  await tool.locator('[data-action="superblock"]').click();
  await expect(summary).toContainText('64 blocks');
  // A press on a chosen block takes it out; the summary and the drawn street land follow.
  await clickVisibleCell(page, true);
  await expect(summary).toContainText('63 blocks');

  // Escape goes back to the plan's panel; the painted blocks are there on return.
  await page.keyboard.press('Escape');
  await expect(tool).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(page.locator('path.schelling-plan__block').first()).toBeAttached();
  await page.locator('#schelling-plan-propose').click();
  await expect(tool).toBeVisible();
  await expect(summary).toContainText('63 blocks');

  // Keep it small for the proposal itself: one block and its four streets.
  await tool.locator('[data-action="clear"]').click();
  await clickVisibleCell(page);
  await expect(summary).toContainText('1 block · 4 streets');
  await expect.poll(() => count(page, 'path.schelling-propose__street')).toBe(4);

  const schellingRoads = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'schelling-point').length);
  expect(await schellingRoads()).toBe(0);
  await propose.click();
  await expect(tool).toBeHidden({ timeout: 60_000 });
  await expect(panel).toBeVisible();
  await expect.poll(schellingRoads).toBe(1);
  const proposed = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'schelling-point')
    .map((proposal: any) => ({ goal: proposal.goal, title: proposal.title })));
  expect(proposed[0].goal).toBe('road-track');
  expect(proposed[0].title).toMatch(/^Schelling roads 45x30-8x8-30-12@46N/);
  await expectStatusLogged(page, 'Proposed 1 of 1 Schelling road networks');

  // What was proposed is done with: the next visit starts from the superblock.
  await page.locator('#schelling-plan-propose').click();
  await expect(summary).toContainText('64 blocks');
});

test('the plan type picker turns the plan into a Burning Man city round a Man placed on the map, kept in the address', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(() => (window as any).map.setView([45.80025, 15.9822], 16, { animate: false }));
  await openLayers(page);
  await page.locator('#showSchellingPlan').check();
  const type = page.locator('#schelling-plan-type');
  await expect(type).toHaveValue('meridians');
  await expect(page.locator('#schelling-plan-burning-man')).toBeHidden();

  // Choosing Burning Man puts the Man where the map is and shows the whole city.
  await selectNativeOption(type, 'burning-man');
  await expect(page.locator('#schelling-plan-meridians')).toBeHidden();
  await expect(page.locator('#schelling-plan-burning-man')).toBeVisible();
  await expect.poll(() => schellingParam(page)).toBe('bm-760-11-76-12-16-0@45.80025,15.9822');
  await expect(page.locator('#schelling-plan-man')).toContainText('45.80025, 15.9822');
  await expect(page.locator('#schelling-plan-man-layout')).toContainText('ring streets A to K every 88 m');
  await expect(page.locator('#schelling-plan-man-layout')).toContainText('Quarter-hour streets from ring I');
  await expect(page.locator('#schelling-plan-man-blocks')).toContainText('208 blocks');
  await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeLessThan(15);
  await expect(page.locator('path.schelling-plan__man')).toHaveCount(1);
  await expect.poll(() => count(page, 'path.schelling-plan__line')).toBe(12 + 33);
  await expect(page.locator('path.schelling-plan__block')).toHaveCount(0);

  // Closer in, the street land, blocks and plots.
  await page.evaluate(() => (window as any).map.setView([45.80025 - 0.0081, 15.9822], 17, { animate: false }));
  await expect.poll(() => count(page, 'path.schelling-plan__block')).toBeGreaterThan(0);
  await expect.poll(() => count(page, 'path.schelling-plan__plot')).toBeGreaterThan(0);

  // The city's settings redraw it and follow the address.
  await page.locator('#schelling-plan-rings').focus();
  await page.locator('#schelling-plan-rings').press('End');
  await expect(page.locator('#schelling-plan-rings-value')).toHaveText('A–L');
  await page.locator('#schelling-plan-bearing').focus();
  await page.locator('#schelling-plan-bearing').press('ArrowRight');
  await expect.poll(() => schellingParam(page)).toBe('bm-760-12-76-12-16-5@45.80025,15.9822');

  // The Man moves to the map centre on request.
  await page.locator('#schelling-plan-man-here').click();
  await expect.poll(() => schellingParam(page)).toMatch(/^bm-760-12-76-12-16-5@45\.792\d*,15\.9822$/);

  // Back to the meridian plan: its own settings, the city kept for later.
  await selectNativeOption(type, 'meridians');
  await expect.poll(() => schellingParam(page)).toBe('120-12-16');
  await expect(page.locator('#schelling-plan-meridians')).toBeVisible();
  await selectNativeOption(type, 'burning-man');
  await expect.poll(() => schellingParam(page)).toMatch(/^bm-760-12-76-12-16-5@45\.792/);
});

test('a Burning Man link opens the city, and Propose roads lands its streets as road proposals', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await page.goto('/?city=zg&at=45.80025,15.9822,15&schelling=bm-500-6-60-10-8-0@45.80025,15.9822&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => (window as any).SchellingLayer?.isEnabled?.() ?? false)).toBe(true);
  await expect(page.locator('#schelling-plan-type')).toHaveValue('burning-man');
  await expect(page.locator('#schelling-plan-esplanade')).toHaveValue('500');
  await expect(page.locator('#schelling-plan-rings')).toHaveValue('6');
  await expect(page.locator('#schelling-plan-depth')).toHaveValue('60');
  await expect(page.locator('#schelling-plan-man-street')).toHaveValue('10');
  await expect(page.locator('#schelling-plan-plots')).toHaveValue('8');
  await expect(page.locator('#schelling-plan-code')).toHaveText('Plan BM-500-6-60-10-0@45.80025,15.9822');

  // From the Man the tool starts at the city's middle hour, 6:00 to 7:00.
  await page.locator('#schelling-plan-propose').click();
  const tool = page.locator('.schelling-propose .on-map-editor__panel');
  await expect(tool).toBeVisible();
  await expect(tool.locator('h2')).toHaveText('Burning Man roads');
  await expect(tool.locator('[data-action="superblock"]')).toHaveText('This clock hour');
  const summary = tool.locator('.schelling-propose__summary');
  await expect(summary).toContainText('12 blocks');
  await expect(summary).not.toContainText('arterial');

  await tool.locator('[data-action="clear"]').click();
  await clickVisibleCell(page);
  await expect(summary).toContainText('1 block · 4 streets');
  await expect.poll(() => count(page, 'path.schelling-propose__street')).toBe(4);

  const cityRoads = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'burning-man').length);
  expect(await cityRoads()).toBe(0);
  await tool.locator('[data-action="propose"]').click();
  await expect(tool).toBeHidden({ timeout: 60_000 });
  await expect.poll(cityRoads).toBe(1);
  const title = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.roadProposal?.definition?.metadata?.source === 'burning-man').title);
  expect(title).toBe('Burning Man roads BM-500-6-60-10-0@45.80025,15.9822');
  await expectStatusLogged(page, 'Proposed 1 of 1 Burning Man road networks');
});
