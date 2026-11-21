import { openPlanActions } from '../helpers/plan-actions';
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, stubBasemapTiles } from '../helpers/runtime';

test('the Cat explains square edges on the map without applying the saved plan', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubBasemapTiles(page);
  await openCity(page);
  const id = await createSpace(page, 'square');
  await page.keyboard.press('Escape');
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), id);
  const row = await openPlanActions(page, 'Square plan', [id]);
  await row.getByText('Choose a critic', { exact: true }).press('Enter');
  const cat = row.getByRole('button', { name: 'Cat Square enclosure', exact: true });
  const cid = await row.getAttribute('data-list-id');
  const savedState = () => page.evaluate(({ cid, id }) => {
    const w = window as any;
    return { plan: w.PersistentStorage.getItem('plan:' + cid), applied: w.isApplied(w.proposalStorage.getProposal(id)) };
  }, { cid, id });
  const before = await savedState();
  await page.evaluate(() => {
    const w = window as any;
    w.DemolitionIndex.stockUnder = async () => [];
  });
  await cat.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Cat · Square enclosure', exact: true });
  await expect(panel.getByRole('button', { name: 'Close square enclosure' })).toBeFocused();
  await expect(panel.getByRole('combobox', { name: 'Public square', exact: true })).toBeVisible();
  await expect(panel.locator('[data-cat="total"]')).toHaveText('0% of the perimeter defined by buildings');
  await expect(panel.locator('[data-cat="scoreCard"]')).toContainText('0/100');
  await expect(panel.locator('[data-cat="scoreCard"]')).toContainText('Mostly open');
  const gap = page.locator('.square-critic-edge-gap').first();
  await expect(gap).toHaveCSS('stroke', 'rgb(184, 104, 33)');
  expect(await gap.evaluate(path => (path as unknown as SVGPathElement).getTotalLength())).toBeGreaterThan(0);
  const side = panel.getByRole('button', { name: /^Side 1 / });
  await side.press('Enter');
  await expect(side).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByText('Pedestrian access is unverified.', { exact: false })).toBeVisible();
  expect(await savedState()).toEqual(before);
  expect(before.applied).toBe(false);
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect.poll(() => panel.evaluate(el =>
    document.querySelector('.square-critic-ground')!.getBoundingClientRect().bottom < el.getBoundingClientRect().top)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(cat).toBeFocused();
  await expect(page.locator('.square-critic-edge-gap')).toHaveCount(0);

  await page.evaluate(() => {
    (window as any).DemolitionIndex.stockUnder = async () => { throw new Error('test building source unavailable'); };
  });
  await row.getByRole('button', { name: /^Open / }).click();
  const stack = page.locator('#click-stack');
  await stack.getByRole('tab', { name: 'Stats & analysis' }).click();
  const panelCat = stack.getByRole('button', { name: 'Cat Square enclosure' });
  await expect(stack.getByRole('button', { name: 'Plan stats', exact: true })).toBeVisible();
  await panelCat.press('Enter');
  await expect(panel.getByRole('status')).toContainText('Surrounding building data is unavailable');
  await expect(panel.locator('[data-cat="total"]')).toHaveText('At least 0% of the perimeter defined by buildings');
  await expect(panel.locator('[data-cat="scoreCard"]')).toContainText('Minimum score with available data');
  await expect(page.locator('.square-critic-edge-unknown').first()).toHaveCSS('stroke', 'rgb(111, 119, 129)');
  await expect(page.locator('.square-critic-edge-gap')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(stack.getByRole('tab', { name: 'Stats & analysis' })).toHaveAttribute('aria-selected', 'true');
  await expect(panelCat).toBeFocused();
});
