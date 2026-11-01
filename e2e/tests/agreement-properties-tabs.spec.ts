import { test, expect } from '../helpers/fixtures';
import { applyLayout } from '../helpers/agreements';

for (const width of [1280, 390]) {
  test(`agreement properties tabs inspect map objects and fill action rows at ${width}px`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { layoutId } = await applyLayout(page);
    const before = await page.evaluate(async layoutId => {
      const w = window as any, design = w.proposalStorage.getProposal(layoutId);
      const snapshot = w.PlanComposition.create('Allocation plan', [design], w.MapShare.capture(w)); w.PlanWorkspace.save(snapshot);
      const ground = w.AgreementGround, fabric = w.LiveParcelFabric;
      const ids = w.AgreementDialog.inputParcelIds([design], fabric);
      const originals = (await w.CadastralParcelRepository.ensureIds(ids, { retainOnly: true })).features;
      const land = ground.derive({ designs: [design], fabric, originals: w.AgreementDialog.originalsById(originals, fabric.featureId),
        area: (feature: any) => w.turf.area(feature) });
      // The input parcel is its owners' abstract party; the agreement names no people.
      const ownerKey = w.AgreementRecord.partyKey(land.inputs.parcels[0].parcelId);
      const saved = w.AgreementStore.save(w.AgreementRecord.settle({ schema: 'agreement/v1', id: w.AgreementRecord.newId(), title: 'Land agreement', city: 'zagreb',
        createdAt: new Date().toISOString(), plan: { cid: snapshot.cid, content: snapshot.content },
        designs: [{ proposalId: layoutId, title: design.title, goal: design.goal, cid: w.DesignRecord.cidOf(design) }],
        inputs: land.inputs, outputs: land.outputs, allocations: land.outputs.map((output: any) => ({ output: output.hash, to: { kind: 'party', ownerKey } })),
        money: { currency: 'EUR', lines: [] }, rule: { electorate: 'owners', binding: false, approvalConfig: null, lens: [] }, deadline: null }));
      await w.AgreementPanel.open(saved.id);
      w.__agreementFitCalls = 0; const fit = w.map.fitBounds; w.map.fitBounds = function(...args: any[]) { w.__agreementFitCalls++; return fit.apply(this,args); };
      return JSON.stringify(w.AgreementStore.list());
    }, layoutId);
    const panel = page.locator('#click-stack #agreement-panel');
    const contentTabs = page.locator('#click-stack .click-stack__content-tabs');
    await expect(contentTabs.getByRole('tab')).toHaveText(['Actions', 'Info', /^Input parcels \(\d+\)$/, /^Output parcels \(\d+\)$/, /^Persons \(\d+\)$/, 'Decision', 'Rules']);
    const tabBounds = await contentTabs.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    expect(tabBounds.right - tabBounds.left).toBeGreaterThan(0);
    expect(tabBounds.scrollWidth).toBeGreaterThanOrEqual(tabBounds.clientWidth);
    const tab = (name: string | RegExp) => contentTabs.getByRole('tab', { name, exact: typeof name === 'string' });
    const actions = panel.locator(':scope > .panel-body > .agreement-panel-actions');
    // Propose, Before / after, Edit, Counter-agreement and Download fill the action grid.
    await expect(actions.locator('button')).toHaveCount(5);
    const boxes = await actions.locator('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
    expect(Math.max(...boxes.map(b => b.width)) - Math.min(...boxes.map(b => b.width))).toBeLessThan(1);
    const row = await actions.boundingBox();
    expect(Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.x))).toBeLessThanOrEqual(row!.width + 1);
    await tab('Decision').scrollIntoViewIfNeeded(); await tab('Decision').click();
    await expect(tab('Decision')).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('[data-agreement-properties-panel="decision"]')).toBeVisible();
    await tab(/^Input parcels \(\d+\)$/).scrollIntoViewIfNeeded(); await tab(/^Input parcels \(\d+\)$/).click();
    const input = panel.locator('[data-agreement-inspect="input"]').first();
    await input.hover(); await expect(page.locator('path.agreement-map-hover').first()).toBeVisible(); await input.click();
    await expect(input).toHaveAttribute('aria-pressed', 'true');
    await tab(/^Output parcels \(\d+\)$/).scrollIntoViewIfNeeded(); await tab(/^Output parcels \(\d+\)$/).click();
    const output = panel.locator('[data-agreement-inspect="output"]').first(); await output.click();
    await expect(output).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('path.agreement-map-focus').first()).toBeVisible();
    await tab(/^Persons \(\d+\)$/).scrollIntoViewIfNeeded(); await tab(/^Persons \(\d+\)$/).click();
    // Ownership outcomes and party rows live in Persons, not beside output geometry.
    await panel.getByRole('tabpanel', { name: /^Persons \(\d+\)$/ }).locator('[data-agreement-inspect="person"]').first().click();
    expect(await page.locator('path.agreement-map-focus').count()).toBeGreaterThanOrEqual(3);
    await tab('Rules').scrollIntoViewIfNeeded(); await tab('Rules').click();
    await expect(panel.locator('[data-agreement-properties-panel="rules"]')).toContainText('Decision rule');
    await tab('Rules').press('Home'); await expect(tab('Actions')).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => (window as any).__agreementFitCalls)).toBe(3);
    expect(await page.evaluate(() => JSON.stringify((window as any).AgreementStore.list()))).toBe(before);
    await page.screenshot({ path: testInfo.outputPath('agreement-overview.png') });
  });
}
