import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

const SITE = {
  type: 'Polygon',
  coordinates: [[
    [15.9818, 45.7999], [15.9830, 45.7999], [15.9830, 45.8007], [15.9818, 45.8007], [15.9818, 45.7999],
  ], [
    [15.98225, 45.80018], [15.98255, 45.80018], [15.98255, 45.80042], [15.98225, 45.80042], [15.98225, 45.80018],
  ]],
};
const source = {
  id: 'zagreb-gup-2025', city: 'zagreb', label: 'Test zoning source', edition: 'test',
  recordId: 'area-1', version: 'revision-1', url: 'https://example.test/planning',
  scenario: 'general', scenarios: ['general'], default: true,
  capabilities: { areas: true, volumes: false },
};
const reference = {
  proposalId: 'source:zagreb-gup-2025:area-1', providerId: source.id, recordId: source.recordId,
  edition: source.edition, revision: source.version, city: source.city, parcelId: null, scenario: source.scenario,
};
const proposal = {
  schemaVersion: 'source-proposal.v1', proposalId: reference.proposalId, proposalClass: 'obligatory-source',
  proposalType: 'Source planning rule', readOnly: true,
  source: { providerId: source.id, city: source.city, recordId: source.recordId, edition: source.edition, revision: source.version, url: source.url },
  applicability: { status: 'applicable', parcelIds: [], scenario: source.scenario, conditions: null },
  lifecycle: { availability: 'available', revisionMode: 'latest-only', supersedes: null },
};
const item = {
  id: `${source.id}:area-1`, proposalId: null, role: 'permitted', title: 'Area 1', source,
  site: { type: 'Polygon', coordinates: [SITE.coordinates[0]] }, areas: [{ id: 'area-1', geometry: { type: 'Polygon', coordinates: [SITE.coordinates[0]] } }], volumes: [],
  landBasis: 'zone', assessment: { meaning: 'zoning-area', status: 'unresolved', current: true },
  metrics: { footprintM2: 6500 }, constraints: [],
};
const payload = (items: unknown[] = [item]) => ({ schemaVersion: 'planning-representations.v1', city: 'zagreb', sources: [source], items, summaries: [], unavailable: [], coverage: 'source-results', nextCursor: null, omitted: 0 });

test('planning area opens exact site, subdivides three plots, and reopens with source references @features', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  let representations = 0, exactReads = 0;
  await page.route('**/planning/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: 'zagreb', sources: [source] } });
    if (url.pathname.endsWith('/representations')) { representations += 1; return route.fulfill({ json: payload() }); }
    if (url.pathname.endsWith('/record')) {
      exactReads++;
      if (exactReads === 1) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { recordId: source.recordId, items: [{ ...item, proposal, source, site: SITE, areas: [{ id: 'area-1', geometry: SITE }] }] } });
    }
    return route.fallback();
  });
  await openCity(page);
  await page.evaluate(() => (window as any).PlanningViews.configure('zoningAreas', 'ghost'));
  await expect.poll(() => representations).toBeGreaterThan(0);
  const shape = page.getByRole('button', { name: /Inspect .*Area 1/i }).first();
  await expect(shape).toBeAttached();
  await shape.focus();
  await shape.press('Enter');
  const inspector = page.locator('#planning-inspector');
  await expect(inspector).toBeVisible();
  const use = inspector.getByRole('button', { name: 'Use this area as a design site' });
  await use.focus();
  await use.press('Enter');
  await expect(inspector.locator('.planning-area-site [role="status"]')).toContainText('Try again');
  await expect(use).toBeFocused();
  await use.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).SiteTool.current()?.site)).toEqual({ type: 'MultiPolygon', coordinates: [SITE.coordinates] });
  const palette = page.locator('#site-info-panel');
  await expect(palette).toBeVisible();
  const direct = palette.locator('.parcel-build-btn--parcel-layout');
  await expect(direct).toBeEnabled();
  await direct.press('Enter');
  const modal = page.locator('.on-map-reparcellization');
  await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
  const count = modal.locator('[data-parcel-layout-count]');
  await count.fill('3');
  await count.press('Enter');
  await expect(page.locator('.reparcel-plot-number')).toHaveCount(3);
  await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled();
  await modal.locator('[data-reparcel-commit]').press('Enter');
  await expect(modal).toHaveCount(0);
  await page.waitForFunction(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.goal === 'parcel-layout'));
  const saved = await page.evaluate(() => {
    const proposals = (window as any).proposalStorage.getAllProposals();
    return proposals.find((p: any) => p.goal === 'parcel-layout' && p.parcelLayout?.poolSource === 'site');
  });
  expect(saved).toBeTruthy();
  expect(saved.sourceReferences).toEqual([reference]);
  expect(saved.parcelLayout.plots).toHaveLength(3);
  expect(saved.site).toEqual({ type: 'MultiPolygon', coordinates: [SITE.coordinates] });
  expect(saved.parcelLayout).not.toHaveProperty('openGroundM2');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(id => !!(window as any).proposalStorage?.getProposal(id), saved.proposalId);
  const reopened = await page.evaluate(id => {
    const p = (window as any).proposalStorage.getProposal(id);
    return { refs: p.sourceReferences, plots: p.parcelLayout.plots.length, site: p.site };
  }, saved.proposalId);
  expect(reopened.refs).toEqual([reference]);
  expect(reopened.plots).toBe(3);
  expect(reopened.site).toEqual(saved.site);
});
