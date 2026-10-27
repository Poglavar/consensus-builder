import { openPlanActions } from '../helpers/plan-actions';
import { test, expect } from '../helpers/fixtures';
import { openCity, createBuilding, createSpace } from '../helpers/runtime';

test.describe('Plan arithmetic @features', () => {
  test('a saved plan counts its unapplied building independently of an unrelated applied park', async ({ mockApi: page }) => {
    test.setTimeout(120_000);
    await openCity(page);
    const building = await createBuilding(page);
    const row = await openPlanActions(page, 'Inspection plan', [building]);
    await page.locator('#proposals-button').click();
    await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), building);
    await createSpace(page, 'park');
    const mapState = () => page.evaluate(() => {
      const w = window as any;
      return JSON.stringify({ designs: w.proposalStorage.getAllProposals(), fabric: w.LiveParcelFabric.list(), agents: w.agentStorage.getAllAgents() });
    });
    const before = await mapState();
    await page.locator('#proposals-button').click();
    await page.locator('[data-list-tab="plans"]').click();
    await row.getByRole('button', { name: 'Plan stats', exact: true }).click();
    const modal = page.locator('#plan-stats-modal');
    await expect(modal).toBeVisible();
    expect(await mapState()).toBe(before);
    await expect(modal.getByRole('heading', { name: 'Plan stats', exact: true })).toBeVisible();
    await expect(modal.locator('[data-plan-stat="scope"]')).toContainText('Inspection plan');
    await test.info().attach('saved-plan-stats', { body: await modal.screenshot(), contentType: 'image/png' });
    const value = (key: string) => modal.locator(`[data-plan-stat="${key}"]`).innerText();
    expect(await value('buildings')).toMatch(/^1 /);
    expect(await value('open-space')).toBe('0');
    const floorArea = await value('floor-area');
    expect(Number(floorArea.replace(/[^\d]/g, ''))).toBeGreaterThan(0);
    const sales = await value('sales-value');
    await modal.locator('#plan-stats-price').fill('10000');
    await modal.locator('#plan-stats-price').press('Tab');
    await expect.poll(() => value('sales-value')).not.toBe(sales);
    const apartments = await value('apartments');
    await modal.locator('#plan-stats-housing-share').fill('0');
    await modal.locator('#plan-stats-housing-share').press('Tab');
    await expect.poll(() => value('apartments')).toBe('0');
    expect(apartments).not.toBe('0');
    await expect.poll(() => value('people')).toBe('0');
    expect(await value('floor-area')).toBe(floorArea);
    await modal.locator('#plan-stats-housing-share').fill('100');
    await modal.locator('#plan-stats-efficiency').fill('100');
    await modal.locator('#plan-stats-apartment-size').fill('20');
    await modal.locator('#plan-stats-persons').fill('4');
    await modal.locator('#plan-stats-persons').press('Tab');
    await expect.poll(async () => Number((await value('people')).replace(/[^\d]/g, ''))).toBeGreaterThan(0);
    // Committed assumptions must show the values the unchanged yield formulas actually use.
    for (const [id, entered, effective] of [
      ['housing-share', '150', '100'], ['housing-share', '-1', '75'], ['housing-share', '0', '0'],
      ['efficiency', '150', '100'], ['efficiency', '0', '80'],
      ['apartment-size', '0', '65'], ['apartment-size', '-5', '65'], ['apartment-size', '', '65'],
      ['persons', '0', '2.4'], ['price', '-100', '0'],
    ]) {
      const input = modal.locator(`#plan-stats-${id}`);
      await input.fill(entered);
      await input.press('Tab');
      await expect(input).toHaveValue(effective);
      expect(await input.evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow || el.validity.rangeOverflow || el.validity.valueMissing)).toBe(false);
    }
    expect(await value('floor-area')).toBe(floorArea);
    await modal.getByRole('button', { name: 'Close plan stats' }).click();
    await expect(modal).toBeHidden();
  });
});
