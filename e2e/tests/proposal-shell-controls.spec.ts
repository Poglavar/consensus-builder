// Exercise the proposal shell through selection, design, approval, and publication controls.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, openParcel, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { readFile } from 'node:fs/promises';
import { fillNativeDateTime, selectNativeOption } from '../helpers/controls';

async function addParkSource(
  page: import('@playwright/test').Page,
  suffix: string,
  parcelIds: string[] = [PARCEL_ID],
): Promise<string> {
  return page.evaluate(({ suffix, parcelIds, geometry }) => {
    const w = window as any;
    const proposalId = `e2e-proposal-shell-${suffix}`;
    w.proposalStorage.addProposal({
      proposalId,
      title: `Proposal shell source ${suffix}`,
      description: 'Original source description.',
      author: w.getCurrentUserAgent?.()?.name || 'Proposal shell fixture',
      offer: 100,
      offerCurrency: 'EUR',
      city: w.CityConfigManager.getCurrentCityId(),
      goal: 'park',
      lifecycleStatus: 'Active',
      applied: false,
      cadastreParcelIds: parcelIds.length ? parcelIds : [],
      geometry,
      structureProposal: {
        kind: 'park', geometry,
        decorations: { trees: [], flowerbeds: [], ponds: [], paths: [] },
      },
    });
    // Ensure the fixture remains a regular local source record with a stable identity.
    return w.proposalStorage.getProposal(proposalId)?.proposalId || proposalId;
  }, { suffix, parcelIds, geometry: PARCEL_GEOMETRY });
}

async function editSource(
  page: import('@playwright/test').Page,
  proposalId: string,
  tab = 'details',
): Promise<string> {
  await page.evaluate(async ({ proposalId, tab }) => {
    await (window as any).editProposal(proposalId, { tab });
  }, { proposalId, tab });
  await expect(page.locator('.proposal-editor-shell.is-open')).toBeVisible();
  return page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft().id);
}

test.describe('Shared proposal editor shell controls @core', () => {
  test('parcel, ownership and financing fields autosave and survive a reload without changing the source', async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await openCity(page);
    const sourceId = await addParkSource(page, 'complete-fields');
    const draftId = await editSource(page, sourceId, 'parcels');
    await page.locator('[data-draft-path="fields.selectedParcelIds"]').fill(`${PARCEL_ID}\nHR-335754-1235`);
    await page.locator('[data-editor-action="tab"][data-editor-tab="ownership"]').click();
    await selectNativeOption(page.locator('[data-draft-path="fields.ownership"]'), 'third-party');
    await selectNativeOption(page.locator('[data-draft-path="fields.recipientScope"]'), 'specific');
    await page.locator('[data-draft-path="fields.recipientAddress"]').fill('0x1234567890abcdef1234567890abcdef12345678');
    await page.locator('[data-editor-action="tab"][data-editor-tab="terms"]').click();
    await page.locator('[data-draft-path="fields.offer"]').fill('1250');
    await selectNativeOption(page.locator('[data-draft-path="fields.offerCurrency"]'), 'USD');
    // Change the conditional choice in both directions, irrespective of the source default.
    const conditional = page.locator('[data-draft-path="fields.isConditional"]');
    await conditional.setChecked(!await conditional.isChecked());
    await conditional.check();
    await fillNativeDateTime(page.locator('[data-draft-path="fields.expiresAt"]'), '2035-06-15T14:30');
    await page.locator('[data-draft-path="fields.decayEnabled"]').check();
    await page.locator('[data-draft-path="fields.decayPercent"]').fill('35');
    await page.locator('[data-draft-path="fields.decayDurationMs"]').fill('7200000');
    await page.locator('[data-draft-path="fields.depositEnabled"]').check();
    await page.locator('[data-draft-path="fields.depositPercent"]').fill('45');
    await page.locator('[data-draft-path="fields.depositPercent"]').press('Tab');
    const expected = {
      selectedParcelIds: [PARCEL_ID, 'HR-335754-1235'], ownership: 'third-party',
      recipientScope: 'specific', recipientAddress: '0x1234567890abcdef1234567890abcdef12345678',
      offer: 1250, offerCurrency: 'USD', isConditional: true,
      decayEnabled: true, decayPercent: 35, decayDurationMs: 7200000,
      depositEnabled: true, depositPercent: 45,
    };
    const fields = () => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id)?.fields, draftId);
    await expect.poll(fields).toMatchObject(expected);
    const expiry = await page.locator('[data-draft-path="fields.expiresAt"]').evaluate((input: HTMLInputElement) => new Date(input.value).toISOString());
    expect((await fields()).expiresAt).toBe(expiry);
    await page.locator('[data-editor-action="close"]').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore?.getDraft(id)?.fields, draftId)).toMatchObject({ ...expected, expiresAt: expiry });
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id), sourceId)).toMatchObject({ offer: 100, offerCurrency: 'EUR', cadastreParcelIds: [PARCEL_ID] });
    await editSource(page, sourceId, 'terms');
    await expect(page.locator('[data-draft-path="fields.offer"]')).toHaveValue('1250');
    await expect(page.locator('[data-draft-path="fields.depositEnabled"]')).toBeChecked();
  });

  test('map selection, comparison modes, and draft undo/redo update the active draft', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'info');
    await expect.poll(() => page.evaluate(() => (window as any).getCurrentParcelSelectionContext().ids))
      .toEqual([PARCEL_ID]);

    const sourceId = await addParkSource(page, 'selection', []);
    const draftId = await editSource(page, sourceId, 'parcels');
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).fields.selectedParcelIds, draftId))
      .toEqual([]);

    await page.locator('[data-editor-action="use-map-selection"]').click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).fields.selectedParcelIds, draftId))
      .toEqual([PARCEL_ID]);

    for (const mode of ['source-only', 'draft-only', 'overlay']) {
      const control = page.locator(`[data-editor-action="comparison"][data-comparison-mode="${mode}"]`);
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => page.evaluate(() => (window as any).activeProposalDraftComparison?.mode)).toBe(mode);
    }

    const undo = page.locator('[data-editor-action="undo"]');
    const redo = page.locator('[data-editor-action="redo"]');
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).fields.selectedParcelIds, draftId))
      .toEqual([]);
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).fields.selectedParcelIds, draftId))
      .toEqual([PARCEL_ID]);
  });

  test('approval template downloads the selected parcel and validation focus opens the right field', async ({ mockApi: page }) => {
    await openCity(page);
    const sourceId = await addParkSource(page, 'approval');
    const draftId = await editSource(page, sourceId, 'approval');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-editor-action="approval-template"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('parcel-rights-template.json');
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const template = JSON.parse(await readFile(filePath!, 'utf8'));
    expect(template).toMatchObject({
      schema: 'parcel-rights/v1',
      source: { provider: 'upload' },
      parcels: [{ parcelId: PARCEL_ID, complete: false, owners: [] }],
    });

    await page.locator('[data-editor-action="tab"][data-editor-tab="details"]').click();
    const name = page.locator('[data-draft-path="fields.name"]');
    await name.fill('');
    // The shell validates field changes on `change`; typing alone only updates the draft.
    await name.press('Tab');
    await expect(page.locator('[data-editor-action="focus-issue"]')).toBeVisible();
    await page.locator('[data-editor-action="tab"][data-editor-tab="terms"]').click();
    await page.locator('[data-editor-action="focus-issue"]').first().click();
    await expect(page.locator('[data-editor-section="details"]')).toBeVisible();
    await expect(page.locator('[data-draft-path="fields.name"]')).toBeFocused();
    expect(await page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).validation.errors[0]?.path, draftId))
      .toBe('fields.name');
  });

  test('Edit design on map saves geometry into the draft, and Discard removes only that draft', async ({ mockApi: page }) => {
    await openCity(page);
    const sourceId = await addParkSource(page, 'design');
    const draftId = await editSource(page, sourceId, 'design');

    await page.locator('[data-editor-action="open-design"]').click();
    const geometryEditor = page.locator('#structure-geometry-editor');
    await expect(geometryEditor.locator('.on-map-editor__panel')).toBeVisible();
    await geometryEditor.locator('[data-tool="tree"]').click();
    await clickMapPoint(page, 15.98210, 45.80020);
    await geometryEditor.locator('[data-action="save"]').click();
    await expect(geometryEditor).toHaveCount(0);
    await expect(page.locator('.proposal-editor-shell.is-open')).toBeVisible();
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).editorPayload.structureProposal.decorations.trees.length, draftId))
      .toBeGreaterThan(0);
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).structureProposal.decorations.trees.length, sourceId))
      .toBe(0);

    await page.locator('[data-editor-action="discard"]').click();
    const confirm = page.locator('.cb-dialog-overlay--confirm');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.locator('.proposal-editor-shell.is-open')).toHaveCount(0);
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id), draftId)).toBeNull();
    expect(await page.evaluate(id => !!(window as any).proposalStorage.getProposal(id), sourceId)).toBe(true);
  });

  test('review returns to editing and Publish saves the draft onto its local source in place', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await page.locator('#username-display').click();
    await expect(page.locator('#welcome-modal')).toBeVisible();
    await page.locator('#username-input').fill('Proposal shell publisher');
    await page.locator('#welcome-submit-btn').click();
    await expect(page.locator('#welcome-modal')).toBeHidden();

    const sourceId = await addParkSource(page, 'publish');
    const draftId = await editSource(page, sourceId, 'details');
    await page.locator('[data-draft-path="fields.description"]').fill('Updated description from the proposal editor.');

    await page.locator('[data-editor-action="review"]').click();
    await expect(page.locator('.proposal-editor-review')).toContainText('Updated description from the proposal editor.');
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).state, draftId)).toBe('review');

    await page.locator('[data-editor-action="back-to-edit"]').click();
    await expect(page.locator('[data-editor-action="tab"][data-editor-tab="details"]')).toBeVisible();
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).state, draftId)).toBe('editing');
    await page.locator('[data-editor-action="review"]').click();
    await expect(page.locator('[data-editor-action="publish"]')).toBeEnabled();
    await page.locator('[data-editor-action="publish"]').click();

    const proposalDialog = page.locator('.create-proposal-modal');
    await expect(proposalDialog).toBeVisible();
    await expect(page.locator('#createProposalSubmitButton')).toHaveAttribute('data-proposal-draft-id', draftId);
    await expect(page.locator('#proposalName')).toHaveValue('Proposal shell source publish');
    await expect(page.locator('#proposalDescription')).toHaveValue('Updated description from the proposal editor.');
    expect(await page.evaluate(() => (window as any).pendingProposalReplacementSource.proposalId)).toBe(sourceId);

    await page.locator('#createProposalSubmitButton').click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.description, sourceId), { timeout: 45_000 })
      .toBe('Updated description from the proposal editor.');
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id), draftId)).toBeNull();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    expect(await page.evaluate(id => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.sourceProposalId === id), sourceId)).toBe(false);
  });
});
