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

test('deleting a lake boundary point persists a closed triangular replacement', async ({ mockApi: page }) => {
  await openCity(page);
  const sourceId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
    proposalId: 'lake-boundary-delete', title: 'Lake boundary delete', goal: 'lake', city: 'zagreb',
    lifecycleStatus: 'Active', applied: true, cadastreParcelIds: [parcelId],
    structureProposal: { kind: 'lake', geometry },
  }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
  await showProposal(page, sourceId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  const editor = page.locator('#structure-geometry-editor');
  await expect(editor).toBeVisible();
  const vertices = page.locator('.polygon-geometry-editor__vertex');
  await expect(vertices).toHaveCount(4);
  await vertices.first().click();
  await page.getByRole('button', { name: 'Delete this boundary point', exact: true }).click();
  await expect(vertices).toHaveCount(3);
  await editor.locator('[data-action="save"]').click();
  await expect(editor).toBeHidden();
  await expect.poll(() => page.evaluate(id => {
    const replacement = (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.sourceProposalId === id && proposal.structureProposal?.kind === 'lake');
    return replacement?.structureProposal.geometry.coordinates[0].length || 0;
  }, sourceId)).toBe(4);
  const geometry = await page.evaluate(id => (window as any).proposalStorage.getAllProposals()
    .find((proposal: any) => proposal.sourceProposalId === id).structureProposal.geometry, sourceId);
  expect(geometry.coordinates[0][0]).toEqual(geometry.coordinates[0].at(-1));
  expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).structureProposal.geometry, sourceId))
    .toEqual(PARCEL_GEOMETRY);
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
  await page.goto('/floor-plan-archive.html?lang=en');
  await expect(page.locator('#building option')).toHaveCount(1);
  await page.locator('#tab-sites').click();
  await expect(page.locator('#tab-sites')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-sites')).toBeVisible();
  await expect(page.locator('#panel-buildings')).toBeHidden();
  await expect(page.locator('#site-name')).toHaveText('No site models yet.');
  expect(reads).toBe(1);
  await expect(page).toHaveURL(/[?&]tab=sites(?:&|$)/);
});
