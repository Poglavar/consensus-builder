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
        ownerOf: ground.localHolders({ storage: w.PersistentStorage, agents: w.agentStorage }), area: (feature: any) => w.turf.area(feature) });
      const ownerKey = land.inputs.parcels[0].holders[0].ownerKey;
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
    await expect(panel.getByRole('tab')).toHaveText(['Overview', /^Input parcels \(\d+\)$/, /^Output parcels \(\d+\)$/, /^Persons \(\d+\)$/, 'Rules']);
    const tabWidths = await panel.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().width));
    expect(Math.max(...tabWidths) - Math.min(...tabWidths)).toBeLessThan(1);
    const tabStrip = await panel.locator('[role="tablist"]').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(tabStrip.scroll).toBeLessThanOrEqual(tabStrip.width);
    const actions = panel.locator(':scope > .panel-body > .agreement-panel-actions');
    await expect(actions.locator('button')).toHaveCount(3);
    const boxes = await actions.locator('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().toJSON()));
    expect(Math.max(...boxes.map(b => b.width)) - Math.min(...boxes.map(b => b.width))).toBeLessThan(1);
    expect(Math.max(...boxes.map(b => b.y)) - Math.min(...boxes.map(b => b.y))).toBeLessThan(1);
    const row = await actions.boundingBox(); expect(boxes[0].x).toBeCloseTo(row!.x, 0); expect(boxes[2].right).toBeCloseTo(row!.x + row!.width, 0);
    const design = panel.locator('[data-agreement-inspect="design"]');
    await design.hover(); await expect(page.locator('path.agreement-map-hover').first()).toBeVisible();
    expect(await page.evaluate(() => (window as any).__agreementFitCalls)).toBe(0);
    await design.click(); await expect(design).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toBeVisible();
    await panel.getByRole('tab', { name: /^Input parcels \(\d+\)$/ }).click();
    const input = panel.locator('[data-agreement-inspect="input"]').first();
    await input.hover(); await expect(page.locator('path.agreement-map-hover').first()).toBeVisible(); await input.click();
    await expect(input).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
    const output = panel.locator('[data-agreement-inspect="output"]').first(); await output.click();
    await expect(output).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('path.agreement-map-focus').first()).toBeVisible();
    await panel.getByRole('tab', { name: /^Persons \(\d+\)$/ }).click();
    await panel.locator('[data-agreement-inspect="person"]').first().click();
    expect(await page.locator('path.agreement-map-focus').count()).toBeGreaterThanOrEqual(3);
    await panel.getByRole('tab', { name: 'Rules', exact: true }).click();
    await expect(panel.getByRole('tabpanel', { name: 'Rules', exact: true })).toContainText('Decision rule');
    await page.keyboard.press('Home'); await expect(panel.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => (window as any).__agreementFitCalls)).toBe(4);
    expect(await page.evaluate(() => JSON.stringify((window as any).AgreementStore.list()))).toBe(before);
    await page.screenshot({ path: testInfo.outputPath('agreement-overview.png') });
  });
}
