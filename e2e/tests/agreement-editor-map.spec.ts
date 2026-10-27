// Plan-first agreement editing: tabs preserve the fixed plan, single allocations drive derived
// money, abstract owners work without a rights import, and advanced controls stay in dialogs.
import { test, expect } from '../helpers/fixtures';
import { stubBasemapTiles, showProposal } from '../helpers/runtime';
import { applyLayout, agreementEditor, editorSave, storedAgreements } from '../helpers/agreements';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });
async function create(page: Page, layoutId: string) {
  await page.evaluate(id => { const w = window as any; void w.PlanDialog.create({ members: [w.proposalStorage.getProposal(id)] }); }, layoutId);
  const composer = page.locator('.plan-dialog');
  await composer.locator('input[type="text"]').fill('Block agreement plan');
  await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
  await page.locator('.plan-dialog').getByRole('button', { name: 'Create agreement', exact: true }).click();
  const editor = agreementEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-agreement-input]')).toHaveCount(1);
  return editor;
}

test('creation belongs to the saved plan; four tabs preserve exact membership and save', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  await showProposal(page, layoutId);
  await expect(page.locator('#proposal-details-panel .btn-create-agreement')).toHaveCount(0);
  const editor = await create(page, layoutId);
  await expect(editor.locator('[role="tab"]')).toHaveText(['Rules', 'Input parcels', 'Output parcels', 'Persons']);
  await expect(editor.locator('[data-agreement-design]')).toHaveCount(0);
  const planCid = await editor.locator('[data-agreement-plan]').inputValue();
  await editor.getByRole('tab', { name: 'Output parcels', exact: true }).click();
  const recipients = editor.locator('[data-agreement-allocation]');
  await expect(recipients).toHaveCount(2);
  expect(await recipients.first().locator('option').allTextContents()).not.toContain('Current holders');
  await editor.getByRole('tab', { name: 'Persons', exact: true }).click();
  await expect(editor.locator('.agreement-persons-table')).toContainText('Ana Owner');
  await expect(editor.locator('[data-agreement-cash]')).toHaveCount(0);
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [record] = await storedAgreements(page);
  expect(record.plan.cid).toBe(planCid);
  expect(record.designs.map((row: any) => row.proposalId)).toEqual([layoutId]);
  expect(record.allocations).toHaveLength(2);
  expect(record.money.lines).toEqual([]);
});

test('bulk proposer acquisition disables parcel selectors and saves explicit recipients and compensation', async ({ mockApi: page }) => {
  const { layoutId, ownerKey } = await applyLayout(page);
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: 'Output parcels', exact: true }).click();
  const mode = editor.locator('[data-agreement-allocation-mode]');
  const parcels = editor.locator('[data-agreement-allocation]');
  await mode.selectOption('proposer');
  for (const parcel of await parcels.all()) { await expect(parcel).toBeDisabled(); await expect(parcel).toHaveValue('proposer'); }
  await mode.selectOption('public');
  for (const parcel of await parcels.all()) { await expect(parcel).toBeDisabled(); await expect(parcel).toHaveValue('public'); }
  await mode.selectOption('individual');
  for (const parcel of await parcels.all()) { await expect(parcel).toBeEnabled(); await expect(parcel).toHaveValue('public'); }
  await parcels.first().selectOption('proposer');
  await expect(parcels.first()).toHaveValue('proposer');
  await mode.selectOption('proposer');
  await editor.getByRole('tab', { name: 'Persons', exact: true }).click();
  const proposer = editor.locator('.agreement-persons-table tbody tr').filter({ hasText: 'Proposer' });
  await expect(proposer).toBeVisible(); await expect(proposer).toContainText('EUR');
  await editorSave(editor).click(); await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  expect(saved.allocations.every((line: any) => line.to.kind === 'proposer')).toBe(true);
  const area = saved.outputs.reduce((sum: number, o: any) => sum + o.areaM2, 0);
  expect(saved.money.lines).toEqual([{ ownerKey, amountCents: Math.round(area * saved.rule.settlement.rateCentsPerM2) }]);
  await page.evaluate(id => { void (window as any).AgreementDialog.open({ agreementId: id }); }, saved.id);
  await expect(editor).toBeVisible();
  await editor.getByRole('tab', { name: 'Output parcels', exact: true }).click();
  await expect(mode).toHaveValue('proposer'); await expect(parcels.first()).toBeDisabled();
});

test('agreement authoring blocks the map and page controls, contains focus and restores interaction on cancel and create', async ({ mockApi: page }, testInfo) => {
  const { layoutId } = await applyLayout(page);
  await page.evaluate(() => {
    const w = window as any; w.agreementOutsideClicks = { map: 0, controls: 0 };
    w.map.on('click', () => w.agreementOutsideClicks.map++);
    document.getElementById('layers-button')!.addEventListener('click', () => w.agreementOutsideClicks.controls++);
  });
  const editor = await create(page, layoutId);
  await expect(page.locator('.agreement-editor-modal')).toHaveJSProperty('open', true);
  await expect(editorSave(editor)).toHaveText('Create agreement');
  const cancel = editor.locator('.panel-footer [data-agreement-action="cancel"]');
  const footerWidths = await editor.locator('.panel-footer > button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().width));
  expect(Math.abs(footerWidths[0] - footerWidths[1])).toBeLessThan(1);
  const camera = await page.evaluate(() => { const m = (window as any).map; return [m.getCenter().lat, m.getCenter().lng, m.getZoom()]; });
  await page.mouse.click(150, 200);
  await page.mouse.move(150, 200); await page.mouse.wheel(0, -500);
  const layers = await page.locator('#layers-button').boundingBox();
  await page.mouse.click(layers!.x + layers!.width / 2, layers!.y + layers!.height / 2);
  expect(await page.evaluate(() => (window as any).agreementOutsideClicks)).toEqual({ map: 0, controls: 0 });
  expect(await page.evaluate(() => { const m = (window as any).map; return [m.getCenter().lat, m.getCenter().lng, m.getZoom()]; })).toEqual(camera);
  await expect(editor).toBeVisible();
  await page.keyboard.press('Control+k'); await expect(page.locator('.command-palette')).not.toBeVisible();
  await editorSave(editor).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.agreement-editor-modal'))).toBe(true);
  for (const name of ['Input parcels', 'Output parcels', 'Persons', 'Rules']) {
    await editor.getByRole('tab', { name, exact: true }).click();
    const screenshot = testInfo.outputPath(`${name.replace(/ /g, '-').toLowerCase()}.png`);
    await editor.screenshot({ path: screenshot });
    await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
  }
  await cancel.click(); await expect(editor).toBeHidden(); await expect(page.locator('.agreement-editor-modal')).toHaveCount(0);
  await page.mouse.click(150, 200);
  expect(await page.evaluate(() => (window as any).agreementOutsideClicks.map)).toBe(1);
  await page.locator('#layers-button').click();
  expect(await page.evaluate(() => (window as any).agreementOutsideClicks.controls)).toBe(1);
  await page.evaluate(() => (window as any).MapShell.closeSheets());
  await create(page, layoutId); await editorSave(editor).click(); await expect(editor).toBeHidden();
  await expect(page.locator('.agreement-editor-modal')).toHaveCount(0);
  await page.locator('#layers-button').click();
  expect(await page.evaluate(() => (window as any).agreementOutsideClicks.controls)).toBe(2);
});

test('shared striped lens edits persist as defaults while saved agreement lenses keep their own snapshot', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  const initial = await page.evaluate(() => (window as any).getLensEntries().map((e: any) => e.address));
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  const trigger = editor.locator('[data-agreement-action="lens"]');
  await expect(trigger).toHaveClass(/lens-pattern-button/);
  await expect(editor.locator('.agreement-lens h4')).toHaveText('Lens');
  const row = await editor.locator('.agreement-lens__row').boundingBox(), button = await trigger.boundingBox();
  expect(Math.abs(button!.x + button!.width / 2 - row!.x - row!.width / 2)).toBeLessThan(1);
  expect(await trigger.evaluate(e => getComputedStyle(e).backgroundImage)).toContain('data:image/svg+xml');
  await trigger.click();
  const lens = page.locator('.lens-modal');
  await expect(lens.locator('.cb-dialog__title')).toHaveText('The lens through which I see the world');
  await expect(lens.locator('.lens-address-input')).toHaveCount(initial.length);
  const member = '0x1111111111111111111111111111111111111111';
  await lens.locator('.lens-address-input').first().fill(member);
  await lens.locator('.lens-close-btn').click();
  await editorSave(editor).click(); await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page); expect(saved.rule.lens[0]).toBe(member);
  await page.evaluate(() => { void (window as any).showLensModal(); });
  await expect(lens.locator('.lens-address-input').first()).toHaveValue(member);
  const other = '0x2222222222222222222222222222222222222222';
  await lens.locator('.lens-address-input').first().fill(other); await lens.locator('.lens-close-btn').click();
  await page.evaluate(id => { void (window as any).AgreementDialog.open({ agreementId: id }); }, saved.id);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click(); await trigger.click();
  await expect(lens.locator('.lens-address-input').first()).toHaveValue(member);
  expect(await page.evaluate(() => (window as any).getLensEntries()[0].address)).toBe(other);
  await lens.locator('.lens-close-btn').click();
  await editor.locator('.panel-footer [data-agreement-action="cancel"]').click();
  await create(page, layoutId); await editorSave(editor).click();
  const all = await storedAgreements(page); expect(all.find((r: any) => r.id !== saved.id).rule.lens[0]).toBe(other);
  expect(all.find((r: any) => r.id === saved.id).rule.lens[0]).toBe(member);
});

test('public allocation updates compensation, rate and sponsor tally without editable person cash', async ({ mockApi: page }) => {
  const { layoutId, ownerKey } = await applyLayout(page);
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: 'Output parcels', exact: true }).click();
  await editor.locator('[data-agreement-allocation]').first().selectOption('public');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-rate]').fill('150');
  await editor.getByRole('tab', { name: 'Persons', exact: true }).click();
  await expect(editor.locator('.agreement-persons-table')).toContainText('Sponsor');
  await expect(editor.locator('[data-agreement-persons]')).toContainText('150');
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  const publicArea = saved.outputs.find((o: any) => saved.allocations.some((a: any) => a.output === o.hash && a.to.kind === 'public')).areaM2;
  expect(saved.money.lines).toEqual([{ ownerKey, amountCents: Math.round(publicArea * 15000) }]);
});

test('unnamed parcel owners work and ownership/lens settings open separate dialogs', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  await page.evaluate(() => {
    const w = window as any;
    w.PersistentStorage.forEach((_raw: string, key: string) => { if (/^parcel_.*_owner$/.test(key)) w.PersistentStorage.removeItem(key); });
  });
  const editor = await create(page, layoutId);
  await expect(editor.locator('[data-agreement-land]')).toContainText('Owner(s) of parcel');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(editor.locator('[data-approval-file]')).toHaveCount(0);
  await expect(editor.locator('[data-approval-lens]')).toHaveCount(0);
  await editor.getByRole('tab', { name: 'Input parcels', exact: true }).click();
  await editor.locator('[data-agreement-action="rights"]').click();
  const rights = page.locator('.cb-dialog').filter({ hasText: 'Parcel ownership rights' });
  await expect(rights.locator('[data-approval-file]')).toBeVisible();
  await rights.getByRole('button', { name: 'Close', exact: true }).last().click();
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-action="lens"]').click();
  await expect(page.locator('.lens-modal')).toBeVisible();
  await expect(page.locator('.lens-modal .cb-dialog__title')).toHaveText('The lens through which I see the world');
  await page.keyboard.press('Escape');
  await expect(page.locator('.lens-modal')).toHaveCount(0); await expect(editor).toBeVisible();
  await editor.locator('#agreement-editor-title').focus(); await page.keyboard.press('Escape');
  await expect(editor).toBeHidden(); await expect(page.locator('.agreement-editor-modal')).toHaveCount(0);
});

test('a saved private plan can apply its unpublished members before agreement authoring', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  const editor = await create(page, layoutId);
  const planCid = await editor.locator('[data-agreement-plan]').inputValue();
  await editor.locator('.panel-header [data-agreement-action="cancel"]').click();
  await page.evaluate(async ({ layoutId, planCid }) => {
    const w = window as any;
    await w.ProposalManager.unapplyProposal(layoutId);
    const plan = w.NamedPlans.list().find((row: any) => row.cid === planCid);
    void w.AgreementDialog.open({ plan });
  }, { layoutId, planCid });
  await expect(agreementEditor(page).locator('[data-agreement-action="apply-plan"]')).toBeVisible();
  await agreementEditor(page).locator('[data-agreement-action="apply-plan"]').click();
  await expect(agreementEditor(page).locator('[data-agreement-input]')).toHaveCount(1);
  await expect(editorSave(agreementEditor(page))).toBeEnabled();
  expect(await agreementEditor(page).locator('[data-agreement-plan]').inputValue()).toBe(planCid);
});

test('phone layout shows tabs without horizontal overflow and requires a saved plan', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await applyLayout(page);
  await page.evaluate(() => { void (window as any).AgreementDialog.open(); });
  const editor = agreementEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Create a plan first');
  await expect(editorSave(editor)).toBeDisabled();
  await expect(editor.locator('[data-agreement-plan]')).toHaveValue('');
  expect(await editor.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(editor.locator('[data-agreement-compensation]')).toBeVisible();
  const widths = await editor.locator('.panel-footer > button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().width));
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(1);
  const screenshot = testInfo.outputPath('phone-rules.png');
  await editor.screenshot({ path: screenshot });
  await testInfo.attach('phone rules', { path: screenshot, contentType: 'image/png' });
});


test('input parcels and designs share inspection rows with temporary hover and persistent click highlights', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  const editor = await create(page, layoutId);
  const parcel = editor.locator('[data-agreement-inspect="parcel"]').first();
  const design = editor.locator('[data-agreement-inspect="design"]').first();
  await expect(editor.locator('[data-agreement-action="rights"]')).toBeVisible();
  await expect(editor.locator('[data-agreement-tabpanel="rules"] [data-agreement-action="rights"]')).toHaveCount(0);
  const appearance = (row: any) => row.evaluate((element: HTMLElement) => {
    const style = getComputedStyle(element);
    const title = getComputedStyle(element.querySelector('.agreement-object-row__title')!);
    return { font: style.font, padding: style.padding, border: style.borderRadius, titleFont: title.font };
  });
  expect(await appearance(parcel)).toEqual(await appearance(design));
  expect((await parcel.locator('.agreement-object-row__title').boundingBox())!.x)
    .toBe((await design.locator('.agreement-object-row__title').boundingBox())!.x);
  const hover = page.locator('.agreement-map-hover');
  const pinned = page.locator('.agreement-map-focus');
  await parcel.hover();
  await expect(hover.first()).toBeVisible();
  await parcel.click();
  await expect(parcel).toHaveAttribute('aria-pressed', 'true');
  await editor.locator('.panel-header').hover();
  await expect(hover).toHaveCount(0);
  await expect(pinned.first()).toBeVisible();
  const drawn = await page.evaluate(() => {
    const features: any[] = [];
    (window as any).map.eachLayer((layer: any) => { if (layer.options?.className === 'agreement-map-focus' && layer.feature) features.push(layer.feature.geometry); });
    return features;
  });
  const original = await page.evaluate(id => (window as any).CadastralParcelRepository.get(id).geometry, await parcel.getAttribute('data-agreement-object-id'));
  expect(drawn).toContainEqual(original);
  await design.hover();
  await expect(hover.first()).toBeVisible();
  await design.click();
  await expect(design).toHaveAttribute('aria-pressed', 'true');
  await expect(parcel).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#agreement-editor')).toBeVisible();
  await editor.getByRole('tab', { name: 'Persons', exact: true }).click();
  await expect(hover).toHaveCount(0); await expect(pinned).toHaveCount(0);
  await editor.getByRole('tab', { name: 'Input parcels', exact: true }).click();
  await design.focus();
  await expect(hover.first()).toBeVisible();
  await design.press('Enter');
  await expect(design).toHaveAttribute('aria-pressed', 'true');
  await editor.locator('.panel-header [data-agreement-action="cancel"]').click();
  await expect(hover).toHaveCount(0); await expect(pinned).toHaveCount(0);
  expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).applied, layoutId)).toBe(true);
});


test('agreement rules show one yellow experimental pill without research or legal disclaimers', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-approval-regime]').selectOption('de-umlegung-new');
  const pill = editor.locator('[data-approval-experimental]');
  await expect(pill).toHaveCount(1); await expect(pill).toHaveText('Experimental');
  await expect(pill).toHaveClass(/cb-badge--warning/);
  await expect(editor.locator('.approval-setup__regime .cb-link').first()).toBeVisible();
  await expect(editor).not.toContainText('Agreement rules');
  await expect(editor.locator('[data-approval-rules-card] h4')).toHaveCount(0);
  await expect(editor).not.toContainText('Research template'); await expect(editor).not.toContainText('not legal advice');
  await page.evaluate(async () => { await (window as any).i18n.setLanguage('hr'); });
  await editor.locator('[data-approval-regime]').selectOption('de-umlegung-developed');
  await expect(pill).toHaveText('Eksperimentalno');
  await expect(editor).not.toContainText('Istraživački predložak');
  await expect(editor).not.toContainText('Usporedno istraživanje');
  await expect(editor).not.toContainText('ne pravni savjet');
});
