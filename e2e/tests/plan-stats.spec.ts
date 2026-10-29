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
    // The building is laid out (plan-units.js), so its apartments are the layout's: the per-m² rule's
    // housing share leaves them, and people follow people per apartment.
    await expect.poll(() => value('apartments'), { timeout: 30_000 }).toMatch(/^[\d,]+ \(1 of 1 buildings laid out\)$/);
    const apartments = await value('apartments');
    const count = (text: string) => Number(text.split(' ')[0].replace(/[^\d]/g, ''));
    expect(count(apartments)).toBeGreaterThan(0);
    await modal.locator('#plan-stats-housing-share').fill('0');
    await modal.locator('#plan-stats-housing-share').press('Tab');
    await expect(modal.locator('#plan-stats-housing-share')).toHaveValue('0');
    expect(await value('apartments')).toBe(apartments);
    await modal.locator('#plan-stats-persons').fill('4');
    await modal.locator('#plan-stats-persons').press('Tab');
    await expect.poll(async () => count(await value('people'))).toBe(count(apartments) * 4);
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

  test('compare designs measures saved and published designs side by side without applying or storing them', async ({ mockApi: page }) => {
    test.setTimeout(120_000);
    await openCity(page);
    const building = await createBuilding(page);
    await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), building);
    const park = await createSpace(page, 'park');
    // A published design this browser does not hold: the park's content under another title.
    const published = await page.evaluate(id => {
      const w = window as any;
      const content = { ...w.DesignRecord.published(w.proposalStorage.getProposal(id)), title: 'Published park' };
      return { cid: w.Cid.cidOfObject(content), content, city: content.city };
    }, park);
    await page.route('**/designs?**', route => route.fulfill({ json: { designs: [{ cid: published.cid, title: 'Published park', city: published.city }], hasMore: false } }));
    await page.route(`**/designs/${published.cid}`, route => route.fulfill({ json: published }));
    const titles = await page.evaluate(ids => ids.map(id => (window as any).proposalStorage.getProposal(id).title), [building, park]);
    const stored = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals().map((p: any) => `${p.proposalId}:${p.applied === true}`).sort());
    const before = await stored();

    await page.locator('#proposals-button').click();
    const sheet = page.locator('#proposals-sheet');
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Compare designs', exact: true }).click();
    const compare = sheet.locator('[data-lists-compare]');
    await expect(compare).toBeDisabled();
    await expect(sheet.getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
    const check = (title: string) => sheet.locator('#proposal-list-host .lists-item').filter({ has: page.getByRole('button', { name: title, exact: true }) }).locator('input[type=checkbox]').check();
    await check(titles[0]);
    await expect(compare).toBeDisabled();
    await check(titles[1]);
    await expect(compare).toBeEnabled();
    await compare.click();
    const dialog = page.locator('.plan-compare-dialog');
    await expect(dialog.getByRole('heading', { name: 'Compare designs' })).toBeVisible();
    const table = dialog.locator('[data-plan-compare]');
    await expect(table.locator('th.plan-compare__plan')).toHaveText(['Present state', ...titles]);
    await expect(dialog.locator('.plan-compare__error')).toHaveCount(0);
    await expect(dialog.locator('[data-plan-compare-basis] option').first()).toHaveText('All compared designs');
    await expect(dialog.locator('[data-plan-compare-side-by-side]')).toBeEnabled();
    expect(await stored()).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // A published design is fetched for the comparison, not downloaded into this browser. The list
    // stayed open under the dialog, its selection ended.
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('#proposal-list-host input[type=checkbox]')).toHaveCount(0);
    await sheet.locator('#lists-actions').getByRole('button', { name: 'Compare designs', exact: true }).click();
    await check(titles[0]);
    await sheet.locator('[data-list-source="published"]').click();
    await check('Published park');
    await compare.click();
    await expect(dialog.getByRole('heading', { name: 'Compare designs' })).toBeVisible();
    await expect(table.locator('th.plan-compare__plan')).toHaveText(['Present state', titles[0], 'Published park']);
    await expect(dialog.locator('.plan-compare__error')).toHaveCount(0);
    expect(await stored()).toEqual(before);
    await dialog.screenshot({ path: test.info().outputPath('design-compare.png') });
    await test.info().attach('design-compare', { path: test.info().outputPath('design-compare.png'), contentType: 'image/png' });
  });

  test('compare plans measures several saved plans side by side without applying them', async ({ mockApi: page }) => {
    test.setTimeout(120_000);
    await openCity(page);
    const building = await createBuilding(page);
    await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), building);
    const park = await createSpace(page, 'park');
    await openPlanActions(page, 'Houses only', [building]);
    await page.locator('#proposals-button').click();
    await openPlanActions(page, 'Houses and park', [building, park]);
    // From here on the parcel carries one existing two-storey building covering it: both plans clear
    // it (the block takes its parcel, the park its ground), the present state keeps it.
    await page.route('**/buildings/under', route => {
      const regions = route.request().postDataJSON()?.regions || [];
      return route.fulfill({ json: { supported: true, truncated: false, source: 'gdi',
        regions: Object.fromEntries(regions.map((region: any) => [region.key, [{ id: 'existing-1', geometry: region.geometry, height_m: null, floors: 2 }]])) } });
    });
    const applied = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied).map((p: any) => p.proposalId));
    const before = await applied();
    await page.getByRole('button', { name: 'Compare plans', exact: true }).click();
    const compare = page.locator('[data-lists-compare]');
    await expect(compare).toBeDisabled();
    for (const title of ['Houses only', 'Houses and park']) {
      await page.getByRole('checkbox', { name: new RegExp(title) }).check();
    }
    await expect(compare).toBeEnabled();
    await compare.click();
    const dialog = page.locator('.plan-compare-dialog');
    await expect(dialog.getByRole('heading', { name: 'Compare plans' })).toBeVisible();
    const table = dialog.locator('[data-plan-compare]');
    await expect(table).toHaveAttribute('data-plan-compare', 'plans-as-columns');
    await expect(dialog.locator('.plan-compare__status')).toHaveCount(0);
    await expect(table.locator('th.plan-compare__plan')).toHaveText(['Present state', 'Houses only', 'Houses and park']);
    await expect(dialog.locator('[data-plan-compare-basis]')).toHaveValue('compared');
    const row = (label: RegExp) => table.locator('tr').filter({ has: page.locator('th[scope="row"]', { hasText: label }) }).locator('td');
    await expect(row(/^Buildings/)).toHaveCount(3);
    const buildings = await row(/^Buildings/).allInnerTexts();
    const remaining = await row(/^of which existing/).allInnerTexts();
    const added = await row(/^of which new/).allInnerTexts();
    // The present state is the existing building; each plan clears it and stands with its own.
    expect([buildings[0], remaining[0], added[0]].map(text => text.split(' ')[0])).toEqual(['1', '1', '0']);
    expect(remaining.slice(1).map(text => text.split(' ')[0])).toEqual(['0', '0']);
    expect(added.slice(1).map(text => text.split(' ')[0])).toEqual(['1', '1']);
    const openSpace = await row(/^Open space/).allInnerTexts();
    expect(openSpace.filter(text => text === '0')).toHaveLength(2);
    const publicLand = await row(/^Public land/).allInnerTexts();
    expect(publicLand[0]).toBe('0');
    expect(Number(publicLand[2].replace(/[^\d]/g, ''))).toBeGreaterThan(0);
    expect(await applied()).toEqual(before);
    await dialog.screenshot({ path: test.info().outputPath('plan-compare-columns.png') });
    await test.info().attach('plan-compare-columns', { path: test.info().outputPath('plan-compare-columns.png'), contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Swap rows and columns' }).click();
    await expect(table).toHaveAttribute('data-plan-compare', 'plans-as-rows');
    await expect(table.locator('th[scope="row"]')).toHaveCount(3);
    await dialog.screenshot({ path: test.info().outputPath('plan-compare-rows.png') });
    await test.info().attach('plan-compare-rows', { path: test.info().outputPath('plan-compare-rows.png'), contentType: 'image/png' });
  });
});
