// Real UI coverage for direct GLB import and fresh, click-to-place design copies.
import { test, expect } from '../helpers/fixtures';
import { placeFreeformBuilding, openCity, openParcel, stubBasemapTiles, createSpace, showProposal, proposalState, clickMapPoint } from '../helpers/runtime';
import { createBuildingGlb } from '../helpers/model-fixture';

const model = createBuildingGlb('l');
const editor = '#single-building-editor';
async function openFreeform(page: any) {
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await placeFreeformBuilding(page);
  await expect(page.locator(`${editor} .on-map-editor__panel`)).toBeVisible();
}
const features = (page: any) => page.evaluate(() => (window as any).OnMapEditor.getPreview().draftPreview.features);
const footprintMeasures = (page: any, feature: any) => page.evaluate((f: any) => {
  const center = (window as any).SingleBuildingGeometry.geometryCenter(f.geometry);
  const frame = (window as any).__metricFrame.frameAt([+center.lng.toFixed(6), +center.lat.toFixed(6)]);
  const origin = frame.toMetric([center.lng, center.lat]);
  const ring = f.geometry.coordinates[0].map((point: number[]) => {
    const local = frame.toMetric(point); return [local[0] - origin[0], local[1] - origin[1]];
  });
  const area = Math.abs(ring.reduce((sum: number, point: number[], i: number) => {
    const next = ring[(i + 1) % ring.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  const xs = ring.map((p: number[]) => p[0]), ys = ring.map((p: number[]) => p[1]);
  const inside = (x: number, y: number) => {
    let value = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) value = !value;
    }
    return value;
  };
  return { area, width: Math.max(...xs) - Math.min(...xs), length: Math.max(...ys) - Math.min(...ys),
    notch: inside((Math.max(...xs) + Math.min(...xs)) / 2 + 4, (Math.max(...ys) + Math.min(...ys)) / 2 - 4),
    occupied: inside((Math.max(...xs) + Math.min(...xs)) / 2 - 4, (Math.max(...ys) + Math.min(...ys)) / 2 - 4) };
}, feature);
function expectLFootprint(measure: any, dimensions = true) {
  expect(Math.abs(measure.area - 240)).toBeLessThan(1);
  if (dimensions) {
    expect(Math.abs(measure.width - 16)).toBeLessThan(0.1);
    expect(Math.abs(measure.length - 20)).toBeLessThan(0.1);
  }
  expect(measure.notch).toBe(false);
  expect(measure.occupied).toBe(true);
}

test('Upload .glb imports into the current Freeform session and Done saves its model', async ({ mockApi: page }) => {
  let uploads = 0;
  await page.route('**/buildings/under', route => route.fulfill({ json: { supported: true, truncated: false, source: 'gdi', regions: { 'land-take': [] } } }));
  await page.route('**/models', route => { uploads++; return route.fulfill({ json: { modelUrl: '/uploads/models/direct.glb' } }); });
  await page.route('**/uploads/models/direct.glb', route => route.fulfill({ contentType: 'model/gltf-binary', body: model }));
  await openFreeform(page);
  const before = await features(page);
  await page.locator('#single-building-glb-upload').click();
  const upload = page.locator('#building-upload-modal');
  await expect(upload).toBeVisible();
  await upload.locator('#building-upload-file').setInputFiles({ name: 'direct.glb', mimeType: 'model/gltf-binary', buffer: model });
  await expect(upload.locator('#building-upload-confirm')).toBeEnabled({ timeout: 45000 });
  await upload.locator('#building-upload-confirm').click();
  await expect(upload).toHaveCount(0);
  await expect(page.locator(`${editor} .on-map-editor__panel`)).toBeVisible();
  expect(uploads).toBe(1);
  let after = await features(page);
  expect(after).toHaveLength(1);
  expect(after[0].properties).toMatchObject({ modelName: 'direct.glb', modelUrl: '/uploads/models/direct.glb', height: 16 });
  expectLFootprint(await footprintMeasures(page, after[0]));
  await page.locator('#single-building-undo').click();
  expect(await features(page)).toEqual(before);
  await page.locator('#single-building-glb-upload').click();
  await upload.locator('#building-upload-file').setInputFiles({ name: 'direct.glb', mimeType: 'model/gltf-binary', buffer: model });
  await expect(upload.locator('#building-upload-confirm')).toBeEnabled({ timeout: 45000 });
  await upload.locator('#building-upload-confirm').click();
  await expect(upload).toHaveCount(0);
  after = await features(page);
  expect(after[0].properties.modelUrl).toBe('/uploads/models/direct.glb');
  expectLFootprint(await footprintMeasures(page, after[0]), false);
  await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²');
  await page.locator('#single-building-confirm').click();
  await expect(page.locator(editor)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) =>
    p.goal === 'single' && p.geometry?.buildings?.some((f: any) => f.properties.modelUrl === '/uploads/models/direct.glb')).length)).toBe(1);
  const savedId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) =>
    p.geometry?.buildings?.some((f: any) => f.properties.modelUrl === '/uploads/models/direct.glb'))?.proposalId);
  expect(savedId).toBeTruthy();
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.applied === true, savedId)).toBe(true);
  const saved = await page.evaluate(id => (window as any).proposalStorage.getProposal(id), savedId);
  const count = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length);
  await showProposal(page, saved.proposalId);
  await page.locator('.btn-duplicate-design').click();
  await expect(page.locator('#design-duplicate-editor .on-map-editor__panel')).toBeVisible();
  await page.evaluate(() => (window as any).map.setView([45.80025, 15.9822], 18, { animate: false }));
  await clickMapPoint(page, 15.9836, 45.8006);
  await expect(page.locator('#design-duplicate-editor')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(count + 1);
  const copyId = await page.evaluate(id => (window as any).proposalStorage.getAllProposals().find((p: any) => p.proposalId !== id &&
    p.geometry?.buildings?.some((f: any) => f.properties.modelUrl === '/uploads/models/direct.glb'))?.proposalId, saved.proposalId);
  expect(copyId).toBeTruthy();
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.applied === true, copyId)).toBe(true);
  const copy = await page.evaluate(id => (window as any).proposalStorage.getProposal(id), copyId);
  expect(copy.geometry.buildings[0].properties.modelUrl).toBe('/uploads/models/direct.glb');
  expect(copy.geometry.buildings[0].properties.height).toBe(16);
  expect(copy.geometry.buildings[0].geometry).not.toEqual(saved.geometry.buildings[0].geometry);
  expectLFootprint(await footprintMeasures(page, copy.geometry.buildings[0]));
  expect(await proposalState(page, saved.proposalId)).toEqual(saved);

});

test('cancelling GLB selection preserves editor geometry and Escape dismisses only the upload', async ({ mockApi: page }) => {
  await openFreeform(page);
  const before = await features(page);
  await page.locator('#single-building-glb-upload').click();
  await expect(page.locator('#building-upload-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#building-upload-modal')).toHaveCount(0);
  await expect(page.locator(`${editor} .on-map-editor__panel`)).toBeVisible();
  expect(await features(page)).toEqual(before);
  await page.setViewportSize({ width: 390, height: 844 });
  const json = await page.locator('#single-building-geojson-upload').boundingBox();
  const glb = await page.locator('#single-building-glb-upload').boundingBox();
  expect(json && glb).toBeTruthy();
  expect(Math.abs(json!.y - glb!.y)).toBeLessThan(2);
  expect(glb!.x + glb!.width).toBeLessThanOrEqual(390);
});

test('Duplicate follows the pointer, places a fresh park and preserves the source and agreements', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await openCity(page);
  const id = await createSpace(page, 'park');
  const before = await proposalState(page, id);
  const count = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length);
  const agreementCount = await page.evaluate(() => (window as any).AgreementStore.list().length);
  await showProposal(page, id);
  await expect(page.locator('.btn-counterpropose-proposal')).toHaveCount(0);
  await page.locator('.btn-duplicate-design').click();
  await expect(page.locator('#design-duplicate-editor .on-map-editor__panel')).toBeVisible();
  await page.evaluate(() => (window as any).map.setView([45.80025, 15.9822], 18, { animate: false }));
  await clickMapPoint(page, 15.9836, 45.8006);
  await expect(page.locator('#design-duplicate-editor')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(count + 1);
  const copy = await page.evaluate(id => (window as any).proposalStorage.getAllProposals().find((p: any) => p.proposalId !== id), id);
  expect(copy.goal).toBe('park');
  expect(copy.structureProposal.geometry).not.toEqual(before.structureProposal.geometry);
  expect(copy.published).toBeFalsy();
  expect(copy.origin).toBeFalsy();
  expect(copy.freePlacement).toBe(true);
  expect(copy.binding.source).toMatch(/^server:/);
  expect(await proposalState(page, id)).toEqual(before);
  expect(await page.evaluate(() => (window as any).AgreementStore.list().length)).toBe(agreementCount);
});

test('Escape cancels Duplicate without adding a design or retaining a draft', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await openCity(page);
  const id = await createSpace(page, 'park');
  const before = await page.evaluate(() => ({ count: (window as any).proposalStorage.getAllProposals().length,
    drafts: (window as any).proposalDraftStore.listDrafts().length }));
  await showProposal(page, id);
  await page.locator('.btn-duplicate-design').click();
  await expect(page.locator('#design-duplicate-editor .on-map-editor__panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#design-duplicate-editor')).toHaveCount(0);
  expect(await page.evaluate(() => ({ count: (window as any).proposalStorage.getAllProposals().length,
    drafts: (window as any).proposalDraftStore.listDrafts().length }))).toEqual(before);
  expect(await page.evaluate(() => (window as any).__mapEditLock.isHeld())).toBe(false);
});
