// Source-linked navigation and boundary actions missed by the earlier page traversals.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test('the proposal list returns from model 3D through its Open 2D map action', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await page.locator('#proposals-button').click();
  const sheet = page.locator('#proposals-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Open 2D map', exact: true }).click();
  await expect(page.locator('body')).not.toHaveClass(/three-mode-active/);
  await expect(page.locator('#mode-2d-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#map')).toBeVisible();
});

test('deleting a lake boundary point saves a closed triangle onto the same lake', async ({ mockApi: page }) => {
  await openCity(page);
  const sourceId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
    proposalId: 'lake-boundary-delete', title: 'Lake boundary delete', goal: 'lake', city: 'zagreb',
    lifecycleStatus: 'Active', applied: true, cadastreParcelIds: [parcelId],
    structureProposal: { kind: 'lake', geometry },
  }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  await showProposal(page, sourceId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  const editor = page.locator('#structure-geometry-editor');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  const vertices = page.locator('.polygon-geometry-editor__vertex');
  await expect(vertices).toHaveCount(4);
  await vertices.first().click();
  await page.getByRole('button', { name: 'Delete this boundary point', exact: true }).click();
  await expect(vertices).toHaveCount(3);
  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);
  // A local lake is edited in place: the same record takes the triangle, and no copy appears.
  await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)
    ?.structureProposal?.geometry?.coordinates?.[0]?.length || 0, sourceId)).toBe(4);
  const geometry = await page.evaluate(id => (window as any).proposalStorage.getProposal(id).structureProposal.geometry, sourceId);
  expect(geometry.coordinates[0][0]).toEqual(geometry.coordinates[0].at(-1));
  expect(await page.evaluate(id => (window as any).proposalStorage.getAllProposals()
    .some((proposal: any) => proposal.sourceProposalId === id), sourceId)).toBe(false);
});

test('floor plan archive Sites tab loads and exposes its empty result', async ({ mockApi: page }) => {
  let reads = 0;
  await page.route('**/floor-plan-archive/catalogue', route => route.fulfill({ json: { buildings: [], sources: [] } }));
  await page.route('**/floor-plan-archive/status', route => route.fulfill({ json: { coverage: { agencies: { total: 0, websites: 0 } } } }));
  await page.route('**/floor-plan-archive/agencies?*', route => route.fulfill({ json: { agencies: [] } }));
  await page.route('**/floor-plan-archive/sites', route => {
    reads += 1;
    return route.fulfill({ json: { sites: [] } });
  });
  await page.route('**/api/floor-plans?*', route => route.fulfill({ json: { plans: [], limit: 100, offset: 0, hasMore: false } }));
  await page.goto('/floor-plans.html?lang=en');
  await expect(page.locator('#building option')).toHaveCount(1);
  await page.locator('#tab-sites').click();
  await expect(page.locator('#tab-sites')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-sites')).toBeVisible();
  await expect(page.locator('#panel-buildings')).toBeHidden();
  await expect(page.locator('#site-name')).toHaveText('No project site models yet.');
  expect(reads).toBe(1);
  await expect(page).toHaveURL(/[?&]tab=sites(?:&|$)/);
});

test('project site parcel context stays on the map without becoming a building volume', async ({ mockApi: page }) => {
  const geometry = { type: 'MultiPolygon', coordinates: [
    [[[-.12, 51.5], [-.119, 51.5], [-.119, 51.501], [-.12, 51.501], [-.12, 51.5]]],
    [[[-.118, 51.5], [-.1175, 51.5], [-.1175, 51.5005], [-.118, 51.5005], [-.118, 51.5]]],
  ] };
  const models = {
    'parcels:example': { siteKey: 'parcels:example', label: 'Parcel context example', location: { status: 'probable' },
      parcelContext: { geometry, areaM2: 1000, source: 'cadastre-parcels' }, footprint: null,
      envelope: { footprint: null, storeys: [{ level: 0, elevationM: 0, heightM: 3 }], heightM: 3 }, placements: [] },
    'listing:example': { siteKey: 'listing:example', label: 'Location unknown', location: { status: 'unknown' },
      parcelContext: null, footprint: null, envelope: null, placements: [] },
  };
  await page.route('**/api/floor-plans?*', route => route.fulfill({ json: { plans: [], limit: 100, offset: 0, hasMore: false } }));
  await page.route('**/floor-plan-archive/catalogue', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/floor-plan-archive/status', route => route.fulfill({ json: { coverage: { agencies: { total: 0, websites: 0 } } } }));
  await page.route('**/floor-plan-archive/agencies?*', route => route.fulfill({ json: { agencies: [] } }));
  await page.route('**/floor-plan-archive/sites', route => route.fulfill({ json: { sites: Object.values(models).map(model => ({
    siteKey: model.siteKey, label: model.label, postings: 1, placed: 0, plans: 1,
  })) } }));
  await page.route('**/floor-plan-archive/site?*', route => {
    const key = new URL(route.request().url()).searchParams.get('key') as keyof typeof models;
    return route.fulfill({ json: models[key] });
  });
  await page.goto('/floor-plans.html?lang=en&tab=sites');
  await expect(page.getByRole('tab', { name: 'Project sites' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#site-3d')).toContainText('Parcel boundaries alone do not define a building footprint.');
  await expect(page.locator('#site-3d canvas')).toHaveCount(0);
  const parcelPath = page.locator('#site-map path[stroke-dasharray="6 4"]');
  await expect(parcelPath).toHaveCount(1);
  await expect.poll(async () => (await parcelPath.getAttribute('d'))?.match(/M/g)?.length).toBe(2);
  await expect(page.locator('#site-summary')).toContainText('Parcel context area');
  await expect(page.locator('#site-summary')).toContainText('1000 m²');
  await page.locator('#site').selectOption('listing:example');
  await expect(page.locator('#site-name')).toHaveText('Location unknown');
  await expect(page.locator('#site-map path')).toHaveCount(0);
  await page.locator('#site').selectOption('parcels:example');
  await expect.poll(async () => (await parcelPath.getAttribute('d'))?.match(/M/g)?.length).toBe(2);
  await expect(page.locator('#site-3d canvas')).toHaveCount(0);
});
