// The Rules tab of an agreement: the scheme guide with its picker, and a counter-agreement drafted
// from the agreement's plan and terms (optionally under the scheme the guide landed on).
import { test, expect } from '../helpers/fixtures';
import { applyLayout } from '../helpers/agreements';

test('the Rules tab opens the scheme guide and drafts a counter-agreement from the agreement', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { layoutId } = await applyLayout(page);
  const planCid = await page.evaluate(async layoutId => {
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
      money: { currency: 'EUR', lines: [] }, rule: { electorate: 'owners', binding: false, approvalConfig: null, lens: [] }, deadline: '2030-12-31T00:00:00.000Z' }));
    await w.AgreementPanel.open(saved.id);
    return snapshot.cid as string;
  }, layoutId);
  const panel = page.locator('#click-stack #agreement-panel');
  await panel.getByRole('tab', { name: 'Rules', exact: true }).click();
  const rules = panel.getByRole('tabpanel', { name: 'Rules', exact: true });
  // No scheme is pinned: the guide opens on the catalogue to compare with.
  await rules.getByRole('button', { name: 'Compare with a scheme…', exact: true }).click();
  const guide = page.locator('.cb-dialog').filter({ has: page.locator('[data-scheme-guide-pick]') });
  await expect(guide).toBeVisible();
  await expect(guide.locator('.cb-dialog__title')).toHaveText('Schemes');
  await expect(guide.locator('[data-scheme-guide]')).toHaveCount(1);
  await guide.locator('[data-scheme-guide-pick]').selectOption('nl-kavelruil');
  await expect(guide.locator('[data-scheme-guide="nl-kavelruil"]')).toBeVisible();
  await expect(guide.locator('[data-scheme-guide-check] li')).not.toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('scheme-guide.png') });
  // Counter with the picked scheme: the editor starts from this agreement under that scheme.
  await guide.getByRole('button', { name: 'Counter-agreement with this scheme', exact: true }).click();
  const editor = page.locator('#agreement-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('#agreement-editor-title')).toHaveText('Counter-agreement');
  await expect(editor.locator('[data-agreement-title]')).toHaveValue('Counter to Land agreement');
  await expect(editor.locator('select[data-agreement-plan]')).toHaveValue(planCid);
  await expect(editor.locator('select[data-approval-regime]')).toHaveValue('nl-kavelruil');
  await expect(editor.locator('[data-agreement-deadline]')).toHaveValue('2030-12-31');
  await editor.locator('.panel-footer [data-agreement-action="cancel"]').click();
  await expect(editor).toBeHidden();
  // Cancelled: nothing was saved, and the original agreement is still the one shown.
  expect(await page.evaluate(() => (window as any).AgreementStore.list().length)).toBe(1);
  await expect(panel).toBeVisible();
  // Counter-agreement from the Rules tab itself: a copy under the same rule, saved as a second record.
  await panel.getByRole('tab', { name: 'Rules', exact: true }).click();
  await rules.getByRole('button', { name: 'Counter-agreement', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(editor.locator('select[data-approval-regime]')).toHaveValue('unanimous');
  await editor.locator('[data-agreement-action="save"]').click();
  await expect(editor).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).AgreementStore.list().map((row: any) => row.title).sort())).toEqual(['Counter to Land agreement', 'Land agreement']);
  await expect(panel).toContainText('Counter to Land agreement');
  await panel.getByRole('tab', { name: 'Rules', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('rules-tab.png') });
});
