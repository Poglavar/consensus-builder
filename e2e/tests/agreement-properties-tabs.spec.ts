import { test, expect } from '../helpers/fixtures';
import { OWNER } from '../helpers/agreements';
import { openCity, openParcel, PARCEL_ID, answerBlockScope } from '../helpers/runtime';

async function applyFourPlotLayout(page: import('@playwright/test').Page): Promise<string> {
  await openCity(page);
  const before = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.goal === 'parcel-layout').map((proposal: any) => String(proposal.proposalId)));
  await page.evaluate(async ({ parcelId, name }) => {
    const w = window as any, agent = w.createAgent();
    agent.name = name; w.agentStorage.addAgent(agent);
    w.PersistentStorage.setItem(`parcel_${parcelId}_owner`, agent.id);
  }, { parcelId: PARCEL_ID, name: OWNER });
  await page.evaluate(async id => { await (window as any).CadastralParcelRepository.ensureIds([id]); }, PARCEL_ID);
  await expect.poll(() => page.evaluate(id => !!(window as any).ParcelPresenter.getLayer(id), PARCEL_ID), { timeout: 30_000 }).toBe(true);
  await openParcel(page, 'proposals', PARCEL_ID);
  await page.locator('.parcel-build-btn--parcel-layout').click();
  await answerBlockScope(page);
  const editor = page.locator('.on-map-reparcellization');
  const plotCount = editor.locator('[data-parcel-layout-count]');
  await expect(plotCount).toBeVisible();
  await plotCount.fill('4'); await plotCount.press('Tab');
  await expect(plotCount).toHaveValue('4');
  const done = editor.locator('[data-reparcel-commit]');
  await expect(done).toBeEnabled({ timeout: 15_000 });
  await done.click();
  await expect(editor).toHaveCount(0);
  const appliedLayouts = () => page.evaluate(known => (window as any).proposalStorage.getAllProposals()
    .filter((proposal: any) => proposal.applied && proposal.goal === 'parcel-layout' && !known.includes(String(proposal.proposalId)))
    .map((proposal: any) => String(proposal.proposalId)), before);
  await expect.poll(async () => (await appliedLayouts()).length, { timeout: 30_000 }).toBe(1);
  return (await appliedLayouts())[0];
}

for (const width of [1280, 390]) {
  test(`agreement properties tabs inspect map objects and fill action rows at ${width}px`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const layoutId = await applyFourPlotLayout(page);
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
      // Keep two plots with the parcel party so its outcome is inspectable, and use the next plots
      // for the other ledger recipients. This is a real, balanced allocation of derived outputs.
      if (land.outputs.length < 4) throw new Error('The parcel layout needs four output plots for the ledger fixture.');
      const allocations = land.outputs.map((output: any, index: number) => ({ output: output.hash,
        to: index === 2 ? { kind: 'proposer' } : index === 3 ? { kind: 'public' } : { kind: 'party', ownerKey } }));
      const saved = w.AgreementStore.save(w.AgreementRecord.settle({ schema: 'agreement/v1', id: w.AgreementRecord.newId(), title: 'Land agreement', city: 'zagreb',
        createdAt: new Date().toISOString(), plan: { cid: snapshot.cid, content: snapshot.content },
        designs: [{ proposalId: layoutId, title: design.title, goal: design.goal, cid: w.DesignRecord.cidOf(design) }],
        inputs: land.inputs, outputs: land.outputs, allocations,
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
    const persons = panel.getByRole('tabpanel', { name: /^Persons \(\d+\)$/ });
    await persons.locator('[data-agreement-inspect="person"]').first().click();
    expect(await page.locator('path.agreement-map-focus').count()).toBeGreaterThanOrEqual(3);
    const partyLedger = persons.locator('details.agreement-panel-disclosure').filter({ hasText: 'By parcel party' }).first();
    await expect(partyLedger).toBeVisible();
    const ledgerRows = partyLedger.locator('.agreement-panel-ledger tbody tr[data-agreement-row-inspect]');
    for (const recipient of ['person', 'proposer', 'public']) {
      const button = ledgerRows.locator(`button[data-agreement-inspect="${recipient}"]`).first();
      await expect(button).toBeVisible();
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('path.agreement-map-focus').first()).toBeVisible();
    }
    await tab('Actions').scrollIntoViewIfNeeded(); await tab('Actions').click();
    await expect(tab('Actions')).toHaveAttribute('aria-selected', 'true');
    const panelDownload = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download', exact: true }).click();
    const agreementFile = await panelDownload;
    expect(agreementFile.suggestedFilename()).toBe('land-agreement.ugt-agreement.json');
    const chunks: Buffer[] = [];
    for await (const chunk of (await agreementFile.createReadStream())!) chunks.push(Buffer.from(chunk));
    const downloaded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(downloaded).toMatchObject({ schema: 'ugt-agreement-file/v1', agreement: { title: 'Land agreement' },
      planFile: { plan: { title: 'Allocation plan' } } });
    await tab('Rules').scrollIntoViewIfNeeded(); await tab('Rules').click();
    await expect(panel.locator('[data-agreement-properties-panel="rules"]')).toContainText('Decision rule');
    await tab('Rules').press('Home'); await expect(tab('Actions')).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => (window as any).__agreementFitCalls)).toBe(6);
    expect(await page.evaluate(() => JSON.stringify((window as any).AgreementStore.list()))).toBe(before);
    await page.screenshot({ path: testInfo.outputPath('agreement-overview.png') });
  });
}
