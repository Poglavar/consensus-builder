// Source fixtures exercise the shared planning controls and read-only evidence inspector.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import { openLayerSection } from '../helpers/layers';

const sources = ['a', 'b'].map((suffix, index) => ({
  id: `planning-controls-${suffix}`, city: 'zagreb', label: `Planning edition ${suffix.toUpperCase()}`,
  edition: 'test', recordId: 'record-1', version: 'revision-1', url: 'https://example.test/planning',
  scenario: 'family1', scenarios: ['family1', 'family2'], default: index === 0,
  capabilities: { areas: true, volumes: true },
}));
const reference = {
  proposalId: 'source:planning-controls-a:record-1', providerId: sources[0].id, recordId: 'record-1',
  edition: 'test', revision: 'revision-1', city: 'zagreb', parcelId: null, scenario: 'family1',
};
function massing(source = sources[0]) {
  return {
    id: `${source.id}:massing`, proposalId: null, role: 'permitted', title: `${source.label} massing`,
    source, site: PARCEL_GEOMETRY, areas: [], volumes: [{ id: 'volume', geometry: PARCEL_GEOMETRY, baseM: 0, topM: 12 }],
    spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
    assessment: { meaning: 'partial-envelope', status: 'unresolved' }, metrics: { heightM: 12, footprintM2: 600 }, constraints: [],
  };
}
const payload = (items: unknown[] = [], available = sources) => ({
  schemaVersion: 'planning-representations.v1', city: 'zagreb', sources: available, items,
  summaries: [], unavailable: [], coverage: 'source-results', nextCursor: null, omitted: 0,
});

for (const blocksEnabled of [false, true]) test(`planning source, scenario, display and retry controls update the actual view (OSM blocks ${blocksEnabled ? 'on' : 'off'}) @features`, async ({ mockApi: page }) => {
  let fail = true;
  const requests: URL[] = [];
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: 'zagreb', sources } });
    if (url.pathname.endsWith('/representations')) {
      requests.push(url);
      if (fail) return route.fulfill({ status: 503, json: { error: 'Fixture source unavailable' } });
      const source = sources.find(item => item.id === url.searchParams.get('source')) || sources[0];
      return route.fulfill({ json: payload([massing(source)]) });
    }
    return route.fulfill({ json: { parcel: url.searchParams.get('parcel'), items: [] } });
  });
  await openCity(page);
  await page.locator('#planning-views-button').click();
  const panel = page.locator('#planning-views');
  // Area sources load when their source-area layer is enabled.
  await selectNativeOption(panel.locator('[data-planning-setting="zoningAreas"]'), 'ghost');
  expect(new URL(page.url()).searchParams.get('zoningAreas')).toBe('ghost');
  const retry = panel.locator('#planning-view-retry');
  await expect(retry).toBeVisible();
  const failedRequests = requests.length;
  fail = false;
  await retry.click();
  await expect(retry).toBeHidden();
  expect(requests.length).toBeGreaterThan(failedRequests);
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getItems().length)).toBe(1);

  for (const [key, value] of Object.entries({
    existing: 'off', existingScope: 'removed', permitted: 'solid', permittedMap: 'steps',
    proposed: 'ghost', proposedForm: 'massing',
  })) {
    await selectNativeOption(panel.locator(`[data-planning-setting="${key}"]`), value);
    expect(await page.evaluate(key => (window as any).PlanningViews.getState()[key], key)).toBe(value);
    expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  }
  await selectNativeOption(panel.locator('.planning-source-select'), sources[1].id);
  await expect.poll(() => requests.at(-1)?.searchParams.get('source')).toBe(sources[1].id);
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getItems()[0]?.title)).toBe('Planning edition B massing');
  await selectNativeOption(panel.locator('.planning-scenario-select'), 'family2');
  await expect.poll(() => requests.at(-1)?.searchParams.get('scenario')).toBe('family2');
  expect(new URL(page.url()).searchParams.get('planningScenario')).toBe('family2');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toBeHidden();
  if (blocksEnabled) {
    await page.route('**/blocks/roads**', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
    await openLayerSection(page, 'blocks');
    await page.locator('#showUrbanBlocks').check();
    await expect(page.locator('#urban-blocks-status')).toContainText('No fully enclosed blocks');
    await page.locator('#layers-button').click();
  }
  // A physical click must resolve the same permitted shape as its keyboard action.
  const shape = page.getByRole('button', { name: 'Inspect permitted massing on Planning edition B massing', exact: true });
  await expect(shape).toBeAttached();
  await shape.click();
  const clickStack = page.locator('#click-stack');
  await expect(clickStack.locator('.click-stack__section[data-kind="permitted"]')).toBeVisible();
  const inspector = page.locator('#planning-inspector');
  await expect(inspector.getByRole('heading', { name: 'Planning edition B massing', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('planningSelection')).toBe('planning-controls-b:massing');
  await page.keyboard.press('Escape');
  await expect(clickStack).toBeHidden();
  await shape.focus();
  await shape.press('Enter');
  await expect(inspector.getByRole('heading', { name: 'Planning edition B massing', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(inspector).toBeHidden();
  await expect(page.locator('#planning-views-button')).toBeFocused();
});

test('saved parcel evidence opens its pinned source without creating a proposal @features', async ({ mockApi: page }) => {
  const result = { ...massing(), id: 'saved-result', title: 'Saved source result', volumes: [],
    sourceEvidence: { sourceReferences: [reference] }, assessment: { meaning: 'public-screen', status: 'unresolved' } };
  const sourceRecord = { ...massing(), id: 'planning-controls-a:record-1', title: 'Pinned planning source',
    proposalId: reference.proposalId, volumes: [], proposal: {
      schemaVersion: 'source-proposal.v1', proposalId: reference.proposalId,
      source: { providerId: reference.providerId, recordId: reference.recordId, edition: reference.edition,
        revision: reference.revision, city: reference.city },
      applicability: { parcelIds: [], scenario: reference.scenario }, lifecycle: { availability: 'available' },
    } };
  let requestedRecord: string | null = null;
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: 'zagreb', sources } });
    if (url.pathname.endsWith('/parcel')) return route.fulfill({ json: { parcel: url.searchParams.get('parcel'), items: [result] } });
    if (url.pathname.endsWith('/record')) {
      requestedRecord = url.searchParams.get('recordId');
      return route.fulfill({ json: { recordId: reference.recordId, items: [sourceRecord] } });
    }
    return route.fulfill({ json: payload() });
  });
  await openCity(page);
  const before = await page.evaluate(id => ({
    parcel: (window as any).LiveParcelFabric.get(id), proposals: (window as any).proposalStorage.getAllProposals(),
  }), PARCEL_ID);
  await openParcel(page);
  await page.locator('#parcel-info-panel').getByRole('button', { name: 'Inspect result', exact: true }).click();
  const inspector = page.locator('#planning-inspector');
  await expect(inspector.getByRole('heading', { name: 'Saved source result', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: /^Source: planning-controls-a/ }).click();
  await expect(inspector.getByRole('heading', { name: 'Pinned planning source', exact: true })).toBeVisible();
  expect(requestedRecord).toBe(reference.recordId);
  expect(await page.evaluate(() => (window as any).PlanningViews.getSelected().proposalId)).toBe(reference.proposalId);
  await inspector.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(id => ({
    parcel: (window as any).LiveParcelFabric.get(id), proposals: (window as any).proposalStorage.getAllProposals(),
  }), PARCEL_ID)).toEqual(before);
});
