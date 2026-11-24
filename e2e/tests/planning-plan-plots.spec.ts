import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity } from '../helpers/runtime';

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
  parcelStudy: 'direct-dimensions.v1', capabilities: { areas: true, volumes: false },
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

test('planning plan plots apply flow and source references @features', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  let exactReads = 0, envelopeGets = 0;
  const posts: any[][] = [];
  const originalId = 'envelope:zagreb-gup-2025:zone:area-1';
  function envelope(id: string, shape: any, parcel?: string) {
    const volumes = [{ id: id + ':v', baseM: 0, topM: 12, geometry: shape }];
    const metrics = { heightM: 12, footprintM2: 6500 };
    return { ...item, id, areas: [], site: shape, parcelEnvelope: true, landBasis: parcel ? 'parcel' : 'zone', source: { ...source, parcel },
      spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
      assessment: { meaning: 'outer-bound', status: 'unresolved', current: true }, metrics, volumes,
      configurations: [{ id: 'general', treatment: 'allowed', metrics, volumes,
        constraints: [{ quantity: 'height', unit: 'm', value: 12, evidence: 'direct' }] }],
      derivation: { parcel: shape }, sourceEvidence: { zoningRecordId: source.recordId, parts: 1,
        ...(!parcel ? { planningArea: { source: source.id, recordId: source.recordId } } : {}) } };
  }
  await page.route('**/planning/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: 'zagreb', sources: [source] } });
    if (url.pathname.endsWith('/representations')) return route.fulfill({ json: payload() });
    if (url.pathname.endsWith('/envelopes')) {
      if (route.request().method() === 'POST') {
        const { plots } = route.request().postDataJSON();
        posts.push(plots);
        return route.fulfill({ json: payload(plots.map((plot: any) => envelope('envelope:zagreb-gup-2025:' + plot.id, plot.geometry, plot.id))) });
      }
      envelopeGets++;
      const bounds = (url.searchParams.get('bbox') || '').split(',').map(Number);
      const overlaps = bounds[2] > 15.9818 && bounds[0] < 15.983 && bounds[3] > 45.7999 && bounds[1] < 45.8007;
      return route.fulfill({ json: payload(overlaps ? [envelope(originalId, SITE)] : []) });
    }
    if (url.pathname.endsWith('/record')) {
      exactReads++;
      expect(url.searchParams.get('recordId')).toBe(source.recordId);
      if (exactReads === 1) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { recordId: source.recordId, items: [{ ...item, proposal, source, site: SITE, areas: [{ id: 'area-1', geometry: SITE }] }] } });
    }
    return route.fallback();
  });
  await openCity(page);
  const visibleEnvelopes = () => page.evaluate(() => (window as any).PlanningViews.getItems().filter((r: any) => r.parcelEnvelope).map((r: any) => r.id));
  await expect.poll(visibleEnvelopes).toContain(originalId);
  await page.evaluate(() => {
    (window as any).PlanningViews.configure('permittedForm', 'bound');
    (window as any).PlanningViews.configure('zoningAreas', 'ghost');
  });
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.itemsAt({lng: 15.98205, lat: 45.80012}).length)).toBe(2);
  await clickMapPoint(page, 15.98205, 45.80012);
  const stack = page.locator('#click-stack');
  const inspector = page.locator('#planning-inspector');
  await expect(stack.getByRole('tab', { name: 'Permitted massing', exact: true })).toHaveAttribute('aria-selected', 'true');
  await stack.getByRole('tab', { name: 'Government-plan plot', exact: true }).press('Enter');
  await expect(inspector.getByRole('button', {name: 'Use this area as a design site'})).toBeVisible();
  await stack.getByRole('tab', { name: 'Permitted massing', exact: true }).press('Enter');
  await expect(inspector.getByText(/The recorded rules set only the height/)).toBeVisible();
  await inspector.getByRole('button', { name: 'Change massing view' }).press('Enter');
  const sheet = page.locator('#planning-views');
  const form = sheet.getByRole('combobox', { name: 'Permitted representation' });
  await expect(form).toBeFocused();
  await form.selectOption('configuration');
  await expect.poll(() => page.evaluate(id => {
    const w = window as any, item = w.PlanningViews.getItems().find((entry: any) => entry.id === id);
    const {bound, body} = w.PlanningViews.permittedFeatures(item);
    return !bound.length && body.length === 1 && w.turf.area(body[0]) < w.turf.area(item.site);
  }, originalId)).toBe(true);
  await sheet.getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await page.evaluate(() => { (window as any).ClickStack.close(); (window as any).PlanningViews.configure('zoningAreas', 'off'); });
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getState().zoningAreas)).toBe('off');
  const shape = page.getByRole('button', { name: 'Inspect permitted massing on Area 1', exact: true }).first();
  await expect(shape).toBeAttached();
  await shape.focus();
  await shape.press('Enter');
  await expect(inspector).toBeVisible();
  const use = inspector.getByRole('button', { name: 'Use the government-plan area as a design site' });
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
  const before = envelopeGets;
  const applied = await page.evaluate(id => (window as any).ProposalManager.applyProposalPlan([id]), saved.proposalId);
  expect(applied.ok, JSON.stringify(applied)).toBe(true);
  await expect.poll(() => posts.length).toBeGreaterThan(0);
  const layoutIds = () => [...new Set(posts.flat().filter(plot => plot.kind === 'plot').map(plot => plot.id))];
  await expect.poll(() => layoutIds().length).toBe(3);
  expect(posts.flat().filter(plot => plot.kind === 'plot').every(plot => plot.planningArea?.source === source.id && plot.planningArea?.recordId === source.recordId)).toBe(true);
  await expect.poll(visibleEnvelopes).not.toContain(originalId);
  for (const id of layoutIds()) await expect.poll(visibleEnvelopes).toContain('envelope:zagreb-gup-2025:' + id);
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposals([id]), saved.proposalId);
  await expect.poll(() => envelopeGets).toBeGreaterThan(before);
  await expect.poll(visibleEnvelopes).toContain(originalId);
  for (const id of layoutIds()) await expect.poll(visibleEnvelopes).not.toContain('envelope:zagreb-gup-2025:' + id);
});
