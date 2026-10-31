import { test, expect } from '../helpers/fixtures';
import { placeFreeformBuilding, openCity, openParcel, createSpace, proposalState, showProposal, clickMapPoint, drawCorridor, PARCEL_ID, openParcelTabAt, closeParcel, showSelectionDesignTab } from '../helpers/runtime';

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
      // Stops are transport tools in the parcel palette since the Tools sheet went (fbe3758d). The
      // corridor split parcel 1234, so open the palette from its northern remainder.
      await openParcelTabAt(page, 15.9822, 45.80045, 'propose-tab');
      await page.locator(`#parcel-info-panel .parcel-transport-btn--${type === 'bus' ? 'roadStation' : 'trackStation'}`).click();
      if(type !== 'bus') await page.getByRole('dialog',{name:'Track station',exact:true}).locator(`[data-station-level="${type}"]`).click();
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
      await openParcel(page, 'proposals');
      if (type === 'row') {
        await page.locator('#parcel-manual-selection').click();
        await closeParcel(page);
        await clickMapPoint(page, 15.9829, 45.80025);
        await showSelectionDesignTab(page);
      }
      await page.locator(`.parcel-build-btn--${type}`).click();
      if (type === 'single') await placeFreeformBuilding(page);
      if (type === 'buildings') {
        const prompt = page.getByRole('alertdialog');
        if (await prompt.isVisible().catch(() => false)) {
          await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
        }
      }
      if (type === 'single') {
        await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²', { timeout: 15_000 });
      }
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

  test('parcel layout: its plots reach an applied layout that replaces the parcel on the map', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcel-layout').click();
    const modal = page.locator('.on-map-reparcellization');
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await expect(modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row')).toHaveCount(2);
    await modal.locator('[data-reparcel-plots-tab="old"]').click();
    await expect(modal.locator('[data-reparcel-oldplots-table]')).toContainText('1234');
    await modal.locator('[data-reparcel-plots-tab="new"]').click();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled();
    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((p: any) => p.applied && p.goal === 'parcel-layout' && p.parcelLayout?.plots?.length === 2))).toBe(true);
    const layout = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.applied && p.goal === 'parcel-layout'))));
    expect(layout.cadastreParcelIds).toContain(PARCEL_ID);
    expect(layout.parcelLayout.plots.every((plot: any) => /Polygon/.test(plot.geometry.type))).toBe(true);
    await expect.poll(() => page.evaluate(id => (window as any).LiveParcelFabric.producedBy(id)
      .filter((piece: any) => piece.properties.readjustmentPiece?.role === 'plot').length, layout.proposalId)).toBe(2);
  });
});
