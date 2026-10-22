import { selectNativeOption } from '../helpers/controls';
// Purpose: cover real editor buttons whose effects are not asserted by the broad workflow specs.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { openCity, openParcel, drawCorridor, showProposal, proposalState, clickMapPoint, createSpace, runParcelCommand, openParcelTabAt } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { surveyResponse } from '../helpers/mocks/survey-data';

const BLOCK_PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

async function openRowHouseEditor(page: any) {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async (ids: string[]) => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
  await openParcel(page, 'info', BLOCK_PARCEL_IDS[0]);
  await page.locator('.multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await page.locator('#parcel-info-panel .close-button').click();
  await page.locator('#selection-tray [data-command="selection.propose"]').click();
  await page.locator('.parcel-build-btn--row').click();
  await expect(page.locator('#rowhouse').locator('.on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
}

test.describe('Editor button effects @features', () => {
  test('road acquiring-difficulty Help opens its explanation and Close dismisses it', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await expect(page.locator('#road-info-panel')).toBeVisible();
    await page.locator('#road-acquire-difficulty-label .acquiring-difficulty-help-icon').click();
    const explanation = page.locator('.road-acquiring-difficulty-dialog');
    await expect(explanation).toBeVisible();
    await expect(explanation).toContainText(/Government|Institution|Company|Individual/i);
    await explanation.locator('.close-circle-btn').click();
    await expect(explanation).toBeHidden();
    await page.locator('#road-acquire-difficulty-label .acquiring-difficulty-help-icon').click();
    await expect(explanation).toBeVisible();
    await explanation.locator('.btn-primary').click();
    await expect(explanation).toBeHidden();
    await page.locator('#road-info-panel .close-button').click();
  });

  test('structure geometry header Close abandons the editor without changing its source proposal', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    const before = await proposalState(page, id);
    await showProposal(page, id);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    const editor = page.locator('#structure-geometry-editor');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
    expect((await proposalState(page, id)).structureProposal).toEqual(before.structureProposal);
  });

  test('the single-building geometry Upload action opens and dismisses the model dialog, then accepts a glb', async ({ mockApi: page }) => {
    await page.route('**/models', route => route.fulfill({ json: { modelUrl: '/uploads/models/e2e-building.glb' } }));
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').click();
    const placement = page.locator('#single-building-editor');
    await expect(placement.locator('.on-map-editor__panel')).toBeVisible();
    await page.locator('#single-building-confirm').click();
    const savedId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().slice(-1)[0]?.proposalId);
    expect(savedId).toBeTruthy();
    await showProposal(page, savedId);
    // The applied building replaces parcel 1234, so select its still-live neighbor through
    // the normal map/menu flow before opening the replacement dialog.
    await page.evaluate(async () => { await (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235']); });
    await openParcel(page, 'info', 'HR-335754-1235');
    await showProposal(page, savedId);
    await page.locator('#proposal-details-panel .btn-counterpropose-proposal').click();
    const proposal = page.locator('.create-proposal-modal:visible');
    await expect(proposal).toBeVisible();
    const upload = proposal.locator('[data-geometry-action="upload"]');
    await expect(upload).toBeEnabled();
    await upload.click();
    const dialog = page.locator('#building-upload-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#building-upload-confirm')).toBeDisabled();
    await dialog.locator('#building-upload-close').click();
    await expect(dialog).toHaveCount(0);

    await upload.click();
    await expect(dialog).toBeVisible();
    await dialog.locator('#building-upload-cancel').click();
    await expect(dialog).toHaveCount(0);

    await upload.click();
    await dialog.locator('#building-upload-file').setInputFiles('../test-assets/test-building.glb');
    await expect(dialog.locator('#building-upload-confirm')).toBeEnabled({ timeout: 20_000 });
    await expect(dialog.locator('#building-upload-status')).toContainText('test-building.glb');
    await dialog.locator('#building-upload-confirm').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#single-building-editor').locator('.on-map-editor__panel')).toBeVisible();
    await page.locator('#single-building-confirm').click();
    await expect(page.locator('#single-building-editor')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).pendingBuildingProposalContext?.buildingFeature?.properties?.source)).toBe('upload');
    expect(await page.evaluate(() => (window as any).pendingBuildingProposalContext.buildingFeature.properties.modelName)).toBe('test-building.glb');
  });

  test('single-building Close dismisses its editor; rename, delete, and GeoJSON upload alter the active design', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').click();
    const modal = page.locator('#single-building-editor');
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await page.locator('#single-building-editor .on-map-editor__header .close-circle-btn').click();
    await expect(modal).toHaveCount(0);

    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').click();
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await modal.locator('details > summary').click();
    const selector = page.locator('#single-building-selector');
    const initial = await selector.locator('option').count();
    const firstBuildingId = await selector.inputValue();
    await page.locator('#single-building-add').click();
    await expect(selector.locator('option')).toHaveCount(initial + 1);
    const addedBuildingId = await selector.locator('option').last().getAttribute('value');
    expect(addedBuildingId).toBeTruthy();
    const activeFootprint = page.locator('#map-container path.single-building-fill--active');
    const addedFootprintPath = await activeFootprint.getAttribute('d');
    await selectNativeOption(selector, firstBuildingId);
    await expect(selector).toHaveValue(firstBuildingId);
    await expect.poll(() => activeFootprint.getAttribute('d')).not.toBe(addedFootprintPath);
    const firstFootprintPath = await activeFootprint.getAttribute('d');
    await selectNativeOption(selector, addedBuildingId!);
    await expect(selector).toHaveValue(addedBuildingId!);
    await expect.poll(() => activeFootprint.getAttribute('d')).toBe(addedFootprintPath);
    await page.locator('#single-building-rename').click();
    const name = page.locator('#single-building-name-input');
    await expect(name).toBeVisible();
    await name.fill('Renamed test');
    await name.press('Enter');
    await expect(selector.locator('option').last()).toHaveText(/Renamed test/);
    await page.locator('#single-building-delete').click();
    await expect(selector.locator('option')).toHaveCount(initial);
    await expect(selector).toHaveValue(firstBuildingId);
    await expect.poll(() => activeFootprint.getAttribute('d')).toBe(firstFootprintPath);

    const uploaded = {
      type: 'Feature', properties: { name: 'fixture footprint' },
      // Keep the upload fully inside fixture parcel 1234; the row-house selection is deliberately
      // narrow, so a large generic city-centre rectangle is rejected as outside its boundary.
      geometry: { type: 'Polygon', coordinates: [[[15.98206,45.800205],[15.98214,45.800205],[15.98214,45.800245],[15.98206,45.800245],[15.98206,45.800205]]] },
    };
    if (!(await page.locator('#single-building-geojson-upload').isVisible())) await page.locator('#single-building-editor details > summary').click();
    // The button opens its own file input; the chooser is taken at Playwright's boundary, so a
    // headed run never shows the native dialog.
    const singleChooser = page.waitForEvent('filechooser');
    await page.locator('#single-building-geojson-upload').click();
    const singleFiles = await singleChooser;
    expect(await singleFiles.element().evaluate(input => (input as HTMLInputElement).id)).toBe('single-building-geojson-input');
    await singleFiles.setFiles({
      name: 'footprint.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(uploaded)),
    });
    const footprint = page.locator('#map-container path.single-building-fill--active');
    await expect(footprint).toBeVisible();
    const initialPath = await footprint.getAttribute('d');
    const counterclockwise = page.locator('#single-rotate-counterclockwise');
    await expect(counterclockwise).toBeEnabled();
    await counterclockwise.click();
    await expect.poll(() => footprint.getAttribute('d')).not.toBe(initialPath);
    const counterclockwisePath = await footprint.getAttribute('d');
    const clockwise = page.locator('#single-rotate-clockwise');
    await expect(clockwise).toBeEnabled();
    await clockwise.click();
    await expect.poll(() => footprint.getAttribute('d')).not.toBe(counterclockwisePath);
    await page.locator('#single-building-confirm').click();
    await expect(modal).toHaveCount(0);
    // Done saved the uploaded footprint, turned both ways, as an applied freeform design: a four-corner
    // ring of the uploaded area.
    await expect.poll(() => page.evaluate(upload => {
      const w = window as any;
      return w.proposalStorage.getAllProposals()
        .filter((p: any) => p.applied && p.buildingProposal?.typologyType === 'single')
        .flatMap((p: any) => p.geometry?.buildings || [])
        .some((building: any) => building.geometry?.coordinates?.[0]?.length === 5
          && Math.abs(w.turf.area(building.geometry) - w.turf.area(upload)) < 1);
    }, uploaded.geometry), { timeout: 30_000 }).toBe(true);
  });

  test('row-house Close dismisses the editor without saving', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    const modal = page.locator('#rowhouse');
    await page.locator('#rowhouse .on-map-editor__header .close-circle-btn').click();
    const discard = page.getByRole('alertdialog');
    if (await discard.isVisible().catch(() => false)) {
      await discard.getByRole('button', { name: /discard|close|continue/i }).click();
    }
    await expect(modal).toHaveCount(0);
  });

  test('row-house Regenerate persists a new seed and counterclockwise rotation is saved', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    await selectNativeOption(page.locator('#rowhouse-ruletype-select'), 'range');
    const rowSeed = await page.evaluate(() => (window as any).getActiveProposalDesignDraft()?.editorPayload?.context?.parameters?.seed);
    const regenerate = page.locator('#btn-rowhouse-regenerate');
    await expect(regenerate).toBeVisible();
    await regenerate.click();
    await page.locator('#rowhouse-rotate-counterclockwise').click();
    await page.locator('#btn-rowhouse-done').click();
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();
    const context = await page.evaluate(() => (window as any).pendingBuildingProposalContext);
    expect(context.parameters.seed).not.toBe(rowSeed);
    expect(Number(context.parameters.rotation)).toBeCloseTo(5 * Math.PI / 180, 5);
  });

  test('building and parcel-based builder Close discards, while Regenerate rerolls the shown design', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    const blockify = page.locator('#blockify-modal');
    await expect(blockify.locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#blockify-modal .on-map-editor__header .close-circle-btn').click();
    await expect(blockify).toHaveCount(0);
    const parcelInfoClose = page.locator('#parcel-info-panel .close-button');
    if (await parcelInfoClose.isVisible().catch(() => false)) await parcelInfoClose.click();

    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    await selectNativeOption(page.locator('#blockify-ruletype-select'), 'max');
    const blockPreview = page.locator('#blockify-density-footprint');
    const blockBefore = await blockPreview.textContent();
    const blockSeed = await page.evaluate(() => Function('return blockVariationSeed')());
    const blockRegenerate = page.locator('#btn-blockify-regenerate');
    await expect(blockRegenerate).toBeVisible();
    for (let attempt = 0; attempt < 5 && (await blockPreview.textContent()) === blockBefore; attempt++) {
      await blockRegenerate.click();
      await expect(page.locator('#btn-blockify-done')).toBeEnabled();
    }
    await expect.poll(() => page.evaluate(() => Function('return blockVariationSeed')())).not.toBe(blockSeed);
    await expect(blockPreview).toHaveText(blockBefore || '');
    await page.locator('#blockify-modal .on-map-editor__header .close-circle-btn').click();
    await expect(blockify).toHaveCount(0);
    const parcelInfoCloseAfterBlock = page.locator('#parcel-info-panel .close-button');
    if (await parcelInfoCloseAfterBlock.isVisible().catch(() => false)) await parcelInfoCloseAfterBlock.click();

    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcelBased').click();
    const parcelBased = page.locator('#parcelbased');
    await expect(parcelBased.locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#btn-parcelbased-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#parcelbased .on-map-editor__header .close-circle-btn').click();
    const parcelDiscard = page.getByRole('alertdialog');
    if (await parcelDiscard.isVisible().catch(() => false)) {
      await parcelDiscard.getByRole('button', { name: 'Discard', exact: true }).click();
    }
    await expect(parcelBased).toHaveCount(0);
    const parcelInfoCloseForReopen = page.locator('#parcel-info-panel .close-button');
    if (await parcelInfoCloseForReopen.isVisible().catch(() => false)) await parcelInfoCloseForReopen.click();

    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcelBased').click();
    await expect(parcelBased.locator('.on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#btn-parcelbased-done')).toBeEnabled({ timeout: 20_000 });
    await selectNativeOption(page.locator('#parcelbased-ruletype-select'), 'range');
    const parcelRegenerate = page.locator('#btn-parcelbased-regenerate');
    await expect(parcelRegenerate).toBeVisible();
    const parcelSeed = await page.evaluate(() => (window as any).getActiveProposalDesignDraft()?.editorPayload?.context?.parameters?.seed);
    expect(parcelSeed).toBeTruthy();
    await parcelRegenerate.click();
    await expect.poll(() => page.evaluate(() => (window as any).getActiveProposalDesignDraft()?.editorPayload?.context?.parameters?.seed)).not.toBe(parcelSeed);
    const rerolledSeed = await page.evaluate(() => (window as any).getActiveProposalDesignDraft()?.editorPayload?.context?.parameters?.seed);
    await page.locator('#btn-parcelbased-done').click();
    await expect(parcelBased).toHaveCount(0);
    const rerolled = await page.evaluate(() => (window as any).pendingBuildingProposalContext.parameters.seed);
    expect(rerolled).toBe(rerolledSeed);
  });

  test('manual building Upload GeoJSON routes the footprint into the editable Freeform tool', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    const uploaded = {
      type: 'Feature', properties: { name: 'fixture manual footprint', geojsonFixture: 'manual-block' },
      geometry: { type: 'Polygon', coordinates: [[[15.9820,45.80010],[15.98235,45.80010],[15.98235,45.80030],[15.9820,45.80030],[15.9820,45.80010]]] },
    };
    const upload = page.locator('#blockify-geojson-upload');
    if (!(await upload.isVisible())) {
      await page.locator('#blockify-modal .on-map-editor__more-options > summary').click();
    }
    await expect(upload).toBeVisible();
    const blockChooser = page.waitForEvent('filechooser');
    await upload.click();
    const blockFiles = await blockChooser;
    expect(await blockFiles.element().evaluate(input => (input as HTMLInputElement).id)).toBe('blockify-geojson-input');
    await blockFiles.setFiles({
      name: 'block-footprint.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(uploaded)),
    });
    // The import hands geometry to the ordinary Freeform editor instead of retaining the legacy Block editor.
    await expect(page.locator('#single-building-editor .on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#map-container .polygon-geometry-editor__vertex')).toHaveCount(4);
    await page.locator('#single-building-confirm').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) =>
      p.geometry?.buildings?.some((feature: any) => feature.properties?.geojsonFixture === 'manual-block')))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) =>
      p.geometry?.buildings?.some((feature: any) => feature.properties?.geojsonFixture === 'manual-block')));
    expect(saved.geometry.buildings[0].geometry).toEqual(uploaded.geometry);
  });

  test('building manual Edit disables parametric sliders and confirms before discarding the manual shape', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    const modal = page.locator('#blockify-modal');
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    if (!(await page.locator('#blockify-manual-toggle').isVisible())) await page.locator('#blockify-modal .on-map-editor__more-options > summary').click();
    const manualToggle = page.locator('#blockify-manual-toggle');
    const setback = modal.locator('#setback-slider');
    const initialSetback = await setback.inputValue();
    await setback.focus();
    await setback.press('ArrowRight');
    await expect.poll(() => setback.inputValue()).not.toBe(initialSetback);
    await manualToggle.click();
    await expect(manualToggle).toHaveAttribute('aria-pressed', 'true');
    const parameterSliders = modal.locator('#setback-slider, #chamfer-slider, #simplify-slider, #width-slider, #gaps-slider, #gap-width-slider, #wings-slider, #wing-length-slider');
    await expect(parameterSliders).toHaveCount(8);
    for (const slider of await parameterSliders.all()) await expect(slider).toBeDisabled();
    await expect.poll(() => page.locator('#map-container .polygon-geometry-editor__vertex').count()).toBeGreaterThan(2);

    await manualToggle.click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(/Discard manual edits and go back to the sliders/i);
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(manualToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(parameterSliders.first()).toBeDisabled();

    await manualToggle.click();
    const discard = page.getByRole('alertdialog');
    await discard.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(discard).toHaveCount(0);
    await expect(manualToggle).toHaveAttribute('aria-pressed', 'false');
    for (const slider of await parameterSliders.all()) await expect(slider).toBeEnabled();
    await page.locator('#blockify-modal .on-map-editor__header .close-circle-btn').click();
    const closeDialog = page.getByRole('alertdialog');
    if (await closeDialog.isVisible().catch(() => false)) {
      await closeDialog.getByRole('button', { name: /discard|close|continue/i }).click();
    }
    await expect(modal).toHaveCount(0);
  });

  test('site plot Back returns to editing and Continue opens the parcel tool on those plots', async ({ mockApi: page }) => {
    await openCity(page);
    await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
    await expect(page.locator('#site-panel')).toBeVisible();
    await page.locator('#site-panel [data-site-action="propose"]').click();
    await page.locator('#site-info-panel .parcel-build-btn--parcelBased').click();
    await expect(page.locator('#site-panel [data-site-action="plots-back"]')).toBeVisible();
    await expect(page.locator('#site-panel [data-site-action="plots-continue"]')).toBeEnabled();
    await page.locator('#site-panel [data-site-action="plots-back"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).SiteTool.current().phase)).toBe('editing');
    await page.locator('#site-panel [data-site-action="propose"]').click();
    await page.locator('#site-info-panel .parcel-build-btn--parcelBased').click();
    await page.locator('#site-panel [data-site-action="plots-continue"]').click();
    await expect(page.locator('#site-panel')).toBeHidden();
    await expect(page.locator('#parcelbased').locator('.on-map-editor__panel')).toBeVisible();
  });

  test('site Include and Trim reshape the authored site at a small parcel intrusion', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(async () => { await (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235']); });
    const drawPartialSite = async () => {
      // A deliberate parcel click loads its live geometry into the site preview's cadastral fabric.
      await clickMapPoint(page, 15.9828, 45.80025);
      await expect(page.locator('#click-stack')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#click-stack')).toBeHidden();
      await expect.poll(() => page.evaluate(() => !!(window as any).LiveParcelFabric.get('HR-335754-1235'))).toBe(true);
      await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
      await page.locator('#site-panel [data-site-action="redraw"]').click();
      await clickMapPoint(page, 15.9820, 45.80010);
      // Hold Alt to suppress the normal parcel-edge snap. Intrude 10 cm into 1235: above
      // the 1 mm noise floor, below the small-intrusion warning threshold.
      await page.keyboard.down('Alt');
      await clickMapPoint(page, 15.9826013, 45.80010);
      await clickMapPoint(page, 15.9826013, 45.80040);
      await page.keyboard.up('Alt');
      await clickMapPoint(page, 15.9820, 45.80040);
      await page.locator('#site-panel [data-site-action="finish"]').click();
      await expect(page.locator('#site-panel [data-site-include="HR-335754-1235"]')).toBeVisible();
    };

    await drawPartialSite();
    const area = () => page.evaluate(() => (window as any).turf.area((window as any).SiteTool.current().site));
    const beforeInclude = await area();
    await page.locator('#site-panel [data-site-include="HR-335754-1235"]').click();
    await expect.poll(area).toBeGreaterThan(beforeInclude);
    await page.locator('#site-panel [data-site-action="cancel"]').first().click();

    await drawPartialSite();
    const beforeTrim = await area();
    await page.locator('#site-panel [data-site-trim="HR-335754-1235"]').click();
    await expect.poll(area).toBeLessThan(beforeTrim);
    await page.locator('#site-panel [data-site-action="cancel"]').first().click();
  });

  test('site polygon editor floating Undo removes the corner inserted from the map', async ({ mockApi: page }) => {
    await openCity(page);
    await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
    const ring = () => page.evaluate(() => (window as any).SiteTool.current().ring.length);
    const before = await ring();
    const undo = page.locator('.geom-undo-button');
    await expect(undo).toBeVisible();
    await clickMapPoint(page, 15.9822, 45.8000);
    await expect.poll(ring).toBe(before + 1);
    await expect(undo).toBeEnabled();
    const undoHit = await undo.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button;
    });
    expect(undoHit).toBe(true);
    await undo.click();
    await expect.poll(ring).toBe(before);
  });

  test('building survey picker Cancel keeps the map state and Show applies the selected surveys', async ({ mockApi: page }) => {
    await page.route('**/buildings**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/buildings') return route.continue();
      const feature = {
        type: 'Feature',
        properties: { object_id: 61075, height_m: 14 },
        geometry: { type: 'Polygon', coordinates: [[[15.98208,45.80008],[15.98224,45.80008],[15.98224,45.80022],[15.98208,45.80022],[15.98208,45.80008]]] },
      };
      return route.fulfill({ json: { ...surveyResponse([feature]), source: url.searchParams.get('source') } });
    });
    await openCity(page);
    await page.evaluate(() => (window as any).map.setView([45.80015, 15.98216], 18, { animate: false }));
    await page.locator('#layers-button').click();
    await page.locator('#layers-button').click();
    await page.keyboard.press('b');
    const dialog = page.locator('.building-layers-dialog');
    await expect(dialog).toBeVisible();
    const gdi = dialog.locator('input[type="checkbox"]').nth(0);
    const wasChecked = await page.locator('#showBuildings').isChecked();
    await gdi.setChecked(!await gdi.isChecked());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#showBuildings')).toHaveJSProperty('checked', wasChecked);

    await page.keyboard.press('b');
    const showDialog = page.locator('.building-layers-dialog');
    const dgu = showDialog.locator('input[type="checkbox"]').nth(1);
    await dgu.check();
    await showDialog.getByRole('button', { name: 'Show', exact: true }).click();
    await expect(showDialog).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).dguBuildingLayer))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).dguBuildingLayer.getLayers().length)).toBeGreaterThan(0);
  });

  test('transit station editor Close, Cancel, and Done close the editor with the expected draft result', async ({ mockApi: page }) => {
    await openCity(page);
    await drawCorridor(page, 'road');
    await openParcelTabAt(page, 15.9822, 45.80045, 'propose-tab');
    await page.locator('#parcel-info-panel .parcel-transport-btn--bus').click();
    await clickMapPoint(page, 15.9822, 45.80025);
    const stationId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.stationType === 'bus')?.proposalId);
    expect(stationId).toBeTruthy();

    await showProposal(page, stationId);
    const openEditor = async () => {
      await page.locator('#proposal-details-footer .btn-edit-geometry').click();
      await expect(page.locator('#station-geometry-editor').locator('.on-map-editor__panel')).toBeVisible();
      return page.locator('#station-geometry-editor');
    };
    const acceptDiscard = async () => {
      const discard = page.getByRole('button', { name: 'Discard', exact: true });
      if (await discard.isVisible().catch(() => false)) await discard.click();
    };
    let editor = await openEditor();
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await acceptDiscard();
    await expect(editor).toBeHidden();

    await showProposal(page, stationId);
    editor = await openEditor();
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await acceptDiscard();
    await expect(editor).toBeHidden();

    await showProposal(page, stationId);
    editor = await openEditor();
    await editor.locator('[data-station-editor-bearing]').fill('45');
    await editor.locator('[data-station-editor-bearing]').press('Tab');
    await expect(editor.locator('[data-station-editor-bearing-range]')).toHaveValue('45');
    await editor.locator('[data-station-editor-action="save"]').click();
    await expect(editor).toBeHidden();
    // The unpublished station is saved in place (c7ef3630): same id, one bus station.
    await expect.poll(() => page.evaluate(id => Number((window as any).proposalStorage.getProposal(id)?.structureProposal?.bearing), stationId)).toBe(45);
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.structureProposal?.stationType === 'bus').length)).toBe(1);
  });

  test('placed corridor tabs switch views and section lane buttons select and remove a lane', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await drawCorridor(page, 'road');
    await showProposal(page, id);
    const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('#proposal-details-panel .btn-cross-section').click();
    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

    await editor.locator('.corridor-editor-tab[data-tab="corridor"]').click();
    await expect(editor.locator('.corridor-editor-tab[data-tab="corridor"]')).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('.corridor-editor-body .corridor-stats')).toBeVisible();
    await editor.locator('.corridor-editor-tab[data-tab="section"]').click();
    await expect(editor.locator('.corridor-section')).toBeVisible();

    const lanes = editor.locator('.corridor-section-lane');
    const rows = editor.locator('.corridor-lane-row');
    const before = await rows.count();
    expect(before).toBeGreaterThan(1);
    await lanes.nth(1).click();
    await expect(rows.nth(1)).toHaveClass(/corridor-lane-row--selected/);
    const laneWidth = rows.nth(1).locator('.corridor-lane-width');
    const originalWidth = Number(await laneWidth.inputValue());
    await laneWidth.fill(String(originalWidth + 1.25));
    await laneWidth.press('Enter');
    await expect(rows.nth(1).locator('.corridor-lane-standard--reset')).toBeVisible();
    const editedWidth = Number(await laneWidth.inputValue());
    await rows.nth(1).locator('.corridor-lane-standard--reset').click();
    await expect.poll(async () => Number(await laneWidth.inputValue())).not.toBe(editedWidth);
    const beforeOrder = await rows.locator('.corridor-lane-type').evaluateAll(nodes => nodes.map(node => (node as HTMLSelectElement).value));
    await rows.first().getByRole('button', { name: 'Move inward' }).click();
    await expect.poll(() => rows.locator('.corridor-lane-type').evaluateAll(nodes => nodes.map(node => (node as HTMLSelectElement).value))).not.toEqual(beforeOrder);
    await lanes.first().click();
    await rows.first().getByRole('button', { name: 'Remove lane' }).click();
    await expect(rows).toHaveCount(before - 1);
    await expect(editor.locator('.corridor-editor-save')).toBeEnabled();
    const dguSurvey = editor.locator('.corridor-limit-option[data-survey="dgu"]');
    const previousSurvey = await dguSurvey.getAttribute('aria-pressed');
    await dguSurvey.click();
    await expect(dguSurvey).toHaveAttribute('aria-pressed', previousSurvey === 'true' ? 'false' : 'true');
    const parcelLimit = editor.locator('.corridor-limit-option[data-limit="parcels"]');
    const oldLimit = await parcelLimit.getAttribute('aria-pressed');
    await parcelLimit.click();
    await expect(parcelLimit).toHaveAttribute('aria-pressed', oldLimit === 'true' ? 'false' : 'true');
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
    expect((await proposalState(page, id)).roadProposal.definition.profile.strips.length).toBe(before);
  });

  test('corridor clearance fit controls move a widened road through the live editor', async ({ mockApi: page }) => {
    await page.route('**/buildings**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/buildings') return route.continue();
      const feature = {
        type: 'Feature', properties: { object_id: 61075, height_m: 14 },
        // The 7.5 m road starts 5.25 m south of this footprint, leaving a 1.5 m baseline
        // clearance. Widening its 2 m north-side sidewalk to 6 m makes the 13.5 m road
        // reach 6.75 m north of center, so it intersects by 1.5 m with the same margin.
        geometry: { type: 'Polygon', coordinates: [[[15.98208,45.8002972],[15.98224,45.8002972],[15.98224,45.8004312],[15.98208,45.8004312],[15.98208,45.8002972]]] },
      };
      return route.fulfill({ json: { ...surveyResponse([feature]), source: url.searchParams.get('source') } });
    });
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    await clickMapPoint(page, 15.98195, 45.80025);
    await clickMapPoint(page, 15.98245, 45.80025);
    await page.locator('#finishRoadButton').click();
    const clearance = page.getByRole('alertdialog');
    await expect(clearance).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.roadProposal && p.applied))).toBe(true);
    const id = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.roadProposal && p.applied).proposalId);
    await showProposal(page, id);
    const details = page.locator('#proposal-details-panel');
    const expand = details.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await details.locator('.btn-cross-section').click();
    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="sidewalk"]').click();
    const widenedLane = editor.locator('.corridor-lane-width').nth(1);
    await expect(widenedLane).toHaveValue('2');
    await widenedLane.fill('6');
    await widenedLane.press('Tab');
    await expect(widenedLane).toHaveValue('6');
    await expect(editor.locator('.corridor-editor-total')).toHaveText('13.5 m');
    const fitHint = editor.locator('.corridor-editor-indicator--fit');
    await expect(fitHint).toBeVisible({ timeout: 15_000 });
    await fitHint.click();
    await expect(editor.locator('.corridor-editor-tab[data-tab="corridor"]')).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('.corridor-editor-body .corridor-stats')).toBeVisible({ timeout: 15_000 });

    const beforeSide = await proposalState(page, id);
    const sideFit = editor.locator('.corridor-fit-side:not([disabled])').first();
    await expect(sideFit).toBeVisible();
    await sideFit.click();
    // Fit actions commit the moved road together with its pending cross-section immediately.
    await expect.poll(async () => JSON.stringify((await proposalState(page, id)).roadProposal.definition.segments)).not.toBe(JSON.stringify(beforeSide.roadProposal.definition.segments));
    expect((await proposalState(page, id)).roadProposal.definition.profile.strips.length).toBe(beforeSide.roadProposal.definition.profile.strips.length + 1);
    await expect(editor.locator('.corridor-editor-save')).toBeDisabled();
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);

    await showProposal(page, id);
    const detailsAgain = page.locator('#proposal-details-panel');
    const expandAgain = detailsAgain.getByRole('button', { name: 'Expand', exact: true });
    if (await expandAgain.isVisible()) await expandAgain.click();
    await detailsAgain.locator('.btn-cross-section').click();
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    await editor.locator('.corridor-editor-tab[data-tab="section"]').click();
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="sidewalk"]').click();
    // The first fit action shifted this 13.5 m road 3 m south. It now has about 1.6 m of room to
    // the building; the default 2 m addition would still fit, so widen this new lane to 6 m.
    const secondWidenedLane = editor.locator('.corridor-lane-width').nth(1);
    await expect(secondWidenedLane).toHaveValue('2');
    await secondWidenedLane.fill('6');
    await secondWidenedLane.press('Tab');
    await expect(secondWidenedLane).toHaveValue('6');
    await expect(editor.locator('.corridor-editor-total')).toHaveText('19.5 m');
    await editor.locator('.corridor-editor-tab[data-tab="corridor"]').click();
    const beforeMove = await proposalState(page, id);
    const moveToFit = editor.locator('.corridor-fit-move');
    await expect(moveToFit).toBeVisible({ timeout: 15_000 });
    await moveToFit.click();
    await expect.poll(async () => JSON.stringify((await proposalState(page, id)).roadProposal.definition.segments)).not.toBe(JSON.stringify(beforeMove.roadProposal.definition.segments));
    const moved = await proposalState(page, id);
    expect(moved.roadProposal.definition.profile.strips.length).toBe(beforeMove.roadProposal.definition.profile.strips.length + 1);
    await expect(editor.locator('.corridor-editor-save')).toBeDisabled();
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await page.reload();
    await waitForMapReady(page);
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.segments).toEqual(moved.roadProposal.definition.segments);
  });

  test('drawing cross-section Cancel discards lane edits but keeps the road drawing active', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await page.locator('#editRoadCrossSectionButton').click();
    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    const before = await editor.locator('.corridor-lane-row').count();
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="sidewalk"]').click();
    await expect(editor.locator('.corridor-lane-row')).toHaveCount(before + 1);
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    await page.locator('#editRoadCrossSectionButton').click();
    const reopened = page.locator('#corridor-editor-overlay');
    await expect(reopened.locator('.corridor-lane-row')).toHaveCount(before);
    await reopened.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(reopened).toHaveCount(0);
  });

  test('Add lane selects each remaining surface type at its standard width in the section diagram', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await page.locator('#editRoadCrossSectionButton').click();
    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    const variants = [
      { type: 'driving', label: 'Traffic lane', width: 3 },
      { type: 'bus', label: 'Bus lane', width: 3.5 },
      { type: 'parking', label: 'Parallel parking', width: 2.5 },
      { type: 'parking_perpendicular', label: 'Perpendicular parking', width: 5 },
      { type: 'parking_angled', label: 'Angled parking', width: 4.5 },
      { type: 'cycleway', label: 'Cycle path', width: 1.5 },
      { type: 'median', label: 'Median', width: 2.5 },
      { type: 'rail', label: 'Track', width: 3.5 },
    ];
    for (const variant of variants) {
      const beforeCount = await editor.locator('.corridor-lane-row').count();
      await editor.locator('.cb-lane-dropdown-toggle').click();
      const option = editor.locator(`.cb-lane-option[data-lane-type="${variant.type}"]`);
      await expect(option).toBeVisible();
      await option.click();
      const row = editor.locator('.corridor-lane-row--selected');
      await expect(editor.locator('.corridor-lane-row')).toHaveCount(beforeCount + 1);
      await expect(row).toHaveCount(1);
      await expect(row.locator('.corridor-lane-type')).toHaveValue(variant.type);
      const width = Number(await row.locator('.corridor-lane-width').inputValue());
      expect(width).toBe(variant.width);
      const index = await row.getAttribute('data-lane-index');
      const schematic = editor.locator(`.corridor-section-lane[data-lane-index="${index}"]`);
      await expect(schematic).toHaveAttribute('aria-label', new RegExp(`${variant.label}, ${width} metres`));
      await expect(schematic).toHaveClass(/corridor-section-lane--selected/);
    }
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
    await page.locator('#road-drawing-controls').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
  });
});
