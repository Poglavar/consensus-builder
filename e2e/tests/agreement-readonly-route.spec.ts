import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { agreementPanel } from '../helpers/agreements';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedIndex, fileAgreement, fileDesign, pageIndex } from '../helpers/mocks/shared-server';

test('a same-context secondary tab opens a published agreement without applying or storing it', async ({ mockApi: primary }) => {
  await stubBasemapTiles(primary);
  await openCity(primary);
  const city = await primary.evaluate(() => (window as any).CityConfigManager.getCurrentCityId());
  const index = pageIndex(primary);
  const designCid = fileDesign(index, {
    schema: 'design/v1', goal: 'park', title: 'Shared read-only agreement park', description: null, author: 'fixture',
    city, site: null, toleranceM: null, geometry: null, origin: null, authoredAt: new Date().toISOString(),
    structureProposal: { kind: 'park', blockName: null },
  });
  const cid = fileAgreement(index, {
    schema: 'agreement/v1', title: 'Shared read-only agreement', author: 'fixture', sponsor: null, city,
    createdAt: new Date().toISOString(), designs: [{ cid: designCid, goal: 'park', title: 'Shared read-only agreement park' }],
    inputs: { parcels: [{ parcelId: 'HR-335614-2311', areaM2: 120, holders: [] }], openGroundM2: 0 },
    outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
    rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, deadline: null,
  });
  const secondary = await primary.context().newPage();
  await mockAllApiRoutes(secondary);
  await attachSharedIndex(secondary, index);
  await stubBasemapTiles(secondary);
  await secondary.goto(`/agreements/${cid}?city=${encodeURIComponent(city)}&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => secondary.evaluate(() => (window as any).__cbSecondaryTab)).toBe(true);

  const panel = agreementPanel(secondary);
  await expect(panel).toBeVisible({ timeout: 90_000 });
  await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
  await expect(panel.locator('.agreement-panel-designs')).toContainText('Shared read-only agreement park');
  await expect(panel.locator('[data-agreement-read-only-status]')).toContainText('Local map status is not evaluated');
  await expect(panel.locator('[data-agreement-status], [data-agreement-action="edit"], [data-agreement-action="delete"], [data-agreement-action="propose"]')).toHaveCount(0);
  await expect(panel.locator('[data-agreement-design]')).toBeDisabled();
  expect(await secondary.evaluate(() => (window as any).AgreementStore.list())).toEqual([]);

  const requests = index.requests;
  expect(requests.some(request => request.method === 'GET' && request.path === `/agreements/${cid}`)).toBe(true);
  expect(requests.some(request => request.method === 'POST' && request.path === '/designs/batch'
    && request.body.cids.includes(designCid))).toBe(true);
  expect(requests.filter(request => request.method === 'POST' && request.path !== '/designs/batch')).toEqual([]);
});
