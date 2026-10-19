// Purpose: verify runtime Leaflet controls by their user-visible map effect, including controls whose DOM is created by Leaflet rather than authored with source IDs.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, createSpace, showProposal, drawCorridor } from '../helpers/runtime';
import type { Page } from '@playwright/test';

async function clickEditorMapPoint(page: Page, xRatio: number, yRatio: number) {
  const box = await page.locator('#map-container').boundingBox();
  if (!box) throw new Error('The reparcellization map has no visible bounds');
  await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

test.describe('Leaflet runtime control effects @features', () => {
  test('manual building polygon vertex selection and Delete selected vertex change the live outline', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    if (!(await page.locator('#blockify-manual-toggle').isVisible())) await page.locator('#blockify-modal .on-map-editor__more-options > summary').click();
    await page.locator('#blockify-manual-toggle').click();
    const vertices = page.locator('#map-container .polygon-geometry-editor__vertex');
    await expect.poll(() => vertices.count()).toBeGreaterThan(2);
    const countBefore = await vertices.count();
    await vertices.first().click();
    const remove = page.getByRole('button', { name: 'Delete selected vertex', exact: true });
    await expect(remove).toBeVisible();
    await remove.click();
    await expect(vertices).toHaveCount(countBefore - 1);
  });

  test('square geometry markers for tree, fountain, bench, stall, and statue erase through their visible map icons', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await createSpace(page, 'square');
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    const editor = page.locator('#structure-geometry-editor');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

    const decorations = [
      { tool: 'tree', kind: 'tree', lng: 15.98208, lat: 45.80018 },
      { tool: 'fountain', kind: 'fountain', lng: 15.98213, lat: 45.80018 },
      { tool: 'bench', kind: 'bench', lng: 15.98218, lat: 45.80018 },
      { tool: 'stall', kind: 'stall', lng: 15.98223, lat: 45.80018 },
      { tool: 'statue', kind: 'statue', lng: 15.98228, lat: 45.80018 },
    ];
    for (const decoration of decorations) {
      await editor.locator(`[data-tool="${decoration.tool}"]`).click();
      await clickMapPoint(page, decoration.lng, decoration.lat);
      const markers = page.locator(`.structure-geometry-icon.is-${decoration.kind}`);
      await expect.poll(() => markers.count()).toBeGreaterThan(0);
      const countBeforeErase = await markers.count();
      await editor.locator('[data-tool="erase"]').click();
      await markers.last().click();
      await expect(markers).toHaveCount(countBeforeErase - 1);
    }
    await editor.locator('[data-action="save"]').click();
    await expect(editor).toHaveCount(0);
  });

  test('clicking an applied transit station marker selects and opens its proposal', async ({ mockApi: page }) => {
    await openCity(page);
    await drawCorridor(page, 'road');
    await clickMapPoint(page, 15.9822, 45.80045);
    await expect(page.locator('#parcel-menu')).toBeVisible();
    await page.locator('#parcel-menu').getByRole('menuitem', { name: 'Propose here', exact: true }).click();
    await page.locator('#parcel-info-panel .parcel-transport-btn--bus').click();
    await clickMapPoint(page, 15.9822, 45.80025);
    const stationId = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.structureProposal?.stationType === 'bus')?.proposalId);
    expect(stationId).toBeTruthy();
    await expect.poll(() => page.evaluate(id => (window as any).transitStations?.some((station: any) =>
      String(station?.properties?.proposalId) === String(id)), stationId)).toBe(true);
    const marker = page.locator('.transit-station-marker:not(.transit-station-marker--preview)').first();
    await expect(marker).toBeVisible();
    await marker.click();
    await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.())).toBe(stationId);
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
  });

  test('Leaflet Close popup dismisses the node detail popup in the editable real plan', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--reparcellization').click();
    const modal = page.locator('.on-map-reparcellization');
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    await modal.locator('label.reparcel-alg-option:has(input[value="manual"])').click();
    const nodes = modal.locator('[data-reparcel-nodes]');
    if (await nodes.getAttribute('aria-pressed') !== 'true') await nodes.click();
    const rows = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row');
    const beforeSplit = await rows.count();
    await modal.locator('[data-reparcel-line]').click();
    await expect(modal.locator('[data-reparcel-draw-toolbar]')).toBeVisible();
    const map = page.locator('#map-container');
    const box = await map.boundingBox();
    if (!box) throw new Error('Readjustment map has no visible bounds');
    await clickMapPoint(page, 15.98185, 45.80025);
    await clickMapPoint(page, 15.98255, 45.80025);
    await expect(modal.locator('[data-reparcel-finish]')).toBeEnabled();
    await modal.locator('[data-reparcel-finish]').click();
    await expect.poll(() => rows.count()).toBeGreaterThan(beforeSplit);
    const midpoints = map.locator('.reparcel-edge-handle');
    await expect(midpoints.first()).toBeVisible();
    // The endpoint nodes are generated by the actual split and support the same detail popup
    // without relying on the midpoint insertion path, which is conditional on a shared edge.
    const handle = map.locator('.reparcel-node-handle').first();
    await expect(handle).toBeVisible();
    await handle.click();
    const popup = page.locator('.reparcel-node-popup');
    await expect(popup).toBeVisible();
    const close = page.locator('.leaflet-popup-close-button');
    await expect(close).toBeVisible();
    await close.click();
    await expect(popup).toBeHidden();
  });
});
