import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, expandStackSection, stackSection } from '../helpers/runtime';

test('opening a design from a plan resolves its formed parcel without another map click', async ({ mockApi: page }, testInfo) => {
  await openCity(page);
  const id = await createSpace(page, 'park');
  const before = await page.evaluate(async id => {
    const w = window as any, record = w.proposalStorage.getProposal(id);
    const plan = w.PlanComposition.create('Park plan', [record], w.MapShare.capture(w));
    w.PlanWorkspace.save(plan); await w.ClickStack.showPlan(plan, { draft: true });
    return { records: JSON.stringify(w.proposalStorage.getAllProposals()), center: w.map.getCenter(), zoom: w.map.getZoom(),
      outputs: w.LiveParcelFabric.producedBy(id).map((f: any) => w.LiveParcelFabric.featureId(f)) };
  }, id);
  expect(before.outputs.length).toBeGreaterThan(0);
  await expect(stackSection(page, 'plans').locator('.click-stack__row')).toHaveAttribute('aria-expanded', 'true');
  await expandStackSection(page, 'designs');
  await expect(stackSection(page, 'formed').locator('.click-stack__row')).toBeVisible();
  expect(await page.evaluate(() => {
    const w = window as any; return w.ClickStack.current().sections.find((s: any) => s.kind === 'formed').instances.map((i: any) => i.id);
  })).toEqual(before.outputs);
  const after = await page.evaluate(() => {
    const w = window as any; return { records: JSON.stringify(w.proposalStorage.getAllProposals()), center: w.map.getCenter(), zoom: w.map.getZoom() };
  });
  expect(after).toEqual({ records: before.records, center: before.center, zoom: before.zoom });
  await page.screenshot({ path: testInfo.outputPath('plan-member-formed-parcel.png') });
  await expandStackSection(page, 'formed');
  await expect(stackSection(page, 'parcels').locator('.click-stack__row')).toBeVisible();
});
