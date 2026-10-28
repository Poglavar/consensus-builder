// A short western approach reproduces the reported junction: edits must not leave its published
// predecessor underneath, and all rendered strips must stop at the shared junction's paint.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, showProposal, stubBasemapTiles } from '../helpers/runtime';
declare const corridorRenderState: any;

test('a published crossroad edit paints one applied alternative and one junction surface', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(120_000);
  await stubBasemapTiles(page);
  await openCity(page);
  const draw = async (points: number[][], parcelId?: string) => {
    await openParcel(page, 'proposals', parcelId);
    await page.locator('.parcel-transport-btn--road').click();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    for (const [lng, lat] of points) await clickMapPoint(page, lng, lat);
    await page.locator('#finishRoadButton').click();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
  };
  await draw([[15.982135, 45.80025], [15.98245, 45.80025]]);
  const sourceId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.roadProposal)?.proposalId);
  await page.evaluate(async () => (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235']));
  await draw([[15.9822, 45.80005], [15.9822, 45.8005]], 'HR-335754-1235');
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied && p.roadProposal).length)).toBe(2);

  // Publication is a fixture here: the test exercises the real editor's immutable-source path
  // without making a network publication. The design remains saved after its alternative applies.
  await page.evaluate(id => {
    const w = window as any;
    const source = w.proposalStorage.getProposal(id);
    source.published = { cid: w.DesignRecord.cidOf(source),
      apiBase: 'https://api.example.test', publishedAt: '2026-10-26T00:00:00Z' };
    w.proposalStorage._indexProposal(source);
    w.proposalStorage.save();
  }, sourceId);
  await showProposal(page, sourceId);
  await page.locator('#proposal-details-panel .btn-cross-section').click();
  const editor = page.locator('#corridor-editor-overlay');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  await editor.locator('.cb-lane-dropdown-toggle').click();
  await editor.locator('[data-lane-type="sidewalk"]').click();
  await editor.locator('.corridor-editor-save').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.applied, sourceId)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied && p.roadProposal).length)).toBe(2);

  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    const roads = w.proposalStorage.getAllProposals().filter((p: any) => w.isApplied(p, p.roadProposal) && p.roadProposal);
    const junctions = w.buildCorridorJunctionSet(roads.map((p: any) => ({ corridorId: p.proposalId,
      entries: w.corridorJunctionEntriesFor(p, p.roadProposal.definition) })));
    if (junctions.length !== 1 || junctions[0].degree !== 4) return 'waiting for junction';
    return junctions[0].degree;
  })).toBe(4);
  // Inspect the actual Leaflet paths, including canvas-backed paths: no driving strip may paint
  // under the junction, and the junction uses exactly the same asphalt and opacity as its arms.
  const paint = await page.evaluate(() => {
    const w = window as any;
    const state = corridorRenderState;
    const leaves = (group: any): any[] => group.getLayers ? group.getLayers().flatMap(leaves) : [group];
    const driving = [...state.byId.values()].flatMap((entry: any) => leaves(entry.group))
      .filter((layer: any) => layer.options?.className?.includes('corridor-strip--driving'));
    const surfaces = [...state.junctions.values()].flatMap(leaves)
      .filter((layer: any) => layer.options?.className === 'corridor-junction-surface');
    const overlap = driving.reduce((sum: number, layer: any) => sum + surfaces.reduce((subtotal: number, surface: any) => {
      const hit = w.turf.intersect(layer.toGeoJSON(), surface.toGeoJSON());
      return subtotal + (hit ? w.turf.area(hit) : 0);
    }, 0), 0);
    return { strips: driving.length, surfaces: surfaces.length, overlap,
      colors: [...new Set([...driving, ...surfaces].map((layer: any) => layer.options.fillColor))],
      opacity: [...new Set([...driving, ...surfaces].map((layer: any) => layer.options.fillOpacity))] };
  });
  expect(paint.strips).toBeGreaterThan(0);
  expect(paint.surfaces).toBe(1);
  expect(paint.overlap).toBeLessThan(0.02);
  expect(paint.colors).toHaveLength(1);
  expect(paint.opacity).toHaveLength(1);
  await page.evaluate(() => (window as any).map.setView([45.80025, 15.9822], 21, { animate: false }));
  await page.screenshot({ path: testInfo.outputPath('junction.png') });
});
