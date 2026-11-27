// Plan-first agreement editing: tabs preserve the fixed plan, single allocations drive derived
// money, abstract owners work without a rights import, and advanced controls stay in dialogs.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';
import { stubBasemapTiles, showProposal, PARCEL_ID } from '../helpers/runtime';
import { applyLayout, agreementEditor, editorSave, storedAgreements } from '../helpers/agreements';
import type { Page } from '@playwright/test';

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });
async function create(page: Page, layoutId: string) {
  await page.evaluate(id => { const w = window as any; void w.PlanDialog.create({ members: [w.proposalStorage.getProposal(id)] }); }, layoutId);
  const composer = page.locator('.plan-dialog');
  await composer.locator('input[type="text"]').fill('Block agreement plan');
  await composer.getByRole('button', { name: 'Create plan', exact: true }).click();
  await page.locator('#click-stack .click-stack__section[data-kind="plans"]').getByRole('button', { name: 'Create agreement', exact: true }).click();
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
  await expect(editor.locator('[role="tab"]')).toHaveText(['Rules', /^Input parcels \(\d+\)$/, /^Output parcels \(\d+\)$/, /^Persons \(\d+\)$/, 'Neighbours (0)']);
  await expect(editor.locator('[data-agreement-design]')).toHaveCount(0);
  const planCid = await editor.locator('[data-agreement-plan]').inputValue();
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  const recipients = editor.locator('[data-agreement-allocation]');
  await expect(recipients).toHaveCount(2);
  expect(await recipients.first().locator('option').allTextContents()).not.toContain('Current holders');
  await editor.getByRole('tab', { name: /^Persons \(\d+\)$/ }).click();
  // The parties are the parcels' abstract owners; the people behind them come from the ownership rights.
  await expect(editor.locator('.agreement-persons-table').first()).toContainText(`Owner(s) of parcel ${PARCEL_ID}`);
  await expect(editor.locator('[data-agreement-derived-persons]')).toContainText('Ana Owner');
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
  const { layoutId, partyKey } = await applyLayout(page);
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  const mode = editor.locator('[data-agreement-allocation-mode]');
  const parcels = editor.locator('[data-agreement-allocation]');
  await selectNativeOption(mode, 'proposer');
  for (const parcel of await parcels.all()) { await expect(parcel).toBeDisabled(); await expect(parcel).toHaveValue('proposer'); }
  await selectNativeOption(mode, 'public');
  for (const parcel of await parcels.all()) { await expect(parcel).toBeDisabled(); await expect(parcel).toHaveValue('public'); }
  await selectNativeOption(mode, 'individual');
  for (const parcel of await parcels.all()) { await expect(parcel).toBeEnabled(); await expect(parcel).toHaveValue('public'); }
  await selectNativeOption(parcels.first(), 'proposer');
  await expect(parcels.first()).toHaveValue('proposer');
  // Randomize hands every piece to a person, each person before anyone gets a second, and leaves the
  // selects editable; the line above the pieces counts who got none and who got several.
  const persons = Number((await editor.getByRole('tab', { name: /^Persons \(\d+\)$/ }).innerText()).match(/\((\d+)\)/)![1]);
  await selectNativeOption(mode, 'random');
  await expect(mode).toHaveValue('individual');
  for (const parcel of await parcels.all()) { await expect(parcel).toBeEnabled(); await expect(parcel).toHaveValue(/^party:/); }
  const owners = await parcels.evaluateAll(selects => selects.map(select => (select as HTMLSelectElement).value));
  expect(new Set(owners).size).toBe(Math.min(persons, owners.length));
  const summary = editor.locator('[data-agreement-allocation-summary]');
  if (owners.length > persons) await expect(summary).toContainText('Persons with more than one parcel:');
  else if (owners.length < persons) await expect(summary).toContainText(`Persons without a parcel: ${persons - owners.length}`);
  else await expect(summary).toBeHidden();
  await selectNativeOption(mode, 'proposer');
  await editor.getByRole('tab', { name: /^Persons \(\d+\)$/ }).click();
  const proposer = editor.locator('.agreement-persons-table tbody tr').filter({ hasText: 'Proposer' });
  await expect(proposer).toBeVisible(); await expect(proposer).toContainText('EUR');
  await editorSave(editor).click(); await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  expect(saved.allocations.every((line: any) => line.to.kind === 'proposer')).toBe(true);
  const area = saved.outputs.reduce((sum: number, o: any) => sum + o.areaM2, 0);
  expect(saved.money.lines).toEqual([{ ownerKey: partyKey, amountCents: Math.round(area * saved.rule.settlement.rateCentsPerM2) }]);
  await page.evaluate(id => { void (window as any).AgreementDialog.open({ agreementId: id }); }, saved.id);
  await expect(editor).toBeVisible();
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
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
    await editor.getByRole('tab', { name: new RegExp(`^${name}( \\(\\d+\\))?$`) }).click();
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
  const { layoutId, partyKey } = await applyLayout(page);
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  await selectNativeOption(editor.locator('[data-agreement-allocation]').first(), 'public');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-rate]').fill('150');
  await editor.getByRole('tab', { name: /^Persons \(\d+\)$/ }).click();
  await expect(editor.locator('.agreement-persons-table').first()).toContainText('Sponsor');
  await expect(editor.locator('[data-agreement-persons]')).toContainText('150');
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  const publicArea = saved.outputs.find((o: any) => saved.allocations.some((a: any) => a.output === o.hash && a.to.kind === 'public')).areaM2;
  expect(saved.money.lines).toEqual([{ ownerKey: partyKey, amountCents: Math.round(publicArea * 15000) }]);
});

test('area compensation and land contribution ranges save their selected terms', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await selectNativeOption(editor.locator('[data-approval-regime]'), 'de-umlegung-developed');

  const rate = editor.locator('[data-agreement-rate-slider]');
  await expect(rate).toBeVisible();
  await rate.scrollIntoViewIfNeeded();
  await expect(rate).toBeInViewport();
  await rate.focus();
  await rate.press('ArrowRight');
  await expect(editor.locator('[data-agreement-rate]')).toHaveValue('101');

  const contribution = editor.locator('[data-agreement-contribution]');
  await expect(contribution).toBeVisible();
  await contribution.scrollIntoViewIfNeeded();
  await expect(contribution).toBeInViewport();
  await contribution.focus();
  await contribution.press('ArrowRight');
  await expect(editor.locator('[data-agreement-contribution-value]')).toHaveText('0.01%');
  await expect(editorSave(editor)).toBeEnabled();

  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  expect(saved.rule.settlement).toEqual({ method: 'area', rateCentsPerM2: 10100, contributionBasisPoints: 1 });
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
  await editor.getByRole('tab', { name: /^Input parcels \(\d+\)$/ }).click();
  await editor.locator('[data-agreement-action="rights"]').click();
  const rights = page.locator('.cb-dialog').filter({ hasText: 'Parcel ownership rights' });
  await expect(rights.locator('[data-approval-file-row] .btn')).toBeVisible();
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

test('a previewed private plan asks to apply its unpublished members before agreement authoring', async ({ mockApi: page }) => {
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
  // Create agreement asks once before applying the plan; the editor opens on its land.
  const ask = page.locator('.cb-dialog--confirm');
  await expect(ask).toContainText('The designs of this plan are not on your map.');
  await ask.getByRole('button', { name: 'Apply and continue', exact: true }).click();
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
  await editor.getByRole('tab', { name: /^Persons \(\d+\)$/ }).click();
  await expect(hover).toHaveCount(0); await expect(pinned).toHaveCount(0);
  await editor.getByRole('tab', { name: /^Input parcels \(\d+\)$/ }).click();
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
  await selectNativeOption(editor.locator('[data-approval-regime]'), 'de-umlegung-new');
  const pill = editor.locator('[data-approval-experimental]');
  await expect(pill).toHaveCount(1); await expect(pill).toHaveText('Experimental');
  await expect(pill).toHaveClass(/cb-badge--warning/);
  await expect(editor.locator('.approval-setup__regime .cb-link').first()).toBeVisible();
  await expect(editor).not.toContainText('Agreement rules');
  await expect(editor.locator('[data-approval-rules-card] h4')).toHaveCount(0);
  await expect(editor).not.toContainText('Research template'); await expect(editor).not.toContainText('not legal advice');
  // Dictionaries load on demand: wait for Croatian before the rules re-render in it.
  await page.evaluate(async () => { const i18n = (window as any).i18n; i18n.setLanguage('hr'); await i18n.loadLanguage('hr'); });
  await selectNativeOption(editor.locator('[data-approval-regime]'), 'de-umlegung-developed');
  await expect(pill).toHaveText('Eksperimentalno');
  await expect(editor).not.toContainText('Istraživački predložak');
  await expect(editor).not.toContainText('Usporedno istraživanje');
  await expect(editor).not.toContainText('ne pravni savjet');
});

test('a chosen scheme is checked against the plan, and settlement by value values every parcel and piece', async ({ mockApi: page }, testInfo) => {
  const { layoutId, partyKey } = await applyLayout(page);
  // The scheme is judged per party: the parcel's abstract owners, never the people behind them.
  const party = `Owner(s) of parcel ${PARCEL_ID}`;
  const editor = await create(page, layoutId);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  // Both pieces go back to their owner, so the German scheme for developed land (10% cap) is met;
  // a kavelruil needs three parties and one brings land in, which the dropdown says before it is chosen.
  const scheme = editor.locator('[data-approval-regime]');
  await selectNativeOption(scheme, 'de-umlegung-developed');
  const check = editor.locator('[data-approval-scheme-check]');
  await expect(check).toHaveAttribute('data-approval-scheme-ok', 'true');
  await expect(check.locator('li[data-check-ok="true"]').first()).toContainText(`The most any owner gives up is 0% (${party}); the cap is 10%.`);
  await expect(scheme.locator('option[value="nl-kavelruil"]')).toHaveAttribute('data-scheme-met', 'false');
  await expect(scheme.locator('option[value="nl-kavelruil"]')).toHaveText(/not met by this plan/);
  await expect(scheme.locator('option[value="de-umlegung-developed"]')).toHaveAttribute('data-scheme-met', 'true');
  await editor.screenshot({ path: testInfo.outputPath('rules-scheme-met.png') });
  // Giving a piece to public breaks the cap: the card, the dropdown and the save all say so.
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  await selectNativeOption(editor.locator('[data-agreement-allocation]').first(), 'public');
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await expect(check).toHaveAttribute('data-approval-scheme-ok', 'false');
  await expect(check.locator('li[data-check-ok="false"]')).toContainText(`${party} gives up`);
  await expect(scheme.locator('option[value="de-umlegung-developed"]')).toHaveText(/not met by this plan/);
  await expect(editorSave(editor)).toBeDisabled();
  await expect(editor.locator('[data-agreement-issue="scheme-cap"]')).toContainText(`Germany — Umlegung, already developed land: ${party} gives up`);
  await editor.screenshot({ path: testInfo.outputPath('rules-scheme-broken.png') });
  // The guide explains the scheme and says what would meet it, with this plan's parties.
  await editor.locator('[data-editor-action="approval-scheme-guide"]').click();
  const guide = page.locator('.cb-dialog').filter({ has: page.locator('[data-scheme-guide="de-umlegung-developed"]') });
  await expect(guide).toBeVisible();
  // The guide is the scheme catalogue with a picker, opened on the chosen scheme.
  await expect(guide.locator('.cb-dialog__title')).toHaveText('Schemes');
  await expect(guide.locator('[data-scheme-guide-pick]')).toHaveValue('de-umlegung-developed');
  await expect(guide.locator('[data-scheme-guide-check] li[data-check-ok="false"]')).toContainText(`${party} gives up 50%`);
  await expect(guide.locator('[data-scheme-guide-fixes]')).toContainText(`In Output parcels, give ${party} at least`);
  // The rules read in the same dimensions as every scheme; this agreement is a part of its own,
  // its owners in rows.
  await expect(guide.locator('[data-scheme-guide-part="rules"] [data-scheme-dimension]')).toHaveCount(11);
  await expect(guide.locator('[data-scheme-flow-step]')).toHaveCount(4);
  await expect(guide.locator('[data-scheme-flow-step="authority"]')).toHaveCount(1);
  const applied = guide.locator('[data-scheme-guide-part="applied"]');
  await expect(applied.locator('[data-scheme-owners-example]')).toHaveCount(0);
  await expect(applied.locator('[data-scheme-guide-check] li[data-check-ok="false"]')).toContainText(`${party} gives up 50%`);
  // The rights name the parcel's owner, so the row over the cap is the person, not the parcel party.
  await expect(applied.locator('.scheme-owners__row.is-over-cap')).toContainText('Ana Owner');
  await expect(applied.locator('.scheme-owners__row.is-over-cap')).toContainText('gives up 50%');
  await expect(applied.locator('.scheme-owners__row--public')).toHaveCount(1);
  // The comparison lists every scheme in those dimensions; a name picks it (the dialog is found by
  // its picker, since the shown scheme changes).
  const schemes = page.locator('.cb-dialog').filter({ has: page.locator('[data-scheme-guide-pick]') });
  await schemes.locator('[data-scheme-compare] summary').click();
  await schemes.locator('[data-scheme-guide-choose="nl-kavelruil"]').click();
  await expect(schemes.locator('[data-scheme-guide-pick]')).toHaveValue('nl-kavelruil');
  await expect(schemes.locator('[data-scheme-guide="nl-kavelruil"]')).toBeVisible();
  await expect(schemes.locator('[data-scheme-compare]')).toHaveAttribute('open', '');
  await expect(schemes.locator('[data-scheme-compare-row="nl-kavelruil"]')).toHaveAttribute('aria-current', 'true');
  await selectNativeOption(schemes.locator('[data-scheme-guide-pick]'), 'de-umlegung-developed');
  await expect(guide).toContainText('Set it up here');
  await guide.screenshot({ path: testInfo.outputPath('scheme-guide.png') });
  await guide.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(guide).toBeHidden();
  await expect(editor).toBeVisible();
  // By value: every parcel and piece gets a value per m², prefilled, settable for all and per row.
  await selectNativeOption(scheme, 'unanimous');
  await selectNativeOption(editor.locator('[data-agreement-compensation]'), 'value');
  await expect(editor.locator('[data-agreement-value-hint]')).toBeVisible();
  await expect(editor.locator('[data-agreement-rate]')).toBeHidden();
  await editor.getByRole('tab', { name: /^Input parcels \(\d+\)$/ }).click();
  const inputValues = editor.locator('[data-agreement-value-kind="inputs"]');
  await expect(inputValues).toHaveCount(1);
  await editor.locator('[data-agreement-value-all="inputs"]').fill('100');
  await expect(inputValues).toHaveValue('100');
  await editor.screenshot({ path: testInfo.outputPath('inputs-values.png') });
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  await selectNativeOption(editor.locator('[data-agreement-allocation]').first(), 'proposer');
  const pieceValues = editor.locator('[data-agreement-value-kind="outputs"]');
  await expect(pieceValues).toHaveCount(2);
  await editor.locator('[data-agreement-value-all="outputs"]').fill('400');
  await pieceValues.first().fill('300');
  await editor.getByRole('tab', { name: /^Persons \(\d+\)$/ }).click();
  await expect(editor.locator('.agreement-persons-table').first()).toContainText('entitled to');
  await expect(editor.locator('[data-agreement-balance]')).toContainText('Value in');
  await editor.screenshot({ path: testInfo.outputPath('persons-values.png') });
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  expect(saved.rule.settlement).toEqual({ method: 'value', rateCentsPerM2: 0, contributionBasisPoints: 0 });
  expect(saved.valuation.inputs).toEqual([{ parcelId: PARCEL_ID, unitValueCents: 10000 }]);
  expect(saved.valuation.outputs.map((row: any) => row.unitValueCents).sort()).toEqual([30000, 40000]);
  // The owner is entitled to the value of both pieces and got one: the proposer's piece is paid for.
  const acquired = saved.outputs.find((o: any) => saved.allocations.some((a: any) => a.output === o.hash && a.to.kind === 'proposer'));
  expect(saved.money.lines).toEqual([{ ownerKey: partyKey, amountCents: Math.round(acquired.areaM2 * 30000) }]);
  await page.evaluate(id => { void (window as any).AgreementDialog.open({ agreementId: id }); }, saved.id);
  await expect(editor).toBeVisible();
  await editor.getByRole('tab', { name: /^Output parcels \(\d+\)$/ }).click();
  await expect(pieceValues.first()).toHaveValue('300');
});

test('Find affected neighbours ticks the plots beyond a guide and adds them as waivers with their readings', async ({ mockApi: page }) => {
  const { layoutId } = await applyLayout(page);
  const editor = await create(page, layoutId);
  // The measurement itself (Effects on neighbours, unit-tested) is replaced by its answer for this plan.
  await page.evaluate(parcelId => {
    const w = window as any;
    const lot = (id: string, status: string) => ({ id, status, direction: 'n', distanceM: 12, sky: { status, before: 31.2, after: 22.4 } });
    w.PlanAnalysisControls.runEffects = async (_win: unknown, getPlan: () => Promise<unknown>, section: HTMLElement) => {
      if (!(await getPlan())) throw new Error('no plan');
      section.textContent = 'measured';
      return { status: 'affected', lots: [lot('n-1', 'fail'), lot('n-2', 'below'), lot(parcelId, 'fail')], guides: { sky: { percent: 27, ratio: 0.8 } } };
    };
  }, PARCEL_ID);
  await editor.getByRole('tab', { name: 'Neighbours (0)' }).click();
  await editor.getByRole('button', { name: 'Find affected neighbours' }).click();
  await expect(editor.locator('[data-agreement-neighbour-candidate="n-1"]')).toBeChecked();
  await expect(editor.locator('[data-agreement-neighbour-candidate="n-2"]')).not.toBeChecked();
  // An input parcel is never offered as a neighbour.
  await expect(editor.locator(`[data-agreement-neighbour-candidate="${PARCEL_ID}"]`)).toBeDisabled();
  await editor.locator('[data-agreement-neighbour-candidate="n-2"]').check();
  await editor.getByRole('button', { name: 'Add ticked plots (2)' }).click();
  await expect(editor.locator('[data-agreement-neighbours-added]')).toContainText('Added 2');
  await expect(editor.locator('[data-agreement-affected="n-1"] [data-affected-field="effect"]')).toBeFocused();
  await expect(editor.locator('[data-agreement-affected="n-1"]')).toContainText('Sky from facing wall: 31.2% → 22.4% (guide 27%), beyond a guide');
  await expect(editor.locator('[data-agreement-affected="n-1"]').getByLabel('Daylight')).toBeChecked();
  await expect(editor.locator('[data-agreement-neighbour-candidate="n-1"]')).toBeDisabled();
  await expect(editor.getByRole('tab', { name: 'Neighbours (2)' })).toBeVisible();
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  expect(saved.affected.map((entry: any) => [entry.parcelId, entry.effect, entry.rights, entry.readings])).toEqual([
    ['n-1', 'waiver', ['daylight'], [{ kind: 'sky', before: 31.2, after: 22.4, guide: 27, grade: 'fail' }]],
    ['n-2', 'waiver', ['daylight'], [{ kind: 'sky', before: 31.2, after: 22.4, guide: 27, grade: 'below' }]]]);
  // A waiver's owners are parties to the decision: the approval subject names their parcels.
  expect(await page.evaluate(id => (window as any).AgreementRecord.approvalSubject((window as any).AgreementStore.get(id)).waiverParcelIds, saved.id)).toEqual(['n-1', 'n-2']);
});

test('a neighbour added by parcel id is compensated at the Strong Suburbs multiple of a stated loss, by keyboard, on a phone', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { layoutId } = await applyLayout(page);
  const editor = await create(page, layoutId);
  // The tabs' arrow keys reach Neighbours after Persons.
  const persons = editor.getByRole('tab', { name: /^Persons \(\d+\)$/ });
  await persons.focus();
  await page.keyboard.press('ArrowRight');
  const neighboursTab = editor.getByRole('tab', { name: 'Neighbours (0)' });
  await expect(neighboursTab).toBeFocused();
  await expect(neighboursTab).toHaveAttribute('aria-selected', 'true');
  await expect(editor.getByRole('button', { name: 'Find affected neighbours' })).toBeEnabled();
  // Enter in the id field adds the parcel and does not save the agreement.
  const id = editor.getByLabel('Add a neighbouring parcel by its id');
  await id.fill('n-42');
  await id.press('Enter');
  await expect(editor).toBeVisible();
  const row = editor.locator('[data-agreement-affected="n-42"]');
  await expect(row).toBeVisible();
  await expect(editor.getByRole('tab', { name: 'Neighbours (1)' })).toBeVisible();
  // Without a right it cannot be saved; the error names the fix at once.
  await expect(editor.locator('[data-agreement-issue="affected-rights"]')).toBeVisible();
  await expect(editorSave(editor)).toBeDisabled();
  await row.getByLabel('Garden limit').check();
  await selectNativeOption(row.getByLabel('Case'), { value: 'compensation' });
  await row.getByLabel(/^Stated loss in market value/).fill('1000');
  await expect(row.getByLabel(/^Payment to them/)).toHaveValue('1000');
  // Rules: Strong Suburbs' 150 % applies to the stated loss.
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await selectNativeOption(editor.getByLabel('Compensation to neighbours'), { value: 'gb-strong-suburbs@2026-11-27' });
  await expect(editor.locator('[data-agreement-neighbour-source] a')).toContainText('Strong Suburbs');
  await editor.getByRole('tab', { name: 'Neighbours (1)' }).click();
  const payment = row.getByLabel(/^Payment to them/);
  await expect(payment).toHaveValue('1500');
  await expect(payment).toHaveAttribute('readonly', '');
  await editor.getByRole('tab', { name: /^Persons \(\d+\)$/ }).click();
  await expect(editor.locator('[data-agreement-neighbour-party]')).toHaveCount(1);
  await editor.getByRole('tab', { name: 'Neighbours (1)' }).click();
  expect(await editor.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  const screenshot = testInfo.outputPath('phone-neighbours.png');
  await editor.screenshot({ path: screenshot });
  await testInfo.attach('phone neighbours', { path: screenshot, contentType: 'image/png' });
  await expect(editorSave(editor)).toBeEnabled();
  await editorSave(editor).click();
  await expect(editor).toBeHidden();
  const [saved] = await storedAgreements(page);
  expect(saved.affected).toEqual([{ parcelId: 'n-42', effect: 'compensation', rights: ['garden'], note: null, readings: [],
    loss: { amountCents: 100000, statedBy: 'sponsor', valuerRef: null }, considerationCents: 150000 }]);
  expect(saved.money.lines).toContainEqual({ ownerKey: 'parcel-owner:n-42', amountCents: 150000 });
  expect(saved.rule.neighbourCompensation).toEqual({ multipleBasisPoints: 15000, preset: { id: 'gb-strong-suburbs', version: '2026-11-27' } });
  // Reopened, the terms are as saved; removing the neighbour keeps focus in the tab.
  await page.evaluate(agreementId => { void (window as any).AgreementDialog.open({ agreementId }); }, saved.id);
  await expect(editor).toBeVisible();
  await editor.getByRole('tab', { name: 'Neighbours (1)' }).click();
  await expect(row.getByLabel(/^Payment to them/)).toHaveValue('1500');
  await row.getByRole('button', { name: 'Remove n-42 from the agreement' }).click();
  await expect(editor.getByRole('tab', { name: 'Neighbours (0)' })).toBeVisible();
  await expect(editor.getByLabel('Add a neighbouring parcel by its id')).toBeFocused();
});
