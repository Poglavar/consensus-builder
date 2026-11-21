import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, stubBasemapTiles } from '../helpers/runtime';

test('the Beaver uses the saved phase dates and shows the cost of an external connection delay', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubBasemapTiles(page);
  await openCity(page);
  const id = await createSpace(page, 'square');
  await page.keyboard.press('Escape');
  const saved = await page.evaluate(async id => {
    const w = window as any;
    const record = w.proposalStorage.getProposal(id);
    const plan = w.PlanComposition.create('Early square', [record], w.MapShare.capture(w), {
      [w.DesignRecord.cidOf(record)]: { start: '2028-04', end: '2028-10' }
    });
    w.PlanWorkspace.save(plan);
    await w.ClickStack.showPlan(plan, { draft: true, designs: [record] });
    return { cid: plan.cid, storage: w.PersistentStorage.getItem('plan:' + plan.cid) };
  }, id);
  const stack = page.locator('#click-stack');
  await stack.getByRole('tab', { name: 'Stats & analysis' }).click();
  const beaver = stack.getByRole('button', { name: 'Beaver Independent phases', exact: true });
  await beaver.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Beaver · Independent phases' });
  await expect(panel.getByLabel('Assess by the end of')).toHaveValue('2028-10');
  await panel.getByText('Opening assumptions', { exact: true }).press('Enter');
  await panel.getByRole('searchbox', { name: 'Find buildings and public spaces' }).fill('Square');
  await panel.getByRole('button', { name: 'Select visible' }).click();
  await panel.getByLabel('Road access').selectOption('requires-connection');
  await panel.getByLabel('Servicing by assessment month').selectOption('ready');
  await panel.getByRole('button', { name: 'Apply assumptions' }).press('Enter');
  await expect(panel.locator('[data-beaver="score"]')).toHaveText(/^[1-9][0-9,]* m² of public space ready/);
  await panel.getByRole('checkbox', { name: 'Delay the external road connection' }).check();
  await expect(panel.locator('[data-beaver="score"]')).toHaveText('0 m² of public space ready');
  await expect(panel.locator('.beaver-critic-member[data-status="blocked"]')).toContainText('Waiting for external connection');
  await expect(panel.locator('[data-beaver="impact"]')).toContainText(/and [1-9][0-9,]* m² of public space/);
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(beaver).toBeFocused();
  expect(await page.evaluate(cid => (window as any).PersistentStorage.getItem('plan:' + cid), saved.cid)).toBe(saved.storage);
});
