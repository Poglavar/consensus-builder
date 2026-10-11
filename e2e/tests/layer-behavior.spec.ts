import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';

const PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

async function createGroundProposal(page: any, kind: 'park' | 'square'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-build-btn--${kind}`).click();
  const prompt = page.getByRole('alertdialog');
  if (await prompt.isVisible().catch(() => false)) {
    await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
  }
  await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals().some((proposal: any) => proposal.structureProposal?.kind === kind && proposal.applied), kind)).toBe(true);
  return page.evaluate(kind => (window as any).proposalStorage.getAllProposals().find((proposal: any) => proposal.structureProposal?.kind === kind).proposalId, kind);
}

async function openLayers(page: any) {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async ids => {
    await (window as any).CadastralParcelRepository.ensureIds(ids);
  }, PARCEL_IDS);
    await expect.poll(() => page.evaluate(ids => ids.filter((id: string) => !!(window as any).ParcelPresenter.getLayer(id)).length, PARCEL_IDS)).toBe(PARCEL_IDS.length);
    await expect.poll(() => page.evaluate(id => (window as any).LiveParcelFabric.get(id)?.properties?.BROJ_CESTICE, PARCEL_ID)).toBe('1234');
    await page.locator('#layers-button').click();
    await expect(page.locator('#layers-sheet')).toBeVisible();
    // The never-built claims-count toggle was dropped from the sheet (fbe3758d); the ad-parcel toggle
    // is the one parcel control zoom must never gate.
    await expect(page.locator('#showClaimsCounts')).toHaveCount(0);
    const adParcels = page.locator('#showAdParcelsCheckbox');
    await expect(adParcels).toBeEnabled();
    const zoomIn = page.locator('.leaflet-control-zoom-in');
    const zoomOut = page.locator('.leaflet-control-zoom-out');
    if (await zoomIn.count()) {
      await zoomIn.click();
      await expect(adParcels).toBeEnabled();
      await zoomOut.click();
      await expect(adParcels).toBeEnabled();
    }
}

test.describe('Layers sheet behavior @features', () => {
  test('parcel, ownership, label, ad, and minted controls produce visible map data', async ({ mockApi: page }) => {
    await openLayers(page);
    const mapHasParcels = () => page.evaluate(() => (window as any).map.hasLayer((window as any).parcelLayer));
    await page.locator('#parcelsCheckbox').uncheck();
    await expect.poll(mapHasParcels).toBe(false);
    await page.locator('#parcelsCheckbox').check();
    await expect.poll(mapHasParcels).toBe(true);

    const proposalId = await page.evaluate(id => (window as any).proposalStorage.addProposal({
      title: 'Layer count fixture', goal: 'decide-later', lifecycleStatus: 'Active', cadastreParcelIds: [id],
    }), PARCEL_ID);
    expect(proposalId).toBeTruthy();

    await page.locator('#showParcelNumbers').check();
    // The label is a span inside the marker's anchor icon since 51152a2e.
    await expect(page.locator('.leaflet-marker-icon.parcel-number-label-anchor .parcel-number-label').first()).toContainText('1234');
    await page.locator('#showOwnerCounts').check();
    await expect(page.locator('.parcel-owner-count-label').first()).toContainText('2');
    await page.locator('#showProposalCounts').check();
    await expect(page.locator('.parcel-proposal-count-label').first()).toContainText('1');
    const neutralStyle = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_IDS[0]);
    await page.locator('#highlightOwnershipGovernment').check();
    await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_IDS[1])).not.toBe(neutralStyle);
    await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_IDS[0])).toBe(neutralStyle);
    for (const [checkboxId, parcelId] of [
      ['highlightOwnershipInstitution', PARCEL_IDS[2]],
      ['highlightOwnershipCompany', PARCEL_IDS[3]],
      ['highlightOwnershipPrivate', PARCEL_IDS[0]],
    ]) {
      const previous = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, parcelId);
      await page.locator(`#${checkboxId}`).check();
      await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, parcelId)).not.toBe(previous);
    }

    await page.evaluate(id => (window as any).ParcelsMintedLayer.addMintedParcels([id]), PARCEL_ID);
    await page.locator('#markMintedCheckbox').check();
    await expect(page.locator('.minted-parcel-icon').first()).toBeVisible();

    const parcelStyleBeforeAd = await page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_ID);
    await page.locator('#showAdParcelsCheckbox').check();
    await expect.poll(() => page.evaluate(() => (window as any).ParcelsAdParcels.getAdParcelIds().has('HR-335754-1234'))).toBe(true);
    await expect.poll(() => page.evaluate(id => (window as any).ParcelPresenter.getLayer(id).options.fillColor, PARCEL_ID)).not.toBe(parcelStyleBeforeAd);
  });

  test('building and road reference layers load real features on checkbox clicks', async ({ mockApi: page }) => {
    await openLayers(page);
    await page.locator('#showBuildings').check();
    await expect.poll(() => page.evaluate(() => (window as any).buildingFeaturePool.some((feature: any) => feature.properties.object_id === 9001))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).buildingLayer))).toBe(true);

    await page.locator('#showBuildingsDgu').check();
    await expect.poll(() => page.evaluate(() => (window as any).dguBuildingLayer?.getLayers?.().length || 0)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).dguBuildingLayer))).toBe(true);
    await page.locator('#showBuildingsOsm').check();
    await expect.poll(() => page.evaluate(() => (window as any).osmBuildingLayer?.getLayers?.().length || 0)).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).osmBuildingLayer))).toBe(true);

    await page.locator('#showGovernmentRoadPlan').check();
    await expect.poll(() => page.evaluate(() => (window as any).governmentRoadPlanLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).governmentRoadPlanLayer))).toBe(true);

    await page.locator('#showOSMRoadLines').check();
    await expect.poll(() => page.evaluate(() => (window as any).osmRoadLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).osmRoadLayer))).toBe(true);
    await page.locator('#showGUPRoadLines').check();
    await expect.poll(() => page.evaluate(() => (window as any).gupRoadLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).map.hasLayer((window as any).gupRoadLayer))).toBe(true);

    await page.locator('#showLegacyRoadCenterlines').check();
    await expect.poll(() => page.evaluate(() => {
      const map = (window as any).map;
      let names = 0;
      map.eachLayer((layer: any) => { if (layer.getLayers?.().some((child: any) => child.feature?.properties?.name === 'Fixture street')) names++; });
      return names;
    })).toBeGreaterThan(0);

    await page.locator('#showWFSPolygons').check();
    await expect(page.locator('#status')).toContainText('Drew 1 DGU road-usage polygons');
    const withDguUse = await page.evaluate(() => {
      let count = 0;
      (window as any).map.eachLayer((layer: any) => { if (layer.getLayers?.().some((child: any) => child.feature?.properties?.OBJECTID === 801)) count++; });
      return count;
    });
    expect(withDguUse).toBeGreaterThan(0);
    await page.locator('#showWFSPolygons').uncheck();
    await expect.poll(() => page.evaluate(() => {
      let count = 0;
      (window as any).map.eachLayer((layer: any) => { if (layer.getLayers?.().some((child: any) => child.feature?.properties?.OBJECTID === 801)) count++; });
      return count;
    })).toBe(0);
  });

  test('proposed-building visibility follows a real applied building proposal', async ({ mockApi: page }) => {
    await openLayers(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--single').click();
    const prompt = page.getByRole('alertdialog');
    if (await prompt.isVisible().catch(() => false)) {
      await prompt.getByRole('button', { name: 'No, just this parcel' }).click();
    }
    await expect(page.locator('#single-building-modal')).toBeVisible();
    await expect(page.locator('#single-building-confirm')).toBeEnabled();
    await page.locator('#single-building-confirm').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposedBuildings.length)).toBeGreaterThan(0);
    await page.locator('#layers-button').click();
    // Proposed buildings use one Leaflet canvas renderer, so SVG path counts are not their display
    // contract. Count only features reachable from layers currently attached to the real map.
    const visibleProposalBuildings = () => page.evaluate(() => {
      const map = (window as any).map;
      let count = 0;
      const visit = (layer: any) => {
        if (layer?.feature?.properties?.proposalId) count++;
        layer?.eachLayer?.(visit);
      };
      map.eachLayer(visit);
      return count;
    });
    await page.locator('#showProposedBuildings').check();
    await expect.poll(visibleProposalBuildings).toBeGreaterThan(0);
    await page.locator('#showProposedBuildings').uncheck();
    await expect.poll(visibleProposalBuildings).toBe(0);
  });

  for (const kind of ['park', 'square'] as const) {
    test(`${kind} layer visibility follows its applied ground proposal`, async ({ mockApi: page }) => {
      await installLayerDatasets(page);
      await openCity(page);
      await createGroundProposal(page, kind);
      await page.locator('#layers-button').click();
      const paneName = kind === 'park' ? 'parksPane' : 'squaresPane';
      const checkbox = page.locator(kind === 'park' ? '#showParksCheckbox' : '#showSquaresCheckbox');
      const panePaths = () => page.evaluate(name => (window as any).map.getPane(name)?.querySelectorAll('path').length || 0, paneName);
      await expect.poll(panePaths).toBeGreaterThan(0);
      await checkbox.uncheck();
      await expect.poll(panePaths).toBe(0);
      await checkbox.check();
      await expect.poll(panePaths).toBeGreaterThan(0);
    });
  }
});
