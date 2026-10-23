// Source-linked navigation and boundary actions missed by the earlier page traversals.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test('the Designs list keeps the selected model view and has no 2D-only instruction', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await page.locator('#proposals-button').click();
  await expect(page.locator('#proposals-sheet')).toBeVisible();
  await expect(page.locator('#proposals-sheet .proposal-list-navigation-hint')).toHaveCount(0);
  await expect(page.locator('body')).toHaveClass(/three-mode-active/);
  await page.locator('#proposals-sheet [data-sheet-close]').click();
  await expect(page.locator('#mode-3d-toggle')).toHaveAttribute('aria-pressed', 'true');
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
