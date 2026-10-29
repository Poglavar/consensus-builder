// A Block drawn on a parcel layout's plots and left standing when the layout comes off the map is cut
// again by the parcel under it now: its buildings on the map follow today's parcel, not the plots,
// while its saved design keeps the pieces it was drawn with (UrbanRuleVariation.piecesOnGround).
import { test, expect } from '../helpers/fixtures';
import { applyLayout } from '../helpers/agreements';
import { openBlockEditor, expandStackSection, stackSection, parcelTab, closeParcel, clickMapPoint, showSelectionDesignTab, PARCEL_ID } from '../helpers/runtime';

test.describe('Block on an unapplied parcel layout @features', () => {
  test('the block left standing is cut by the parcel under it, not by the layout\'s plots', async ({ mockApi: page }) => {
    test.setTimeout(120_000);
    const { layoutId } = await applyLayout(page);
    const liveIds = () => page.evaluate(id => (window as any).LiveParcelFabric.entriesForCadastre([id])
      .map((feature: any) => String((window as any).LiveParcelFabric.featureId(feature))).sort(), PARCEL_ID);
    const plotIds: string[] = await liveIds();
    expect(plotIds.length).toBe(2);

    const before: string[] = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().map((p: any) => String(p.proposalId)));
    // Both plots, selected by hand (each is a formed parcel, in the stack's Formed section): one block over the two.
    await page.evaluate(id => (window as any).ClickStack.showParcel((window as any).LiveParcelFabric.get(id)), plotIds[0]);
    await expandStackSection(page, 'formed');
    await expect(stackSection(page, 'formed').locator('#parcel-info-panel')).toBeVisible();
    await parcelTab(page, 'info-tab').click();
    await page.locator('#parcel-manual-selection').click();
    await closeParcel(page);
    const [lng, lat] = await page.evaluate(id => (window as any).turf.pointOnFeature((window as any).LiveParcelFabric.get(id)).geometry.coordinates, plotIds[1]);
    await clickMapPoint(page, lng, lat);
    await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual(plotIds);
    await showSelectionDesignTab(page);
    await openBlockEditor(page);
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#btn-blockify-done').click();
    const newBlock = (known: string[]) => (window as any).proposalStorage.getAllProposals()
      .filter((p: any) => p.applied === true && p.buildingProposal && !known.includes(String(p.proposalId)))
      .map((p: any) => String(p.proposalId))[0] || null;
    await expect.poll(() => page.evaluate(newBlock, before), { timeout: 30_000 }).not.toBeNull();
    const blockId: string = await page.evaluate(newBlock, before);

    const pieces = () => page.evaluate(id => {
      const w = window as any;
      const onMap = (w.proposedBuildings || []).filter((f: any) => String(f.properties?.proposalId) === id);
      const saved = w.proposalStorage.getProposal(id).geometry.buildings;
      return {
        onMap: onMap.map((f: any) => String(f.properties.parcelId)).sort(),
        saved: saved.map((f: any) => String(f.properties.parcelId)).sort(),
        onMapArea: onMap.reduce((sum: number, f: any) => sum + w.turf.area(f), 0),
        savedArea: saved.reduce((sum: number, f: any) => sum + w.turf.area(f), 0),
      };
    }, blockId);

    // On the plots it was drawn on, the block stands as saved: one building per plot.
    const drawn = await pieces();
    expect(drawn.saved.length).toBe(2);
    expect(drawn.onMap.length).toBe(2);
    expect(Math.abs(drawn.onMapArea - drawn.savedArea) / drawn.savedArea).toBeLessThan(0.001);

    // The layout comes off and the block is left on the map (no alsoUnapplyIds).
    expect(await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), layoutId)).toBe(true);
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).applied, blockId)).toBe(true);
    const groundIds = await liveIds();
    expect(groundIds.some(id => plotIds.includes(id))).toBe(false);

    // The saved design is unchanged; on the map it is one building on today's parcel, no plot seam.
    const left = await pieces();
    expect(left.saved).toEqual(drawn.saved);
    expect(left.onMap).toEqual(groundIds);
    expect(Math.abs(left.onMapArea - drawn.savedArea) / drawn.savedArea).toBeLessThan(0.01);
  });
});
