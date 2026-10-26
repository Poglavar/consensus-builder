// Complete GeoJSON footprints use the standard Freeform editor and save as editable buildings.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal, closeParcel, showSelectionDesignTab } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';

const ring = (x: number, y: number, size: number) => [[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
const courtyard = { type: 'Feature', properties: { name: 'Uploaded courtyard', height: 18, geojsonFixture: 'courtyard' },
  geometry: { type: 'Polygon', coordinates: [ring(15.9820,45.80010,0.0002), ring(15.98205,45.80015,0.00005).reverse()] } };
const multipart = { type: 'Feature', properties: { name: 'Small buildings', floors: 2, geojsonFixture: 'small' },
  geometry: { type: 'MultiPolygon', coordinates: [[ring(15.9823,45.80010,0.00005)],[ring(15.9823,45.80025,0.00004)]] } };
const collection = { type: 'FeatureCollection', features: [courtyard, multipart] };

async function waitForLandTakeSummary(page: any) {
  await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²', { timeout: 20_000 });
}

// Geometry editing uses fixture ground. Live background tiles can remain pending through the
// lazy editor load; keep this test independent of the public image service.
test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/^https:\/\/(?:[abc]\.)?tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABmJLR0QA/wD/AP+gvaeTAAAAFElEQVQImWNkYGD4z8DAwMDEAAUADigBA7Y4ytMAAAAASUVORK5CYII=', 'base64')
  }));
});

async function openTool(page: any, kind: string) {
  if (kind === 'row') await installLayerDatasets(page);
  await openCity(page);
  if (kind === 'row') {
    await page.evaluate(async () => {
      await (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1234','HR-335754-1235','HR-335754-1236','HR-335754-1237','HR-335754-1238']);
    });
    await openParcel(page, 'info');
    await page.locator('.multi-select-detect-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
    await closeParcel(page);
    await showSelectionDesignTab(page);
  } else await openParcel(page, 'proposals');
  await page.locator(`.parcel-build-btn--${kind}`).click();
  const prompt = page.getByRole('alertdialog');
  const editor = page.locator(kind === 'single' ? '#single-building-editor' : kind === 'row' ? '#rowhouse' : '#blockify-modal').locator('.on-map-editor__panel');
  await expect.poll(async () => await editor.isVisible() || await prompt.isVisible()).toBe(true);
  if (await prompt.isVisible()) await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
  await expect(editor).toBeVisible();
}

const savedUploads = (page: any) => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
  .filter((p: any) => p.geometry?.buildings?.some((f: any) => f.properties?.geojsonFixture)));

for (const kind of ['single', 'buildings', 'row']) {
  test(`${kind} GeoJSON upload preserves all polygons and holes as ordinary editable Freeform proposals`, async ({ mockApi: page }) => {
    await openTool(page, kind);
    const file = { name: 'buildings.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(collection)) };
    if (kind === 'row') {
      const button = page.locator('#rowhouse-geojson-upload');
      if (!(await button.isVisible())) await page.locator('#rowhouse .on-map-editor__more-options > summary').click();
      const chooserPromise = page.waitForEvent('filechooser');
      await button.click();
      const chooser = await chooserPromise;
      expect(await chooser.element().evaluate(input => (input as HTMLInputElement).id)).toBe('rowhouse-geojson-input');
      await chooser.setFiles(file);
    } else {
      const input = kind === 'single' ? '#single-building-geojson-input' : '#blockify-geojson-input';
      await page.locator(input).setInputFiles(file);
    }
    await expect(page.locator('#single-building-editor .on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#single-building-selector option')).toHaveCount(3);
    // All four exterior and four courtyard vertices are handles on the selected first building.
    await expect(page.locator('#map-container .polygon-geometry-editor__vertex')).toHaveCount(8);
    await page.locator('#single-height-slider').fill('19');
    await page.locator('#single-height-slider').dispatchEvent('input');
    await waitForLandTakeSummary(page);
    await page.locator('#single-building-confirm').click();
    await expect.poll(async () => (await savedUploads(page)).filter((p: any) => p.applied).length).toBe(3);
    const records = await savedUploads(page);
    expect(records.every((p: any) => p.goal === 'single' && p.typologyType === 'single' && p.geometry.buildings.length === 1 && p.applied)).toBe(true);
    const kept = records.find((p: any) => p.geometry.buildings[0].properties.geojsonFixture === 'courtyard');
    expect(kept.geometry.buildings[0].geometry).toEqual(courtyard.geometry);
    expect(kept.geometry.buildings[0].properties.height).toBe(19);
    const small = records.filter((p: any) => p.geometry.buildings[0].properties.geojsonFixture === 'small');
    expect(small.map((p: any) => p.geometry.buildings[0].geometry.coordinates)).toEqual(multipart.geometry.coordinates);
    expect(small.every((p: any) => p.geometry.buildings[0].properties.height === 6)).toBe(true);
    expect(records.every((p: any) => !p.buildingProposal.parameters.mode)).toBe(true);

    // Reopen through the ordinary geometry action and save a height edit; never regenerate shape.
    await showProposal(page, kept.proposalId);
    await page.getByRole('button', { name: 'Edit geometry', exact: true }).click();
    await expect(page.locator('#single-building-selector option')).toHaveCount(1);
    await expect(page.locator('#map-container .polygon-geometry-editor__vertex')).toHaveCount(8);
    await page.locator('#single-height-slider').fill('20');
    await page.locator('#single-height-slider').dispatchEvent('input');
    await waitForLandTakeSummary(page);
    await page.locator('#single-building-confirm').click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.geometry?.buildings?.[0]?.properties.height, kept.proposalId)).toBe(20);
    const edited = (await savedUploads(page)).find((p: any) => p.proposalId === kept.proposalId);
    expect(edited.geometry.buildings[0].geometry).toEqual(courtyard.geometry);
  });
}

test('a partially invalid GeoJSON upload keeps the existing design unchanged', async ({ mockApi: page }) => {
  await openTool(page, 'single');
  // The initial land review completes asynchronously and writes the editor preview. Capture the
  // settled design so this check isolates the rejected upload rather than that normal startup.
  await waitForLandTakeSummary(page);
  const before = await page.evaluate(() => (window as any).getActiveProposalDesignDraft().editorPayload);
  await page.locator('#single-building-geojson-input').setInputFiles({ name: 'invalid.geojson', mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [courtyard, { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [15.982,45.8002] } }] })) });
  await expect(page.getByRole('alertdialog')).toBeVisible();
  expect(await page.evaluate(() => (window as any).getActiveProposalDesignDraft().editorPayload)).toEqual(before);
  await expect(page.locator('#single-building-selector option')).toHaveCount(1);
  expect(await savedUploads(page)).toHaveLength(0);
});

test('courtyard vertices reshape independently and undo restores the uploaded footprint', async ({ mockApi: page }) => {
  await openTool(page, 'single');
  await page.locator('#single-building-geojson-input').setInputFiles({ name: 'courtyard.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(courtyard)) });
  const handles = page.locator('#map-container .polygon-geometry-editor__vertex');
  await expect(handles).toHaveCount(8);
  const handle = handles.nth(5);
  const box = await handle.boundingBox();
  if (!box) throw new Error('Courtyard vertex is not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 15, box.y + box.height / 2 - 10, { steps: 6 });
  await page.mouse.up();
  const footprint = () => page.evaluate(() => (window as any).getActiveProposalDesignDraft().editorPayload.context.buildings[0].geometry);
  await expect.poll(async () => (await footprint()).coordinates[1]).not.toEqual(courtyard.geometry.coordinates[1]);
  expect((await footprint()).coordinates[0]).toEqual(courtyard.geometry.coordinates[0]);
  await page.locator('#single-building-undo').click();
  await expect.poll(footprint).toEqual(courtyard.geometry);
});

test('cancelling a Block upload discards the continued Freeform design session', async ({ mockApi: page }) => {
  await openTool(page, 'buildings');
  await page.locator('#blockify-geojson-input').setInputFiles({ name: 'buildings.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(collection)) });
  await expect(page.locator('#single-building-selector option')).toHaveCount(3);
  await page.locator('#single-building-editor').getByRole('button', { name: 'Cancel', exact: true }).last().click();
  const prompt = page.getByRole('alertdialog');
  await expect.poll(async () => await page.locator('#single-building-editor').count() === 0 || await prompt.isVisible()).toBe(true);
  if (await prompt.isVisible()) await prompt.getByRole('button', { name: /Discard/i }).click();
  await expect(page.locator('#single-building-editor')).toHaveCount(0);
  expect(await savedUploads(page)).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).getActiveProposalDesignDraft())).toBeNull();
});


test('a collection from the proposal form Design tab saves every building on Done', async ({ mockApi: page }) => {
  await openCity(page);
  await page.evaluate(async geometry => {
    const w = window as any;
    const site = { type: 'MultiPolygon', coordinates: [[geometry.coordinates[0]]] };
    const draft = w.proposalDraftStore.createDraft({ cityId: 'zagreb', goal: 'single', adapterKey: 'single', fields: { site, selectedParcelIds: [] }, editorPayload: {} });
    await w.openProposalDraftDesign(draft.id);
  }, courtyard.geometry);
  await page.locator('#single-building-geojson-input').setInputFiles({ name: 'buildings.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(collection)) });
  await expect(page.locator('#single-building-selector option')).toHaveCount(3);
  await waitForLandTakeSummary(page);
  await page.locator('#single-building-confirm').click();
  await expect.poll(async () => (await savedUploads(page)).filter((p: any) => p.applied).length).toBe(3);
});
