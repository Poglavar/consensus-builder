// Source fixtures exercise the shared planning controls and read-only evidence inspector.
import { test, expect } from '../helpers/fixtures';
import { createBuilding, openCity, openParcel, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import { openLayerSection, openPlanningSection } from '../helpers/layers';
import { mockBuildingScene, mockFootprintCells } from '../helpers/mocks/building-data';

const sources = ['a', 'b'].map((suffix, index) => ({
  id: suffix === 'a' ? 'zagreb-gup-2025' : 'zagreb-gup-2016', city: 'zagreb', label: `Planning edition ${suffix.toUpperCase()}`,
  edition: 'test', recordId: 'record-1', version: 'revision-1', url: `https://example.test/planning-${suffix}`,
  scenario: 'family1', scenarios: ['family1', 'family2'], default: index === 0,
  capabilities: { areas: true, volumes: true },
}));
const reference = {
  proposalId: 'source:zagreb-gup-2025:record-1', providerId: sources[0].id, recordId: 'record-1',
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

test('layer shortcuts keep display settings, map location and keyboard focus across views on a phone', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBuildingScene(page);
  await mockFootprintCells(page, () => [{ id: 'nearby', geometry: PARCEL_GEOMETRY, height_m: 12 }]);
  const source = { ...sources[0], parcelStudy: 'direct-dimensions.v1' };
  const building = massing(source);
  const zone = { ...building, id: 'zoning-area', title: 'Land use', areas: [{ geometry: PARCEL_GEOMETRY }], volumes: [],
    assessment: { meaning: 'zoning-area', status: 'unresolved' } };
  await page.route('**/planning/**', route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/sources') ? { city: 'zagreb', sources: [source] }
      : payload(path.endsWith('/envelopes') ? [building] : [zone], [source]);
    return route.fulfill({ json });
  });
  await openCity(page);
  const center = await page.evaluate(() => (window as any).map.getCenter());
  const planningButton = page.locator('#planning-views-button');
  const layersButton = page.locator('#layers-button');
  const bounds = await Promise.all([planningButton, layersButton].map(button => button.boundingBox()));
  expect(bounds[1]!.y).toEqual(bounds[0]!.y);
  expect(bounds[1]!.x - bounds[0]!.x - bounds[0]!.width).toBeGreaterThanOrEqual(0);
  expect(bounds[1]!.x - bounds[0]!.x - bounds[0]!.width).toBeLessThan(16);
  const profile = await page.locator('#username-display').boundingBox();
  expect(bounds[1]!.x + bounds[1]!.width).toBeLessThanOrEqual(profile!.x);
  await planningButton.press('Enter');
  await page.locator('#planning-tab-compare').press('Enter');
  await layersButton.press('Enter');
  await page.locator('#layers-open-buildings').press('Enter');
  await expect(page.locator('#planning-existing-scope')).toBeFocused();
  await expect(page.locator('#building-source-settings-button')).toBeVisible();
  const built = page.locator('#planning-existing-appearance');
  const visibleFootprints = () => page.evaluate(() => {
    const w = window as any;
    return !!w.buildingLayer && w.map.hasLayer(w.buildingLayer) && w.buildingLayer.getLayers().length > 0;
  });
  await built.selectOption('solid');
  await expect.poll(visibleFootprints).toBe(true);
  await built.selectOption('off');
  await expect.poll(visibleFootprints).toBe(false);
  await built.selectOption('ghost');
  await expect.poll(visibleFootprints).toBe(true);

  await openLayerSection(page, 'zoning-land-use');
  const zoning = page.locator('#planning-zoning-areas');
  await zoning.selectOption('ghost');
  await layersButton.press('Enter');
  const shape = page.getByRole('button', { name: 'Inspect permitted massing on Planning edition A massing', exact: true });
  await shape.press('Enter');
  const selected = () => page.evaluate(() => (window as any).PlanningViews.getState().selectedId);
  await expect.poll(selected).toBe(building.id);
  await openPlanningSection(page, 'use-highlight');
  const shops = page.getByRole('checkbox', { name: 'Shops', exact: true });
  await shops.check();
  await openPlanningSection(page, 'floor-plans');
  await page.getByRole('button', { name: 'Explore floors in 3D' }).press('Enter');
  await expect(page.locator('#three-mode-xray')).toBeFocused({ timeout: 15_000 });
  await expect(page.locator('#three-container canvas')).toBeVisible();
  await expect.poll(selected).toBe(building.id);
  await openPlanningSection(page, 'use-highlight');
  await expect(shops).toBeChecked();
  await openLayerSection(page, 'zoning-land-use');
  await expect(zoning).toHaveValue('ghost');
  const zoneVisible = () => page.evaluate(id => {
    const group = (window as any).getThreeModeInternals().scene.getObjectByName('PermittedMassing');
    return group.visible && group.children.some((mesh: any) => mesh.visible && mesh.userData.planningRepresentationId === id);
  }, zone.id);
  await expect.poll(zoneVisible).toBe(true);
  await zoning.selectOption('off');
  await expect.poll(zoneVisible).toBe(false);
  await expect.poll(selected).toBe(building.id);
  await openLayerSection(page, 'parcels');
  const parcels = page.getByRole('checkbox', { name: 'Show parcels', exact: true });
  const modelParcels = () => page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => { if (o.userData.isParcel) count++; });
    return count;
  });
  await expect.poll(modelParcels).toBeGreaterThan(0);
  await parcels.uncheck();
  await expect.poll(modelParcels).toBe(0);
  await parcels.check();
  await expect.poll(modelParcels).toBeGreaterThan(0);
  await page.locator('[data-reveal-control="parcel-ownership-title"]').press('Enter');
  await expect(page.locator('#parcel-ownership-title')).toBeFocused();
  await expect(parcels).toBeChecked();
  await expect.poll(selected).toBe(building.id);
  expect(await page.evaluate(point => (window as any).map.distance((window as any).map.getCenter(), point), center)).toBeLessThan(20);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openLayerSection(page, 'zoning-land-use');
  await expect(zoning).toHaveValue('off');
  await openLayerSection(page, 'buildings');
  await expect(built).toHaveValue('ghost');
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
  const panel = page.locator('#planning-views');
  const zoning = page.locator('#layers-zoning-controls');
  await openLayerSection(page, 'zoning-land-use');
  // Area sources load when their source-area layer is enabled.
  await selectNativeOption(zoning.locator('[data-planning-setting="zoningAreas"]'), 'ghost');
  expect(new URL(page.url()).searchParams.get('zoningAreas')).toBe('ghost');
  const retry = zoning.locator('#planning-view-retry');
  await expect(retry).toBeVisible();
  const failedRequests = requests.length;
  fail = false;
  await retry.click();
  await expect(retry).toBeHidden();
  expect(requests.length).toBeGreaterThan(failedRequests);
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getItems().length)).toBe(1);
  await page.locator('#layers-button').click();
  await page.locator('#planning-views-button').click();
  for (const summary of await panel.locator('.planning-role-disclosure > summary').all()) await summary.press('Enter');
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
  expect(new URL(page.url()).searchParams.get('planningSelection')).toBe('zagreb-gup-2016:massing');
  await page.keyboard.press('Escape');
  await expect(clickStack).toBeHidden();
  // Its keyboard action opens the same stack (34fd7113f), on this shape.
  await shape.focus();
  await shape.press('Enter');
  await expect(clickStack.locator('.click-stack__section[data-kind="permitted"]')).toBeVisible();
  await expect(inspector.getByRole('heading', { name: 'Planning edition B massing', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('planningSelection')).toBe('zagreb-gup-2016:massing');
  await page.keyboard.press('Escape');
  await expect(clickStack).toBeHidden();
  await expect(inspector).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Inspect permitted massing on Planning edition B massing');
});

test('Buildings and massing shares its button and section loading states when opened during a request', async ({ mockApi: page }) => {
  const releases: Array<() => void> = [];
  let hold = false;
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: sources[0].city, sources } });
    if (hold) await new Promise<void>(resolve => { releases.push(resolve); });
    return route.fulfill({ json: payload([massing()]) });
  });
  await openCity(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const button = page.locator('#planning-views-button');
  const arcs = button.locator('.planning-loading-arc[data-slot]');
  const permittedBar = page.locator('[data-planning-loading="permitted"]');
  await expect(button).toHaveAttribute('aria-busy', 'false');
  await expect(permittedBar).toBeHidden();
  // These fixture sources answer with zoning areas, which load once that layer is shown.
  hold = true;
  await page.evaluate(() => (window as any).PlanningViews.configure('zoningAreas', 'ghost'));
  await expect(arcs).toHaveCount(1);
  await button.press('Enter');
  const sheet = page.locator('#planning-views');
  await expect(sheet).toBeVisible();
  await expect(permittedBar).toBeVisible();
  await expect(sheet.getByRole('progressbar', { name: 'Permitted', exact: true })).toBeVisible();
  await expect(sheet.locator('[data-role="permitted"] details')).not.toHaveAttribute('open');
  expect(await permittedBar.evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('planning-loading-slide');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await permittedBar.evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('none');
  await expect(arcs).toHaveAttribute('data-role', 'permitted');
  await expect(arcs).toHaveAttribute('data-slot', '0');
  await expect(button).toHaveAttribute('aria-busy', 'true');
  expect(await arcs.evaluate(arc => getComputedStyle(arc).stroke)).toBe(await page.evaluate(() => {
    const probe = document.createElement('i'); probe.style.color = 'var(--cb-planning-permitted)'; document.body.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); return color;
  }));
  // A second role loading packs into the next third; the answer arriving clears Permitted's.
  await page.evaluate(() => (window as any).PlanningViews.configure('existing', 'solid'));
  await page.evaluate(() => {
    const w = window as any;
    w.PlanningLoading.set('existing', 'test', true);
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(' '.repeat(2500)));
      w.finishTestBuildingBody = () => { controller.enqueue(new TextEncoder().encode('[]')); controller.close(); };
    } }));
    w.testBuildingRead = w.PlanningLoading.readJson('existing', response);
  });
  await expect(arcs).toHaveCount(2);
  const builtBar = sheet.getByRole('progressbar', { name: 'Built', exact: true });
  await expect(builtBar).toBeVisible();
  await expect(builtBar).toHaveAttribute('aria-valuetext', '2.5 kB received');
  await expect(sheet.locator('[data-role="existing"] .planning-loading-count')).toHaveText('2.5 kB');
  await sheet.locator('[data-role="existing"] summary').press('Enter');
  await expect(builtBar).toBeVisible();
  const proposedBar = sheet.locator('[data-planning-loading="proposed"]');
  await page.evaluate(() => (window as any).PlanningLoading.set('proposed', 'test', true));
  await expect(proposedBar).toBeVisible();
  await page.evaluate(() => (window as any).PlanningViews.configure('proposed', 'off'));
  await expect(proposedBar).toBeHidden();
  await page.evaluate(() => (window as any).PlanningLoading.set('proposed', 'test', false));
  expect(await arcs.evaluateAll(list => list.map(arc => `${(arc as HTMLElement).dataset.role}:${(arc as HTMLElement).dataset.slot}`))).toEqual(['existing:0', 'permitted:1']);
  hold = false;
  releases.splice(0).forEach(release => release());
  await expect(arcs).toHaveCount(1);
  await expect(arcs).toHaveAttribute('data-role', 'existing');
  await expect(permittedBar).toBeHidden();
  await expect(builtBar).toBeVisible();
  await page.evaluate(async () => {
    const w = window as any;
    w.finishTestBuildingBody();
    await w.testBuildingRead;
    w.PlanningLoading.set('existing', 'test', false);
  });
  await expect(arcs).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-busy', 'false');
  await expect(sheet.getByRole('progressbar')).toHaveCount(0);
});

test('Surviving gives an applied building its full site in the map and model', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const provider = { ...sources[0], capabilities: { volumes: true, areas: false } };
  const parcel = massing(provider);
  // One permitted volume spans the design site and the land to its east.
  const geometry = { type: 'Polygon', coordinates: [[[15.9819,45.8],[15.983,45.8],[15.983,45.8005],[15.9819,45.8005],[15.9819,45.8]]] };
  parcel.site = geometry as typeof PARCEL_GEOMETRY;
  parcel.volumes[0].geometry = parcel.site;
  await page.route('**/planning/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/sources')) return route.fulfill({ json: { city: 'zagreb', sources: [provider] } });
    if (path.endsWith('/representations')) return route.fulfill({ json: payload([parcel], [provider]) });
    return route.fallback();
  });
  await openCity(page);
  await page.evaluate(() => (window as any).PlanningViews.configure('permitted', 'off'));
  const designId = await createBuilding(page);
  await page.evaluate(() => {
    const w = window as any;
    w.ClickStack.close(); w.PlanningViews.configure('permitted', 'ghost');
  });
  const points = [[15.98193, 45.80004], [15.9828, 45.80025]];
  const mapHits = () => page.evaluate(({ points, id }) => points.map(([lng, lat]) =>
    (window as any).PlanningViews.itemsAt({lng, lat}).some((item: any) => item.id === id)), {points, id: parcel.id});
  await expect.poll(mapHits).toEqual([true, true]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#planning-views-button').press('Enter');
  const sheet = page.locator('#planning-views');
  await sheet.locator('[data-role="permitted"] summary').press('Enter');
  const scope = sheet.getByRole('combobox', { name: 'Permitted massing coverage' });
  await scope.focus();
  await selectNativeOption(scope, 'surviving');
  await expect(scope).toBeFocused();
  await expect(scope).toHaveValue('surviving');
  await expect.poll(mapHits).toEqual([false, true]);
  expect(new URL(page.url()).searchParams.get('permittedScope')).toBe('surviving');
  expect(await page.evaluate(() => JSON.parse((window as any).PersistentStorage.getItem('cb_planning_display')).permittedScope)).toBe('surviving');
  await sheet.getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await page.locator('#mode-3d-toggle').click();
  const modelHits = () => page.evaluate(({points, id}) => {
    const w = window as any, model = w.getThreeModeInternals?.();
    const group = model?.scene.getObjectByName('PermittedMassing');
    if (!group) return [];
    group.updateMatrixWorld(true);
    const meshes = group.children.filter((mesh: any) => mesh.isMesh && mesh.userData.planningRepresentationId === id);
    return points.map(([lng, lat]) => {
      const [x, y] = model.latLngToXY(lat, lng);
      const ray = new w.THREE.Raycaster(new w.THREE.Vector3(x,y,10000), new w.THREE.Vector3(0,0,-1));
      return ray.intersectObjects(meshes).length > 0;
    });
  }, {points, id: parcel.id});
  await expect.poll(modelHits).toEqual([false, true]);
  await page.evaluate(() => (window as any).PlanningViews.configure('proposed', 'off'));
  await expect.poll(modelHits).toEqual([true, true]);
  await page.evaluate(() => (window as any).PlanningViews.configure('proposed', 'solid'));
  await expect.poll(modelHits).toEqual([false, true]);
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposals([id]), designId);
  await expect.poll(modelHits).toEqual([true, true]);
  await expect.poll(mapHits).toEqual([true, true]);
});

test('Permitted keeps its Illustration dropdown enabled for a single-option source', async ({ mockApi: page }) => {
  const available = [sources[0], { ...sources[1], parcelStudy: 'direct-dimensions.v1' }];
  const broadFirst = [{ ...available[0], parcelStudy: 'direct-dimensions.v1' }, available[1]];
  let sourceRequests = 0;
  let narrowCatalog = false;
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) {
      sourceRequests += 1;
      const west = Number(url.searchParams.get('bbox')?.split(',')[0]);
      return route.fulfill({ json: { city: sources[0].city, sources: narrowCatalog || west > 16 ? available : broadFirst } });
    }
    return route.fulfill({ json: payload([massing()], available) });
  });
  await openCity(page);
  await expect.poll(() => sourceRequests).toBeGreaterThan(0);
  // A viewport refresh returns the same source IDs, but A no longer has a parcel study. The
  // catalog must apply this metadata update rather than retaining the original descriptor.
  await page.evaluate(() => (window as any).map.setView([45.85, 16.05], 18, { animate: false }));
  await expect.poll(() => sourceRequests, { timeout: 10_000 }).toBeGreaterThan(1);
  narrowCatalog = true;
  await page.locator('#planning-views-button').click();
  const panel = page.locator('#planning-views');
  const permitted = panel.locator('.planning-layer-row[data-role="permitted"]');
  await permitted.locator('summary').press('Enter');
  const sourceSelect = panel.locator('.planning-source-select');
  const form = panel.locator('[data-planning-setting="permittedForm"]');
  await expect(form).toBeVisible();
  await expect(form).toBeEnabled();
  await expect(form).toHaveValue('configuration');
  expect(await form.locator('option').allTextContents()).toEqual(['Illustration']);
  expect(await panel.locator('[data-planning-setting="proposedForm"] option').allTextContents())
    .toEqual(['Max envelope', 'Illustration', 'Both']);
  await selectNativeOption(sourceSelect, available[1].id);
  await expect(form).toBeEnabled();
  expect(await form.locator('option').allTextContents()).toEqual(['Max envelope', 'Illustration', 'Both']);
  await selectNativeOption(form, 'bound');
  await selectNativeOption(sourceSelect, available[0].id);
  await expect(form).toBeEnabled();
  await expect(form).toHaveValue('configuration');
  await selectNativeOption(sourceSelect, available[1].id);
  await expect(form).toHaveValue('bound');
});

test('Permitted links to the registered source and distinguishes its published reference', async ({ mockApi: page }) => {
  const general = { ...sources[0], label: 'General planning edition', scenarios: ['general'], scenario: 'general', url: 'https://example.test/general-plan' };
  const unavailable = { ...sources[1], label: 'Non-HTTP edition', url: 'javascript:alert(1)' };
  let available = [general];
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: 'zagreb', sources: available } });
    return route.fulfill({ json: payload([massing(general)], available) });
  });
  await openCity(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#planning-views-button').click();
  const panel = page.locator('#planning-views');
  const permitted = panel.locator('.planning-layer-row[data-role="permitted"]');
  await permitted.locator('summary').press('Enter');
  const sourceSelect = permitted.getByRole('combobox', { name: 'Source / edition', exact: true });
  await expect(sourceSelect).toBeEnabled();
  await expect(sourceSelect.locator('option')).toHaveCount(1);
  await sourceSelect.focus();
  await sourceSelect.press('ArrowDown');
  await expect(sourceSelect).toHaveValue(general.id);
  await sourceSelect.press('Tab');
  const config = permitted.getByRole('link', { name: 'UGT source configuration' });
  await expect(config).toBeFocused();
  const configUrl = new URL((await config.getAttribute('href'))!);
  expect(configUrl.pathname).toBe('/sources.html');
  expect(configUrl.searchParams.get('abstraction')).toBe('planning');
  expect(configUrl.searchParams.get('source')).toBe(general.id);
  expect(configUrl.searchParams.get('backend')).toBe(await page.evaluate(() => (window as any).getBackendBase()));
  expect(configUrl.hash).toBe('#source-config-title');
  const sourceUrl = permitted.locator('.planning-source-url');
  await expect(sourceUrl).toHaveAttribute('href', general.url);
  await expect(sourceUrl).toHaveAttribute('target', '_blank');
  await expect(sourceUrl).toHaveAccessibleName(`Published reference (${general.url})`);
  await expect(panel.locator('.planning-scenario-select')).toBeHidden();
  available = [general, unavailable];
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#planning-views-button').click();
  await permitted.locator('summary').press('Enter');
  await selectNativeOption(sourceSelect, unavailable.id);
  await expect(config).toHaveAttribute('href', new RegExp(unavailable.id));
  await expect(sourceUrl).toBeHidden();
  await expect(sourceUrl).not.toHaveAttribute('href');
});

test('Permitted and Proposed keep Both and dice together on the first expanded row @features', async ({ mockApi: page }) => {
  const available = sources.map(source => ({ ...source, parcelStudy: 'direct-dimensions.v1' }));
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: 'zagreb', sources: available } });
    return route.fulfill({ json: payload([massing(available[0])], available) });
  });
  await openCity(page);
  await page.locator('#planning-views-button').click();
  const panel = page.locator('#planning-views');
  for (const role of ['permitted', 'proposed']) {
    await panel.locator(`.planning-layer-row[data-role="${role}"] summary`).press('Enter');
  }

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const role of ['permitted', 'proposed']) {
      const detail = panel.locator(`.planning-layer-row[data-role="${role}"] .planning-layer-detail`);
      const firstRow = detail.locator(':scope > :first-child');
      const form = firstRow.locator(`select[data-planning-setting="${role}Form"]`);
      const reroll = firstRow.locator(`button[data-planning-reroll="${role}"]`);
      await expect(form).toBeVisible();
      await expect(reroll).toBeVisible();
      await expect(form).toHaveValue('both');
      const [field, die] = await Promise.all([form.boundingBox(), reroll.boundingBox()]);
      if (!field || !die) throw new Error(`Missing ${role} form controls at ${width}px`);
      expect(Math.abs(field.y - die.y)).toBeLessThan(1);
      expect(field.x + field.width).toBeLessThanOrEqual(die.x);
      expect(die.x + die.width).toBeLessThanOrEqual(width);
      const below = await detail.locator(':scope > :not(:first-child):visible')
        .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
      expect(below.length).toBeGreaterThan(0);
      expect(Math.min(...below)).toBeGreaterThanOrEqual(Math.max(field.y + field.height, die.y + die.height) - 1);
      await form.focus();
      await form.press('Tab');
      await expect(reroll).toBeFocused();
    }
  }
});

test('saved parcel evidence opens its pinned source without creating a proposal @features', async ({ mockApi: page }) => {
  const result = { ...massing(), id: 'saved-result', title: 'Saved source result', volumes: [],
    sourceEvidence: { sourceReferences: [reference] }, assessment: { meaning: 'public-screen', status: 'unresolved' } };
  const sourceRecord = { ...massing(), id: 'zagreb-gup-2025:record-1', title: 'Pinned planning source',
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
  await inspector.locator('.planning-evidence summary').click();
  await inspector.getByRole('button', { name: /^Source: zagreb-gup-2025/ }).click();
  await expect(inspector.getByRole('heading', { name: 'Pinned planning source', exact: true })).toBeVisible();
  expect(requestedRecord).toBe(reference.recordId);
  expect(await page.evaluate(() => (window as any).PlanningViews.getSelected().proposalId)).toBe(reference.proposalId);
  await inspector.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(id => ({
    parcel: (window as any).LiveParcelFabric.get(id), proposals: (window as any).proposalStorage.getAllProposals(),
  }), PARCEL_ID)).toEqual(before);
});

test('Alatau zoning overview uses static data below zoom 15 and one viewport read at zoom 15 @features', async ({ mockApi: page }) => {
  const alatau = { id: 'alatau-genplan-727', city: 'alatau', label: 'Alatau genplan', coverage: 'zoning-areas',
    capabilities: { areas: true, volumes: false }, viewportZoning: true, zoningOverview: { detailZoom: 15 }, scenarios: ['general'], scenario: 'general' };
  const representations: URL[] = [];
  const staticReads: URL[] = [];
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/data/')) return route.fallback();
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: 'alatau', sources: [alatau] } });
    if (url.pathname.endsWith('/representations')) { representations.push(url); return route.fulfill({ json: {
      schemaVersion: 'planning-representations.v1', city: 'alatau', sources: [alatau], items: [], summaries: [], unavailable: [], coverage: 'source-results', nextCursor: null, omitted: 0,
    } }); }
    return route.fulfill({ json: {} });
  });
  page.on('request', request => { if (request.url().includes('/data/planning/alatau-genplan-727-overview.json')) staticReads.push(new URL(request.url())); });
  await page.goto('/?city=alatau&at=43.61,77.02,12&permitted=off&zoningAreas=ghost&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).map && !!(window as any).PlanningViews);
  await page.evaluate(() => (window as any).map.setView([43.61, 77.02], 12, { animate: false }));
  await expect.poll(() => staticReads.length).toBe(1);
  await page.waitForFunction(() => (window as any).PlanningViews.getItems().length === 6659);
  expect(representations).toHaveLength(0);
  await openLayerSection(page, 'zoning-land-use');
  const fit = page.getByRole('button', { name: 'Fit plan', exact: true });
  await expect(fit).toBeVisible();
  await fit.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeLessThanOrEqual(14);
  await page.evaluate(() => (window as any).map.setView([43.61, 77.02], 15, { animate: false }));
  await expect.poll(() => representations.length).toBe(1);
  expect(representations[0].searchParams.get('limit')).toBe('1000');
  expect(representations[0].searchParams.get('source')).toBe(alatau.id);
  expect(representations[0].searchParams.get('scenario')).toBe('general');
  expect(representations[0].searchParams.has('bbox')).toBe(true);
  expect(representations[0].searchParams.get('envelopes')).toBeNull();
});

test('Astana fits the whole plan and shows dated parcel massing on a narrow screen @features', async ({ mockApi: page }) => {
  const source = {
    id: 'astana-genplan-cadastre-2026-11-24', city: 'astana', label: 'Генплан Астаны · срез градостроительного кадастра (24.11.2026)',
    edition: '2026-11-24', kind: 'reference', coverage: 'zoning-areas', parcelStudy: 'direct-dimensions.v1',
    capabilities: { areas: true, volumes: false }, viewportZoning: true,
    zoningOverview: { detailZoom: 15 }, scenarios: ['general'], scenario: 'general',
  };
  const parcel = 'KZ-ASTANA-PKK-sample';
  const site = { type: 'Polygon', coordinates: [[[71.42536, 51.12516], [71.42545, 51.12516],
    [71.42545, 51.12525], [71.42536, 51.12525], [71.42536, 51.12516]]] };
  const envelope = {
    id: `envelope:${source.id}:${parcel}`, role: 'permitted', parcelEnvelope: true, title: '5–9 storey housing', site,
    source: { ...source, parcel }, areas: [], volumes: [{ id: 'volume', geometry: site, baseM: 0, topM: 27 }],
    spatialReference: { horizontal: 'OGC:CRS84', vertical: 'relative-ground', unit: 'm' },
    assessment: { meaning: 'outer-bound', status: 'unresolved' }, metrics: { heightM: 27 }, constraints: [],
    sourceEvidence: { zoningRecordId: '364149', rules: { snapshotDate: source.edition, storeyHeightM: 3, redLineDecree: '№ 33 от 25.01.2024' } },
  };
  const zoningRequests: URL[] = [];
  const envelopeRequests: URL[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/planning/**', async route => {
    if (!['xhr', 'fetch'].includes(route.request().resourceType())) return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/data/')) return route.fallback();
    if (url.pathname.endsWith('/sources')) return route.fulfill({ json: { city: source.city, sources: [source] } });
    if (url.pathname.endsWith('/representations')) zoningRequests.push(url);
    const isEnvelope = url.pathname.endsWith('/envelopes');
    if (isEnvelope) envelopeRequests.push(url);
    const [w, s, e, n] = (url.searchParams.get('bbox') || '').split(',').map(Number);
    const hasParcel = isEnvelope && w < 71.4254 && 71.4254 < e && s < 51.1252 && 51.1252 < n;
    return route.fulfill({ json: { schemaVersion: 'planning-representations.v1', city: source.city, sources: [source],
      items: hasParcel ? [envelope] : [], summaries: [], coverage: 'source-results', nextCursor: null, omitted: 0 } });
  });
  const overview = page.waitForResponse(response => response.url().includes(`/data/planning/${source.id}-overview.json`) && response.ok());
  await page.goto('/?city=astana&at=51.1282,71.4304,12&permitted=solid&zoningAreas=ghost&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  const { bbox } = await (await overview).json();
  await page.waitForFunction(() => (window as any).PlanningViews?.getItems().length === 12914);
  expect(zoningRequests).toHaveLength(0);
  await openLayerSection(page, 'zoning-land-use');
  const fit = page.getByRole('button', { name: 'Fit plan', exact: true });
  await expect(fit).toBeVisible();
  await fit.press('Enter');
  await expect.poll(() => page.evaluate(([w, s, e, n]) => {
    return (window as any).map.getBounds().contains([[s, w], [n, e]]);
  }, bbox)).toBe(true);
  await expect(page.getByRole('button', { name: 'Layers', exact: true })).toBeFocused();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as any).PlanningViews?.getItems().length === 12914);
  expect(new URL(page.url()).searchParams.get('zoningAreas')).toBe('ghost');
  expect(envelopeRequests).toHaveLength(0);
  await page.evaluate(() => (window as any).map.setView([51.1252, 71.4254], 17, { animate: false }));
  await expect.poll(() => zoningRequests.at(-1)?.searchParams.get('source')).toBe(source.id);
  await expect.poll(() => envelopeRequests.at(-1)?.searchParams.get('source')).toBe(source.id);
  await page.getByRole('button', { name: `Inspect permitted massing on ${parcel}`, exact: true }).press('Enter');
  const evidence = page.locator('#planning-inspector details.planning-evidence').filter({ hasText: source.label });
  await evidence.locator('summary').press('Enter');
  await expect(evidence).toContainText('№ 33 от 25.01.2024');
  await expect(evidence).toContainText(source.edition);
});
