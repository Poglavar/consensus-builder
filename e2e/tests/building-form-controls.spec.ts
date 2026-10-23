// Behavioral coverage for building-rule sliders, boundary handles and the existing-footprint rule.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, closeParcel } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import { selectNativeOption } from '../helpers/controls';

const BLOCK_PARCEL_IDS = [
  'HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238',
];

async function openBlockEditor(page: any) {
  await installLayerDatasets(page);
  await openCity(page);
  await openParcel(page, 'proposals', BLOCK_PARCEL_IDS[3]);
  await page.locator('.parcel-build-btn--buildings').click();
  const prompt = page.getByRole('alertdialog');
  if (await prompt.isVisible().catch(() => false)) {
    await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
  }
  await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
}

async function editSlider(page: any, root: string, selector: string, key = 'ArrowRight', direction: 'up' | 'down' = 'up', changesPreview = true): Promise<number> {
  const slider = page.locator(root).locator(selector);
  if (!(await slider.isVisible())) await page.locator(root).locator('.on-map-editor__more-options > summary').click();
  await expect(slider).toBeVisible();
  await expect(slider).toBeEnabled();
  const previousPreview = await page.evaluate(() => {
    const preview = (window as any).OnMapEditor.getPreview();
    const describe = (feature: any) => ({
      height: feature.properties?.height,
      numGaps: feature.properties?.numGaps,
      gapWidth: feature.properties?.gapWidth,
      numWings: feature.properties?.numWings,
      wingLength: feature.properties?.wingLength,
      rule: feature.properties?.urbanRule,
      minFootprint: feature.properties?.minFootprint,
      rings: feature.geometry?.coordinates || [],
    });
    return JSON.stringify({
      draft: (preview?.draftPreview?.features || []).map(describe),
      envelopes: (preview?.envelopes || []).map(describe),
      excluded: preview?.excluded?.length || 0,
    });
  });
  const previous = Number(await slider.inputValue());
  await slider.focus();
  await slider.press(key);
  const value = Number(await slider.inputValue());
  if (direction === 'down') expect(value).toBeLessThan(previous);
  else expect(value).toBeGreaterThan(previous);
  if (changesPreview) await expect.poll(() => page.evaluate(() => {
    const preview = (window as any).OnMapEditor.getPreview();
    const describe = (feature: any) => ({
      height: feature.properties?.height,
      numGaps: feature.properties?.numGaps,
      gapWidth: feature.properties?.gapWidth,
      numWings: feature.properties?.numWings,
      wingLength: feature.properties?.wingLength,
      rule: feature.properties?.urbanRule,
      minFootprint: feature.properties?.minFootprint,
      rings: feature.geometry?.coordinates || [],
    });
    return JSON.stringify({
      draft: (preview?.draftPreview?.features || []).map(describe),
      envelopes: (preview?.envelopes || []).map(describe),
      excluded: preview?.excluded?.length || 0,
    });
  })).not.toBe(previousPreview);
  return value;
}

async function dragBoundaryHandle(page: any, kind: 'gap' | 'wing'): Promise<number> {
  const positions = () => page.evaluate((key: string) =>
    (window as any).getActiveProposalDesignDraft().editorPayload.context.parameters[key], `${kind}s`);
  const before = (await positions())[0];
  const handle = page.locator(`.blockify-handle--${kind}`).first();
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (!box) throw new Error(`The ${kind} drag handle has no map position`);
  // Read the generated ring only to aim a real pointer drag along the editable boundary.
  const ring = await page.evaluate('lastOuterRing');
  const target = await page.evaluate(({ ring, fraction }: any) => {
    const w = window as any;
    const line = w.turf.lineString(ring);
    const distance = w.turf.length(line, { units: 'meters' }) * fraction;
    const [lng, lat] = w.turf.along(line, distance, { units: 'meters' }).geometry.coordinates;
    const point = w.map.latLngToContainerPoint([lat, lng]);
    const rect = w.map.getContainer().getBoundingClientRect();
    return { x: rect.left + point.x, y: rect.top + point.y };
  }, { ring, fraction: (before + 0.17) % 1 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await positions())[0]).not.toBe(before);
  return (await positions())[0];
}

test.describe('Building editor complete form controls @features', () => {
  test('block massing sliders regenerate and save their rule and geometry parameters', async ({ mockApi: page }) => {
    test.setTimeout(90_000);
    await openBlockEditor(page);

    const root = '#blockify-modal';
    const setback = await editSlider(page, root, '#setback-slider');
    await editSlider(page, root, '#width-slider', 'ArrowLeft', 'down');
    const chamfer = await editSlider(page, root, '#chamfer-slider');
    // Simplifying this straight parcel boundary need not move a corner. Its readout and saved
    // parameter must still follow the real input; the other sliders change the shown geometry.
    const simplify = await editSlider(page, root, '#simplify-slider', 'ArrowRight', 'up', false);
    await expect(page.locator('#simplify-value')).toHaveText(simplify.toFixed(1));

    await selectNativeOption(page.locator(root).locator('#blockify-ruletype-select'), 'range');
    await expect(page.locator(root).locator('#blockify-minheight-group')).toBeVisible();
    await expect(page.locator(root).locator('#blockify-mindepth-group')).toBeVisible();
    const minHeight = await editSlider(page, root, '#blockify-minheight-slider');
    const minDepth = await editSlider(page, root, '#blockify-mindepth-slider');

    await editSlider(page, root, '#gaps-slider');
    const gapWidth = await editSlider(page, root, '#gap-width-slider');
    const gapPosition = await dragBoundaryHandle(page, 'gap');
    await editSlider(page, root, '#wings-slider');
    const wingLength = await editSlider(page, root, '#wing-length-slider');
    const wingPosition = await dragBoundaryHandle(page, 'wing');

    await page.locator('#btn-blockify-done').click();
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.typology === 'block'))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.typology === 'block'));
    const parameters = saved.buildingProposal.parameters;
    expect(parameters).toMatchObject({ setback, chamfer, simplify });
    expect(parameters.rule).toMatchObject({ kind: 'range', minHeightM: minHeight, minDepthM: minDepth });
    expect(parameters.gaps).toEqual([gapPosition]);
    expect(parameters.wings).toEqual([wingPosition]);
    expect(saved.geometry.buildings.length).toBeGreaterThan(0);
    expect(saved.geometry.buildings.some((building: any) => Number(building.properties.numGaps) === 1
      && Number(building.properties.gapWidth) === gapWidth
      && Number(building.properties.numWings) === 1
      && Number(building.properties.wingLength) === wingLength)).toBe(true);
  });

  test('existing-footprint exact rule can be selected and persists on the applied proposal', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(id => (window as any).CadastralParcelRepository.ensureIds([id]), BLOCK_PARCEL_IDS[3]);
    await openParcel(page, 'proposals', BLOCK_PARCEL_IDS[3]);
    await page.locator('.parcel-build-btn--buildings').click();
    const prompt = page.getByRole('alertdialog');
    if (await prompt.isVisible().catch(() => false)) {
      await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#blockify-existing-toggle').check();
    await page.locator('#blockify-rule-additional').check();
    await page.locator('#blockify-rule-exact').check();
    await expect(page.locator('#blockify-rule-exact')).toBeChecked();
    const proposedFloors = await editSlider(page, '#blockify-modal', '#proposed-height-slider');
    await page.locator('#btn-blockify-done').click();
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.mode === 'existing'))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.mode === 'existing'));
    expect(saved.buildingProposal.parameters).toMatchObject({ mode: 'existing', rule: 'exact', proposedHeightFloors: proposedFloors });
    expect(saved.geometry.buildings.length).toBeGreaterThan(0);
    expect(saved.geometry.buildings.every((building: any) => building.properties.height
      === proposedFloors * saved.buildingProposal.parameters.floorHeightM)).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.proposalId === id && proposal.applied
        && proposal.buildingProposal?.parameters?.mode === 'existing'
        && proposal.buildingProposal?.parameters?.rule === 'exact'), saved.proposalId)).toBe(true);
  });

  test('row-house minimum plot and chamfer edits regenerate and persist', async ({ mockApi: page }) => {
    test.setTimeout(60_000);
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), BLOCK_PARCEL_IDS);
    await openParcel(page, 'info', BLOCK_PARCEL_IDS[0]);
    await page.locator('.multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
    await closeParcel(page);
    await page.locator('#selection-tray [data-command="selection.propose"]').click();
    await page.locator('.parcel-build-btn--row').click();
    const prompt = page.getByRole('alertdialog');
    if (await prompt.isVisible().catch(() => false)) {
      await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
    const root = '#rowhouse';
    const minPlot = await editSlider(page, root, '#rowhouse-minplot-slider', 'Home', 'down');
    const length = await editSlider(page, root, '#rowhouse-length-slider', 'Home', 'down');
    const height = await editSlider(page, root, '#rowhouse-height-slider');
    await page.locator('#rowhouse .on-map-editor__more-options > summary').click();
    const chamfer = await editSlider(page, root, '#rowhouse-chamfer-slider');
    await page.locator('#btn-rowhouse-done').click();
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.typology === 'row'))).toBe(true);
    const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.applied && proposal.buildingProposal?.parameters?.typology === 'row'));
    expect(saved.buildingProposal.parameters.chamfer).toBe(chamfer);
    expect(saved.buildingProposal.parameters).toMatchObject({ length, height });
    expect(saved.buildingProposal.parameters.rule.minPlotAreaM2).toBe(minPlot);
    expect(saved.geometry.buildings.length).toBeGreaterThan(0);
  });
});
