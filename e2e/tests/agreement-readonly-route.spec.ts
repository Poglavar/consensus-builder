import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { agreementPanel } from '../helpers/agreements';
import { fileAgreement, fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';

test('a Plan agreement link opens terms without applying or storing designs', async ({ mockApi: primary }) => {
  await stubBasemapTiles(primary);
  await openCity(primary);
  const city = await primary.evaluate(() => (window as any).CityConfigManager.getCurrentCityId());
  const index = pageIndex(primary);
  const designCid = fileDesign(index, {
    schema: 'design/v1', goal: 'park', title: 'Shared read-only agreement park', description: null, author: 'fixture',
    city, site: { type: 'Polygon', coordinates: [[[15.96,45.8],[15.9601,45.8],[15.9601,45.8001],[15.96,45.8001],[15.96,45.8]]] }, toleranceM: null, geometry: null, origin: null, authoredAt: new Date().toISOString(),
    structureProposal: { kind: 'park', blockName: null },
  });
  const planContent = await primary.evaluate(({ designCid, city }) => (window as any).PlanRecord.create('Shared read-only agreement', [designCid],
    { at: '45.8,15.96,16', mode: '2d', city, language: 'en' }), { designCid, city });
  const planCid = filePlan(index, planContent);
  const cid = fileAgreement(index, {
    schema: 'agreement/v1', title: 'Shared read-only agreement', author: 'fixture', sponsor: null, city,
    createdAt: new Date().toISOString(), planCid,
    inputs: { parcels: [{ parcelId: 'HR-335614-2311', areaM2: 120, holders: [] }], openGroundM2: 0 },
    outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
    rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, deadline: null,
  });
  await primary.evaluate(async planCid => {
    const w = window as any;
    const plan = await w.NamedPlans.fetchPlan(planCid);
    await w.ClickStack.showPlan({ cid: planCid, content: plan.content });
  }, planCid);
  const section = primary.locator('#click-stack .click-stack__section[data-kind="agreements"]');
  await expect(section).toBeVisible();
  await section.locator('.click-stack__row').click();

  const panel = agreementPanel(primary);
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
  await expect(panel.locator('[data-agreement-plan-design-count]')).toHaveText('Designs in the plan (1)');
  await expect(panel.locator('.agreement-panel-designs, [data-agreement-design]')).toHaveCount(0);
  await expect(panel.locator('[data-agreement-read-only-status]')).toContainText('Local map status is not evaluated');
  await expect(panel.locator('[data-agreement-status], [data-agreement-action="edit"], [data-agreement-action="delete"], [data-agreement-action="propose"]')).toHaveCount(0);
  expect(await primary.evaluate(() => (window as any).AgreementStore.list())).toEqual([]);
  expect(await primary.evaluate(() => (window as any).proposalStorage.getAllProposals())).toEqual([]);
  await primary.locator('#click-stack .click-stack__content-tabs').getByRole('tab', { name: 'Info', exact: true }).click();
  await expect(panel.locator('[data-agreement-action="plan"]')).toBeVisible();
  await expect(panel).toHaveClass(/is-hosted/);
  await expect(primary.getByRole('button', { name: 'Agreement details', exact: true })).toHaveCount(0);

  const requests = index.requests;
  expect(requests.some(request => request.method === 'GET' && request.path === `/agreements/${cid}`)).toBe(true);
  expect(requests.some(request => request.method === 'POST' && request.path === '/designs/batch'
    && request.body.cids.includes(designCid))).toBe(true);
  expect(requests.filter(request => request.method === 'POST' && request.path !== '/designs/batch')).toEqual([]);
});
