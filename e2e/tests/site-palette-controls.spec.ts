// Exercise every action of the site's proposal panel ("Propose here") through its real UI handlers.
import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, PARCEL_ID } from '../helpers/runtime';

const SECOND_PARCEL_ID = 'HR-335754-1235';

async function beginParcelSite(page: import('@playwright/test').Page) {
  await openCity(page);
  await clickMapPoint(page, 15.9822, 45.80025);
  await page.locator('#parcel-menu [data-command="parcel.useAsSite"]').click();
  const panel = page.locator('#site-panel');
  await expect(panel).toBeVisible();
  const site = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).SiteTool.current().site)));
  await panel.locator('[data-site-action="propose"]').click();
  const proposals = page.locator('#site-info-panel');
  await expect(proposals).toBeVisible();
  return { panel: proposals, site };
}

async function expectActiveDraftSite(page: import('@playwright/test').Page, site: any, adapterKey: string) {
  await expect.poll(() => page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft()?.adapterKey || null)).toBe(adapterKey);
  const draft = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalDraftStore.getActiveDraft())));
  expect(draft.fields.site).toEqual(site);
  expect(draft.fields.binding.parcels.map((hit: any) => hit.parcelId)).toContain(PARCEL_ID);
}

test.describe('Site build palette controls @core', () => {
  for (const item of [
    { key: 'buildings', adapter: 'buildings', surface: '#blockify-modal', label: 'Block' },
    { key: 'single', adapter: 'single', surface: '#single-building-modal', label: 'Freeform' },
  ]) test(`${item.label} opens its editor draft on the authored site`, async ({ mockApi: page }) => {
    const { panel, site } = await beginParcelSite(page);
    await panel.locator(`.parcel-build-btn--${item.key}`).click();
    await expect(page.locator(item.surface)).toBeVisible();
    await expectActiveDraftSite(page, site, item.adapter);
  });

  for (const item of [
    { key: 'row', adapter: 'row', surface: '#rowhouse-modal', label: 'Row houses' },
    { key: 'parcelBased', adapter: 'parcelBased', surface: '#parcelbased-modal', label: 'Detached' },
  ]) test(`${item.label} plot flow opens its editor draft on the authored site`, async ({ mockApi: page }) => {
    const { panel, site } = await beginParcelSite(page);
    await panel.locator(`.parcel-build-btn--${item.key}`).click();
    // Plot cutting continues on the site card; the proposal panel steps aside.
    const card = page.locator('#site-panel');
    await expect(panel).toBeHidden();
    await expect(card.locator('[data-site-action="plots-continue"]')).toBeEnabled();
    await expect(card.locator('[data-site-action="plots-back"]')).toBeVisible();
    await card.locator('[data-site-action="plots-continue"]').click();
    await expect(page.locator(item.surface)).toBeVisible();
    await expectActiveDraftSite(page, site, item.adapter);
  });

  for (const kind of ['park', 'square', 'lake']) test(`${kind} creates the matching structure from the authored site`, async ({ mockApi: page }) => {
    const { panel, site } = await beginParcelSite(page);
    await panel.locator(`.parcel-build-btn--${kind}`).click();
    await expect(panel).toBeHidden();
    await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals().some((proposal: any) =>
      proposal.applied && proposal.structureProposal?.kind === kind && proposal.site), kind)).toBe(true);
    const result = await page.evaluate(kind => {
      const proposal = (window as any).proposalStorage.getAllProposals().find((item: any) =>
        item.applied && item.structureProposal?.kind === kind && item.site);
      return { site: proposal.site, geometry: proposal.structureProposal.geometry };
    }, kind);
    expect(result.site).toEqual(site);
    const siteArea = await page.evaluate(geometry => (window as any).turf.area(geometry), site);
    const structureArea = await page.evaluate(geometry => (window as any).turf.area(geometry), result.geometry);
    expect(Math.abs(structureArea - siteArea)).toBeLessThan(0.1);
  });

  test('Subdivide opens a site-pool readjustment editor when the authored site includes open ground', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(async id => { await (window as any).CadastralParcelRepository.ensureIds([id]); }, SECOND_PARCEL_ID);
    await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), SECOND_PARCEL_ID)).toBe(true);
    await page.evaluate(() => (window as any).map.setView([45.80025, 15.98255], 19, { animate: false }));
    await clickMapPoint(page, 15.98255, 45.80025);
    await expect(page.locator('#ground-menu')).toBeVisible();
    await page.locator('#ground-menu [data-command="ground.drawSite"]').click();
    const panel = page.locator('#site-panel');
    await expect(panel).toBeVisible();
    await clickMapPoint(page, 15.98235, 45.80012);
    await clickMapPoint(page, 15.98275, 45.80012);
    await clickMapPoint(page, 15.98275, 45.80038);
    await clickMapPoint(page, 15.98235, 45.80038);
    await expect(panel.locator('[data-site-action="finish"]')).toBeEnabled();
    await panel.locator('[data-site-action="finish"]').click();
    await expect(panel.locator('[data-site-action="propose"]')).toBeEnabled();
    const openGroundArea = await page.evaluate(() => (window as any).__siteDraft.bindingSummary((window as any).SiteTool.current().preview).unsurveyedM2);
    expect(openGroundArea).toBeGreaterThan(0);
    await panel.locator('[data-site-action="propose"]').click();
    const subdivide = page.locator('#site-info-panel .parcel-build-btn--reparcellization');
    await expect(subdivide).toBeEnabled();
    await expect(subdivide).toHaveText(/Subdivide/i);
    await subdivide.click();
    const modal = page.locator('.reparcel-modal-overlay');
    await expect(modal).toBeVisible();
    const plan = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).pendingReparcellizationPlan)));
    expect(plan.poolSource).toBe('site');
    expect(plan.poolGeometry).toEqual(await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalDraftStore.getActiveDraft().fields.site))));
  });

  for (const item of [
    { key: 'road', status: '#road-drawing-controls', label: 'Road' },
    { key: 'track', status: '#road-drawing-controls', label: 'Track' },
  ]) test(`${item.label} opens the real corridor drawing tool from the site palette`, async ({ mockApi: page }) => {
    const { panel } = await beginParcelSite(page);
    await panel.locator(`.parcel-transport-btn--${item.key}`).click();
    if (item.key === 'track') {
      await expect(page.locator('#track-speed-confirm-btn')).toBeVisible();
      await page.locator('#track-speed-confirm-btn').click();
    }
    await expect(page.locator(item.status)).toBeVisible();
    await expect(panel).toBeHidden();
    await page.locator('#road-drawing-controls').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
  });

  for (const item of [
    { key: 'bus' },
    { key: 'tram' },
    { key: 'underground' },
    { key: 'elevated' },
  ]) test(`${item.key} station starts real placement mode from the site palette`, async ({ mockApi: page }) => {
    const { panel } = await beginParcelSite(page);
    await panel.locator(`.parcel-transport-btn--${item.key}`).click();
    const toolbar = page.locator('#station-placement-toolbar');
    await expect(toolbar).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(true);
    const mapPoint = await page.evaluate(() => {
      const map = (window as any).map;
      const center = map.latLngToContainerPoint(map.getCenter());
      const bounds = map.getContainer().getBoundingClientRect();
      return { x: bounds.left + center.x, y: bounds.top + center.y };
    });
    await page.mouse.move(mapPoint.x, mapPoint.y);
    const preview = page.locator('.transit-station-marker--preview span');
    await expect(preview).toBeVisible();
    const expectedIcon = await page.evaluate(key => (window as any).TransitStationModels.specFor(key).icon, item.key);
    await expect(preview).toHaveText(expectedIcon);
    await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#station-placement-status')).toContainText('Station placement cancelled.');
    await expect.poll(() => page.evaluate(() => (window as any).transitStationPlacementMode)).toBe(false);
  });
});
