// Exercise the proposal shell through selection, design, validation, and save controls.
import { test, expect } from '../helpers/fixtures';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { clickMapPoint, openCity, openParcel, showProposal, createSpace, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';

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
  test('refresh and close preserve an unpublished design and editor draft without a leave warning', async ({ mockApi: page }) => {
    test.setTimeout(90_000);
    await openCity(page);
    const sourceId = await createSpace(page, 'park');
    const draftId = await editSource(page, sourceId, 'details');
    const description = 'Saved locally before refreshing.';
    await page.locator('[data-draft-path="fields.description"]').fill(description);
    await page.locator('[data-draft-path="fields.description"]').press('Tab');
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id)?.fields.description, draftId)).toBe(description);
    expect(await page.evaluate(id => (window as any).DesignSync.publishedCid((window as any).proposalStorage.getProposal(id)), sourceId)).toBeFalsy();
    const dialogs: string[] = [];
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.accept(); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore?.getDraft(id)?.fields.description, draftId)).toBe(description);
    await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage?.getProposal(id), sourceId)).toBe(true);
    expect(dialogs).toEqual([]);
    const url = page.url();
    // Real user activation makes a beforeunload handler eligible to display its browser prompt.
    await page.locator('#proposals-button').click();
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(dialogs).toEqual([]);
    const reopened = await page.context().newPage();
    await mockAllApiRoutes(reopened);
    await reopened.goto(url, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => reopened.evaluate(id => (window as any).proposalDraftStore?.getDraft(id)?.fields.description, draftId)).toBe(description);
    await expect.poll(() => reopened.evaluate(id => !!(window as any).proposalStorage?.getProposal(id), sourceId)).toBe(true);
    await reopened.close();
  });

  test('parcel fields autosave and survive a reload without changing the source', async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await openCity(page);
    const sourceId = await addParkSource(page, 'complete-fields');
    const draftId = await editSource(page, sourceId, 'parcels');
    // A design has no terms, ownership or approval to edit: who decides is its agreement's (M2).
    expect(await page.locator('[data-editor-action="tab"]').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('data-editor-tab'))))
      .toEqual(['design', 'parcels', 'details']);
    await page.locator('[data-draft-path="fields.selectedParcelIds"]').fill(`${PARCEL_ID}\nHR-335754-1235`);
    await page.locator('[data-draft-path="fields.selectedParcelIds"]').press('Tab');
    const expected = { selectedParcelIds: [PARCEL_ID, 'HR-335754-1235'] };
    const fields = () => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id)?.fields, draftId);
    await expect.poll(fields).toMatchObject(expected);
    await page.locator('[data-editor-action="close"]').click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore?.getDraft(id)?.fields, draftId)).toMatchObject(expected);
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id), sourceId)).toMatchObject({ cadastreParcelIds: [PARCEL_ID] });
    await editSource(page, sourceId, 'parcels');
    await expect(page.locator('[data-draft-path="fields.selectedParcelIds"]')).toHaveValue(`${PARCEL_ID}\nHR-335754-1235`);
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

  test('validation focus opens the tab and field that need fixing', async ({ mockApi: page }) => {
    await openCity(page);
    const sourceId = await addParkSource(page, 'validation');
    const draftId = await editSource(page, sourceId, 'details');

    const name = page.locator('[data-draft-path="fields.name"]');
    await name.fill('');
    // The shell validates field changes on `change`; typing alone only updates the draft.
    await name.press('Tab');
    await expect(page.locator('[data-editor-action="focus-issue"]')).toBeVisible();
    await page.locator('[data-editor-action="tab"][data-editor-tab="parcels"]').click();
    await expect(page.locator('[data-editor-section="parcels"]')).toBeVisible();
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
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).editorPayload.structureProposal.decorationDesign.trees.length, draftId))
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
    // The editor's copy follows what saving does: a local record is updated in place.
    await expect(page.locator('[data-editor-section="details"] .proposal-editor-section-copy'))
      .toHaveText('Describe what this design does. Saving updates it in place; it keeps its id.');
    await page.locator('[data-draft-path="fields.description"]').fill('Updated description from the proposal editor.');

    await page.locator('[data-editor-action="review"]').click();
    await expect(page.locator('.proposal-editor-review')).toContainText('Updated description from the proposal editor.');
    await expect(page.locator('.proposal-editor-review-notice')).toHaveText('Saving updates this design in place. It keeps its id.');
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
    // The published proposal opens in the click stack, its Design section showing its card.
    await expect(page.locator('#click-stack .click-stack__section[data-kind="designs"] #proposal-details-panel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(sourceId);
    await showProposal(page, sourceId);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    expect(await page.evaluate(id => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.sourceProposalId === id), sourceId)).toBe(false);
  });

  test('the editor copy for a published source says the edit becomes a counterproposal', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const sourceId = await addParkSource(page, 'published-copy');
    // Published: marked with the CID it still hashes to at this index (proposals/design-sync.js).
    await page.evaluate(id => {
      const w = window as any;
      const storage = w.proposalStorage;
      const source = storage.getProposal(id);
      source.published = { cid: w.DesignRecord.cidOf(source), publishedAt: new Date().toISOString(), apiBase: w.DesignSync.apiBase() };
      storage._indexProposal(source);
      storage.save();
    }, sourceId);
    expect(await page.evaluate(id => !!(window as any).DesignSync.publishedCid((window as any).proposalStorage.getProposal(id)), sourceId)).toBe(true);
    await editSource(page, sourceId, 'details');
    await expect(page.locator('[data-editor-section="details"] .proposal-editor-section-copy'))
      .toHaveText('Describe how this alternative design differs. The published design stays as it is.');
    await page.locator('[data-draft-path="fields.description"]').fill('A counterproposal of the published park.');
    await page.locator('[data-editor-action="review"]').click();
    await expect(page.locator('.proposal-editor-review-notice'))
      .toHaveText('Saving creates an alternative design. The published design is not changed or removed.');
  });
});
