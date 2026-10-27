import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, stackSection } from '../helpers/runtime';
import { proposeOverPark } from '../helpers/agreements';
import path from 'node:path';

test('an existing building cannot inherit a previously inspected design’s plans', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await openCity(page);
  const record = await proposeOverPark(page, { title: 'Park agreement' });
  await page.evaluate(async id => {
    const w = window as any; w.ClickStack.showDesign(id);
    await w.CadastralParcelRepository.ensureIds(['HR-335754-1235']);
    w.buildingFeaturePool = [{ type: 'Feature', id: 'observed-house', properties: { id: 'observed-house', name: 'Existing house', building: 'yes' },
      geometry: { type: 'Polygon', coordinates: [[[15.98272,45.80015],[15.98290,45.80015],[15.98290,45.80035],[15.98272,45.80035],[15.98272,45.80015]]] } }];
    w.document.getElementById('showBuildings').checked = true; w.rebuildBuildingLayerFromPool();
  }, record.parkId);
  await expect(stackSection(page, 'plans')).toBeVisible();
  const before = await page.evaluate(() => {
    const w = window as any; return { designs: w.proposalStorage.getAllProposals().map((p: any) => p.proposalId), agreements: JSON.stringify(w.AgreementStore.list()) };
  });
  await clickMapPoint(page, 15.98281, 45.80025);
  const building = stackSection(page, 'built'); await expect(building.locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
  await expect(building).toContainText('Existing house');
  expect(await page.locator('#click-stack .click-stack__section').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.kind))).toEqual(['built', 'parcels']);
  await expect(building.locator('.click-stack__choices')).toHaveCount(0);
  await expect(stackSection(page, 'parcels')).toContainText('1235');
  expect(await page.evaluate(() => (window as any).ClickStack.current().sections.map((s: any) => s.kind))).toEqual(['built', 'parcels']);
  expect(await page.evaluate(() => {
    const w = window as any; return { designs: w.proposalStorage.getAllProposals().map((p: any) => p.proposalId), agreements: JSON.stringify(w.AgreementStore.list()) };
  })).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('building-and-parcel.png') });
});

for (const width of [1280, 390]) {
  test(`3D building context separates baseline inspection from explicit design effects at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent('<!doctype html><html><body class="three-mode-active"><main id="map-container"></main></body></html>');
    const frontend = path.resolve(__dirname, '../../frontend');
    for (const file of ['tokens','primitives','base','map','panels','utilities','mobile-sheets','three-click-stack']) await page.addStyleTag({ path: path.join(frontend,`css/${file}.css`) });
    for (const file of ['click-stack/click-stack-model','click-stack/click-stack-relations','three-click-stack']) await page.addScriptTag({ path: path.join(frontend,`js/${file}.js`) });
    await page.evaluate(() => {
      const w = window as any;
      w.i18n = { t: (key: string) => key === 'clickStackRelations.affectedBy' ? 'Affected by design:' : key };
      w.ThreeClickStack.show({ built: [{ id: 'house', label: 'Existing house', demolition: { proposalKey: 'design' } }],
        plans: [{ id: 'plan', cid: 'plan', label: 'Redevelopment plan' }], designs: [{ id: 'design', label: 'Redevelop' }], parcels: [{ id: 'source', label: 'Source parcel' }] },
        { focus: 'built', container: document.getElementById('map-container') }, { activate(_kind: string, _instance: any, body: HTMLElement) { const p=document.createElement('p'); p.textContent='Observed building'; body.appendChild(p); }, focus() {} });
    });
    const root = page.locator('#three-click-stack');
    expect(await root.locator('.click-stack__section').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.kind))).toEqual(['built', 'parcels']);
    await expect(root.getByRole('group', { name: 'Affected by design:' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('building-explicit-impact.png') });
    await root.getByRole('button', { name: 'Redevelop', exact: true }).click();
    await expect(root.locator('[data-kind="designs"] .click-stack__row')).toHaveAttribute('aria-expanded', 'true');
    await expect(root.locator('.click-stack__section[data-kind="plans"]')).toBeVisible();
  });
}
