// Purpose: the agreement editor docked on the map picks its designs there (plan-design-agreement.md,
// "M3 notes", UI decision 2026-10-22; js/agreement-dialog.js over js/map-pick.js): Add to agreement
// on a design's details opens it with the map in pick mode and the chosen designs highlighted; a real
// click on an applied design removes or adds it; Add to agreement offers the agreements not proposed
// yet; Edit takes the agreement panel's place and Cancel or Escape brings it back; a proposed agreement
// is never edited; on a phone the editor is a bottom sheet and the map above it still picks.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { chooseProfileName, clickDesignOnMap as clickDesign, showProposal, stubBasemapTiles } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { pageIndex } from '../helpers/mocks/shared-server';
import {
  applyLayout, layOutParcel, agreementEditor, agreementPanel, storedAgreements, landLoaded, createFromDetails, openAgreementsList,
  panelStatus, editorOpen, editorClosed, editorSave, editorCancel, editorClose,
} from '../helpers/agreements';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

const SECOND_PARCEL = sampleParcels.features[1].properties.parcelId;
// The highlight MapPick draws for the editor: the chosen designs' outlines in their own pane.
const highlight = (page: Page) => page.locator('.leaflet-pick-highlight-pane .map-pick-highlight');
const titleOf = (page: Page, id: string) => page.evaluate(id => String((window as any).proposalStorage.getProposal(id).title), id);
const pickStatus = (editor: Locator) => editor.locator('[data-agreement-pick-status]');
const inputRows = (editor: Locator) => editor.locator('[data-agreement-land] tr[data-agreement-input]');

test.describe('The agreement editor on the map @core', () => {
  test('Add to agreement opens the editor picking on the map, where a click removes the design and another adds it back', async ({ mockApi: page }) => {
    test.setTimeout(180_000);
    const { layoutId } = await applyLayout(page);
    const title = await titleOf(page, layoutId);
    const editor = await createFromDetails(page, layoutId);

    // The map picks for the editor: pan and zoom only, the chosen design highlighted.
    await expect(page.locator('body')).toHaveClass(/\bmap-pick-mode\b/);
    await expect(page.locator('body')).toHaveAttribute('data-map-pick', 'agreement');
    await expect(highlight(page).first()).toBeAttached({ timeout: 15_000 });
    await expect(editor.locator('[data-agreement-map-hint]')).toHaveText('Click a design on the map to add or remove it');
    await expect(pickStatus(editor)).toHaveText('');

    // A click on the layout takes it out: the line says so, its box is unticked, its highlight and its land go.
    await clickDesign(page, layoutId);
    await expect(pickStatus(editor)).toHaveText(`Removed “${title}”.`);
    await expect(editor.locator(`input[data-agreement-design="${layoutId}"]`)).not.toBeChecked();
    await expect(highlight(page)).toHaveCount(0);
    await expect(inputRows(editor)).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).MapPick.active())).toBe('agreement');

    // Another click puts it back, with its land read again.
    await clickDesign(page, layoutId);
    await expect(pickStatus(editor)).toHaveText(`Added “${title}”.`);
    await expect(editor.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
    await expect(highlight(page).first()).toBeAttached();
    await landLoaded(editor);

    // The checklist picks the same selection: unticking the box takes the highlight off too, and the
    // line only speaks of map clicks.
    await editor.locator(`input[data-agreement-design="${layoutId}"]`).uncheck();
    await expect(highlight(page)).toHaveCount(0);
    await expect(pickStatus(editor)).toHaveText('');
    await editor.locator(`input[data-agreement-design="${layoutId}"]`).check();
    await expect(highlight(page).first()).toBeAttached();
    await landLoaded(editor);

    // Save stores the agreement over the design, the panel takes the dock and the map stops picking.
    await editorSave(editor).click();
    await editorClosed(page);
    await expect(highlight(page)).toHaveCount(0);
    await panelStatus(page, 'current');
    await expect(agreementPanel(page).locator(`[data-agreement-design="${layoutId}"]`)).toBeVisible();
    const [saved] = await storedAgreements(page);
    expect(saved.designs.map((design: any) => design.proposalId)).toEqual([layoutId]);
  });

  test('a second layout picked on the map joins the agreement, and Add to agreement offers the agreements not proposed yet', async ({ mockApi: page }) => {
    test.setTimeout(240_000);
    const { layoutId } = await applyLayout(page);
    let editor = await createFromDetails(page, layoutId);
    await editor.locator('[data-agreement-title]').fill('Two blocks');
    await editorSave(editor).click();
    await editorClosed(page);
    await panelStatus(page, 'current');
    const [first] = await storedAgreements(page);

    // The next parcel is laid out from its own panel, so the agreement panel is closed first (it would
    // cover that panel on the dock).
    await agreementPanel(page).locator('[data-agreement-action="close"]').click();
    await expect(agreementPanel(page)).toBeHidden();
    const secondId = await layOutParcel(page, SECOND_PARCEL);
    const secondTitle = await titleOf(page, secondId);

    // An agreement is waiting to be proposed, so Add to agreement asks: a new one, or that one.
    await showProposal(page, secondId);
    await page.locator('#proposal-details-panel .btn-create-agreement').click();
    let chooser = page.locator('.cb-dialog.agreement-add-to');
    await expect(chooser).toBeVisible();
    await expect(chooser.locator('.cb-dialog__title')).toHaveText('Add to agreement');
    await expect(chooser).toContainText(`Add “${secondTitle}” to a new agreement, or to one not proposed yet.`);
    await expect(chooser.locator('[data-action-id="__new__"]')).toHaveText('New agreement');
    await expect(chooser.locator(`[data-action-id="${first.id}"]`)).toHaveText('Two blocks · 1 design');
    // A new agreement starts from that design alone; cancelled, nothing is stored.
    await chooser.locator('[data-action-id="__new__"]').click();
    editor = await editorOpen(page, 'Create agreement');
    await expect(editor.locator(`input[data-agreement-design="${secondId}"]`)).toBeChecked();
    await expect(editor.locator(`input[data-agreement-design="${layoutId}"]`)).not.toBeChecked();
    await landLoaded(editor);
    await expect(inputRows(editor)).toHaveCount(1);
    await expect(editor.locator(`tr[data-agreement-input="${SECOND_PARCEL}"]`)).toBeVisible();
    await editorCancel(editor).click();
    await editorClosed(page);
    expect((await storedAgreements(page)).map((agreement: any) => agreement.id)).toEqual([first.id]);

    // Edit from the panel, and the second layout is picked on the map: it joins, with its land.
    let list = await openAgreementsList(page);
    await list.locator(`.agreement-item[data-agreement-id="${first.id}"]`).click();
    await panelStatus(page, 'current');
    await agreementPanel(page).locator('[data-agreement-action="edit"]').click();
    editor = await editorOpen(page, 'Edit agreement');
    await landLoaded(editor);
    await expect(inputRows(editor)).toHaveCount(1);
    await clickDesign(page, secondId);
    await expect(pickStatus(editor)).toHaveText(`Added “${secondTitle}”.`);
    await expect(editor.locator(`input[data-agreement-design="${secondId}"]`)).toBeChecked();
    await expect(editor.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
    await expect(inputRows(editor)).toHaveCount(2);
    await expect(editor.locator(`tr[data-agreement-input="${SECOND_PARCEL}"]`)).toBeVisible();
    await editorSave(editor).click();
    await editorClosed(page);
    await panelStatus(page, 'current');
    await expect(agreementPanel(page).locator(`[data-agreement-design="${secondId}"]`)).toBeVisible();
    const [joined] = await storedAgreements(page);
    expect(joined.id).toBe(first.id);
    expect(joined.designs.map((design: any) => design.proposalId).sort()).toEqual([layoutId, secondId].sort());
    expect(joined.inputs.parcels.map((parcel: any) => parcel.parcelId).sort()).toEqual([sampleParcels.features[0].properties.parcelId, SECOND_PARCEL].sort());

    // Choosing the agreement a design is already in says so, and opens the editor on it as it is.
    await agreementPanel(page).locator('[data-agreement-action="close"]').click();
    await showProposal(page, layoutId);
    await page.locator('#proposal-details-panel .btn-create-agreement').click();
    chooser = page.locator('.cb-dialog.agreement-add-to');
    await expect(chooser.locator(`[data-action-id="${first.id}"]`)).toHaveText('Two blocks · 2 designs');
    await chooser.locator(`[data-action-id="${first.id}"]`).click();
    await expect(page.locator('#ephemeral-message-container').getByText(`“${await titleOf(page, layoutId)}” is already in this agreement.`)).toBeVisible();
    editor = await editorOpen(page, 'Edit agreement');
    await expect(editor.locator('input[data-agreement-design]:checked')).toHaveCount(2);
    await editorClose(editor).click();
    await editorClosed(page);
    expect(await storedAgreements(page)).toEqual([joined]);
  });

  test('Edit takes the agreement panel\'s place; Cancel and Escape bring it back, but Escape in a field does not', async ({ mockApi: page }) => {
    test.setTimeout(180_000);
    const { layoutId } = await applyLayout(page);
    let editor = await createFromDetails(page, layoutId);
    await editor.locator('[data-agreement-title]').fill('Kept title');
    await editorSave(editor).click();
    await editorClosed(page);
    await panelStatus(page, 'current');
    const [saved] = await storedAgreements(page);

    // Edit: the editor takes the dock, the panel steps aside; Cancel discards the change and brings it back.
    await agreementPanel(page).locator('[data-agreement-action="edit"]').click();
    editor = await editorOpen(page, 'Edit agreement');
    await expect(agreementPanel(page)).toBeHidden();
    await expect(page.locator('body')).not.toHaveClass(/\bagreement-panel-open\b/);
    await editor.locator('[data-agreement-title]').fill('Cancelled title');
    await editorCancel(editor).click();
    await editorClosed(page);
    await panelStatus(page, 'current');
    await expect(page.locator('#agreement-panel-title')).toHaveText('Kept title');

    // Escape while typing belongs to the field: the editor stays, with what was typed.
    await agreementPanel(page).locator('[data-agreement-action="edit"]').click();
    editor = await editorOpen(page, 'Edit agreement');
    const titleField = editor.locator('[data-agreement-title]');
    await titleField.fill('Escaped title');
    await titleField.press('Escape');
    await expect(editor).toBeVisible();
    await expect(titleField).toHaveValue('Escaped title');
    // Anywhere else Escape cancels: the panel returns, as it was, and stays open.
    await editor.locator('#agreement-editor-title').focus();
    await page.keyboard.press('Escape');
    await editorClosed(page);
    await panelStatus(page, 'current');
    await expect(page.locator('#agreement-panel-title')).toHaveText('Kept title');
    expect(await storedAgreements(page)).toEqual([saved]);
  });

  test('a proposed agreement is not edited: Add to agreement starts a new one, and its editor refuses it', async ({ mockApi: page }) => {
    test.setTimeout(240_000);
    const { layoutId } = await applyLayout(page);
    const editor = await createFromDetails(page, layoutId);
    await editor.locator('input[name="agreement-electorate"][value="community"]').check();
    await editorSave(editor).click();
    await editorClosed(page);
    await panelStatus(page, 'current');
    const panel = agreementPanel(page);
    await panel.locator('[data-agreement-action="propose"]').click();
    await chooseProfileName(page, 'Editor author');
    await panel.locator('[data-agreement-action="propose"]').click();
    await expect(panel.locator('code.agreement-panel-cid')).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-agreement-action="edit"]')).toHaveCount(0);
    const [proposed] = await storedAgreements(page);
    expect(proposed.published.cid).toBe([...pageIndex(page).agreements.keys()][0]);

    // The editor will not open on it (a change is a new agreement)...
    expect(await page.evaluate(id => (window as any).AgreementDialog.open({ agreementId: id })
      .then(() => 'opened', (error: any) => error.code), proposed.id)).toBe('agreement-published');
    await expect(agreementEditor(page)).toBeHidden();
    // ...and Add to agreement offers no proposed agreement: it opens a new one straight away.
    await panel.locator('[data-agreement-action="close"]').click();
    await showProposal(page, layoutId);
    await page.locator('#proposal-details-panel .btn-create-agreement').click();
    await expect(page.locator('.cb-dialog.agreement-add-to')).toHaveCount(0);
    const fresh = await editorOpen(page, 'Create agreement');
    await expect(fresh.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
    await editorCancel(fresh).click();
    await editorClosed(page);
    expect(await storedAgreements(page)).toEqual([proposed]);
  });
});

test.describe('The agreement editor on a phone @core', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the editor is a bottom sheet, and a click on the map above it still picks', async ({ mockApi: page }) => {
    test.setTimeout(180_000);
    const { layoutId } = await applyLayout(page);
    const title = await titleOf(page, layoutId);
    const editor = await createFromDetails(page, layoutId);

    // A sheet along the bottom (the shared dock sheet, 66% of the screen), the width of the screen,
    // with the map above it.
    const viewport = page.viewportSize()!;
    const box = (await editor.boundingBox())!;
    expect(box.width).toBeGreaterThan(viewport.width - 4);
    expect(box.y).toBeGreaterThan(viewport.height * 0.15);
    expect(box.y + box.height).toBeGreaterThan(viewport.height * 0.8);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    await expect(editorSave(editor)).toBeInViewport();

    // The design brought above the sheet is clicked there: it leaves the agreement, then returns.
    const above = { x: 0.5, y: (box.y / 2) / viewport.height };
    await clickDesign(page, layoutId, above);
    await expect(pickStatus(editor)).toHaveText(`Removed “${title}”.`);
    await expect(editor.locator(`input[data-agreement-design="${layoutId}"]`)).not.toBeChecked();
    await expect(highlight(page)).toHaveCount(0);
    await clickDesign(page, layoutId, above);
    await expect(pickStatus(editor)).toHaveText(`Added “${title}”.`);
    await expect(editor.locator(`input[data-agreement-design="${layoutId}"]`)).toBeChecked();
    await landLoaded(editor);
    await editorSave(editor).click();
    await editorClosed(page);
    await panelStatus(page, 'current');
  });
});
