import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, createSpace, proposalState, showProposal, clickMapPoint, drawCorridor, PARCEL_ID } from '../helpers/runtime';

test.describe('Proposal creation and map lifecycle @features', () => {
  for (const kind of ['park', 'square', 'lake'] as const) {
    test(`${kind}: create, unapply, reapply and restore after reload`, async ({ mockApi: page }) => {
      await openCity(page);
      const id = await createSpace(page, kind);
      const created = await proposalState(page, id);
      expect(created.structureProposal.geometry.type).toMatch(/Polygon/);
      expect(created.cadastreParcelIds).toContain(PARCEL_ID);
      expect(created.applied).toBe(true);
      const produced = () => page.evaluate(id => (window as any).LiveParcelFabric.producedBy(id).length, id);
      await expect.poll(produced).toBeGreaterThan(0);
      await showProposal(page, id);
      await page.locator(`[id="proposal-action-btn-${id}"]`).click();
      await expect.poll(async () => (await proposalState(page, id)).applied).toBe(false);
      await expect.poll(produced).toBe(0);
      await showProposal(page, id);
      await page.locator(`[id="proposal-action-btn-${id}"]`).click();
      await expect.poll(async () => (await proposalState(page, id)).applied).toBe(true);
      await page.reload();
      await page.waitForFunction(id => (window as any).proposalStorage?.getProposal(id)?.applied, id);
      await expect.poll(produced).toBeGreaterThan(0);
    });
  }

  for (const type of ['bus', 'tram', 'underground', 'elevated']) {
    test(`${type} station: place on the map and persist the applied stop`, async ({ mockApi: page }) => {
      await openCity(page);
      await drawCorridor(page, type === 'bus' ? 'road' : 'track');
      await page.locator('#tools-button').click();
      await page.locator(`#tools-sheet [onclick="startTransitStationPlacement('${type}')"]`).click();
      await page.locator('#tools-button').click();
      await clickMapPoint(page, 15.9822, 45.80025);
      await expect.poll(() => page.evaluate(type => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.structureProposal?.stationType === type).length, type)).toBe(1);
      const station = await page.evaluate(type => (window as any).proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.stationType === type), type);
      expect(station.applied).toBe(true);
      expect(station.title).toBeTruthy();
    });
  }

  for (const [type, done] of [['buildings', '#btn-blockify-done'], ['row', '#btn-rowhouse-done'], ['parcelBased', '#btn-parcelbased-done'], ['single', '#single-building-confirm']]) {
    test(`${type}: finish its design tool into an applied building proposal`, async ({ mockApi: page }) => {
      await openCity(page);
      await openParcel(page, type === 'row' ? 'info' : 'proposals');
      if (type === 'row') {
        await page.locator('#multiSelectCheckboxInfo').check();
        await page.locator('#parcel-info-panel .close-button').click();
        await clickMapPoint(page, 15.9829, 45.80025);
        await page.locator('#selection-tray [data-command="selection.propose"]').click();
      }
      await page.locator(`.parcel-build-btn--${type}`).click();
      await expect(page.locator(done)).toBeVisible();
      await expect(page.locator(done)).toBeEnabled({ timeout: 15000 });
      await page.locator(done).click();
      await expect(page.locator(done)).toBeHidden();
      await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied && p.geometry?.buildings?.length).length)).toBe(1);
      const proposal = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.geometry?.buildings?.length));
      expect(proposal.cadastreParcelIds).toContain(PARCEL_ID);
      expect(proposal.geometry.buildings[0].geometry.type).toMatch(/Polygon/);
      expect(proposal.title).toBeTruthy();
      expect(await page.evaluate(() => (window as any).proposedBuildings.length)).toBeGreaterThan(0);
    });
  }

  test('reparcellization: plots and ownership reach an applied plan', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--reparcellization').click();
    const modal = page.locator('.reparcel-modal-overlay');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-reparcel-newplots-table]')).not.toBeEmpty();
    await modal.locator('[data-reparcel-plots-tab="old"]').click();
    await expect(modal.locator('[data-reparcel-oldplots-table]')).toContainText('1234');
    await modal.locator('[data-reparcel-plots-tab="new"]').click();
    await expect(modal.locator('[data-reparcel-owners-table]')).toContainText('Private owner');
    await expect(modal.locator('[data-reparcel-owners-table]')).not.toContainText('Privatni vlasnik');
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled();
    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.reparcellization?.polygons?.length))).toBe(true);
  });
});
