import { Locator, Page, expect } from '@playwright/test';
import { sampleParcels } from './mocks/parcel-data';
import { waitForMapReady } from './app';
import { selectNativeOption } from './controls';

export const PARCEL_ID = sampleParcels.features[0].properties.parcelId;
export const PARCEL_GEOMETRY = sampleParcels.features[0].geometry;

// The status line has one writer at a time and ground loading writes to it too, so a message can be
// replaced before an assertion reads it. Logged messages (non-transient updateStatus calls) are
// asserted from the session's status log instead.
export async function expectStatusLogged(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate(t => (window as any).statusLogEntries().some((entry: any) => String(entry.message).includes(t)), text)).toBe(true);
}

export async function openCity(page: Page): Promise<void> {
  // Readiness is the map/repository below; slow external basemap tiles must not hold navigation open.
  await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.waitForFunction(() => {
    const w = window as any;
    return !!w.proposalStorage && !!w.CadastralParcelRepository && !!w.ParcelPresenter && !!w.ProposalManager;
  });
  await page.evaluate(async (id) => {
    const w = window as any;
    w.map.setView([45.80025, 15.9822], 18, { animate: false });
    await w.CadastralParcelRepository.ensureIds([id]);
  }, PARCEL_ID);
  await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), PARCEL_ID)).toBe(true);
}

export async function clickMapPoint(page: Page, lng: number, lat: number): Promise<void> {
  const point = await page.evaluate(({ lng, lat }) => {
    const w = window as any;
    const p = w.map.latLngToContainerPoint([lat, lng]);
    const box = w.map.getContainer().getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  }, { lng, lat });
  await page.mouse.click(point.x, point.y);
}

export async function openParcel(page: Page, tab = 'info', id = PARCEL_ID): Promise<void> {
  const center = await page.evaluate(parcelId => {
    const w = window as any;
    const layer = w.ParcelPresenter.getLayer(parcelId);
    if (!layer) throw new Error(`ParcelPresenter has no layer for ${parcelId}`);
    const center = layer.getBounds().getCenter();
    w.map.panTo(center, { animate: false });
    return { lng: center.lng, lat: center.lat };
  }, id);
  await clickMapPoint(page, center.lng, center.lat);
  await expect(page.locator('#parcel-menu')).toBeVisible();
  await page.locator('#parcel-menu').getByRole('menuitem', { name: tab === 'proposals' ? 'Propose here' : tab === 'tools' ? 'Tools' : 'Details', exact: true }).click();
  await expect(page.locator('#parcel-info-panel')).toBeVisible();
}

// A proposal published on the server that this browser has never loaded: the answer to the Proposals
// tabs' GET /proposals/summary?parcel_ids=… (js/parcels/parcel-set-proposals.js).
export async function publishOn(page: Page, parcelId: string): Promise<void> {
  await page.route('**/proposals/summary**', route => {
    const publicationApiBase = new URL(route.request().url()).origin;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      proposals: [{ id: 41, proposalId: 'p-published', publicationApiBase, city: 'zagreb', title: 'Published park', type: 'park', goal: 'park',
        lifecycleStatus: 'Active', createdAt: '2026-10-12T10:00:00.000Z', cadastreParcelIds: [parcelId], screenshotUrl: null }],
      count: 1, limit: 200, offset: 0
    }) });
  });
}

export async function createSpace(page: Page, kind: 'park'|'square'|'lake'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-build-btn--${kind}`).click();
  await expect.poll(() => page.evaluate(kind => (window as any).proposalStorage.getAllProposals().some((p: any) => p.structureProposal?.kind === kind && p.applied), kind)).toBe(true);
  return page.evaluate(kind => (window as any).proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.kind === kind).proposalId, kind);
}

export async function proposalState(page: Page, id: string): Promise<any> {
  return page.evaluate(id => JSON.parse(JSON.stringify((window as any).getProposalByIdOrHash(id))), id);
}

export async function showProposal(page: Page, id: string): Promise<void> {
  await page.evaluate(id => (window as any).showProposalDetails(id), id);
  await expect(page.locator('#proposal-details-panel')).toBeVisible();
}

export async function drawCorridor(page: Page, kind: 'road'|'track'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-transport-btn--${kind}`).click();
  if (kind === 'track') await page.locator('#track-speed-confirm-btn').click();
  await expect(page.locator('#road-drawing-controls')).toBeVisible();
  await clickMapPoint(page, 15.98195, 45.80025);
  await clickMapPoint(page, 15.98245, 45.80025);
  await page.locator('#finishRoadButton').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.roadProposal && p.applied))).toBe(true);
  return page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.roadProposal && p.applied).proposalId);
}

export async function createBuilding(page: Page, rule: 'exact' | 'max' | 'range' = 'exact'): Promise<string> {
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--buildings').click();
  await selectNativeOption(page.locator('#blockify-ruletype-select'), rule);
  if (rule !== 'exact') {
    await page.locator('#height-slider').focus();
    await page.keyboard.press('End');
  }
  await expect(page.locator('#btn-blockify-done')).toBeEnabled();
  await page.locator('#btn-blockify-done').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.geometry?.buildings?.length && p.applied))).toBe(true);
  return page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.geometry?.buildings?.length && p.applied).proposalId);
}

/**
 * Share on a local proposal whose terms were never chosen opens the create dialog in its terms
 * mode first (proposal-kinds.md): pick who decides, save, and the share dialog opens for that same
 * record, whose id this returns.
 */
export async function chooseTermsForShare(page: Page, kind: 'owner-deal'|'owner-vote'|'community-vote' = 'community-vote'): Promise<string> {
  const form = page.locator('.create-proposal-modal:visible');
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="proposalKind"][value="community-vote"]')).toBeChecked();
  await expect(form).toHaveAttribute('data-publish-in-place', '');
  await expect(form.locator('#proposalGoalGroup')).toBeHidden();
  await form.locator(`input[name="proposalKind"][value="${kind}"]`).locator('..').click();
  await expect(form.locator('#createProposalSubmitButton')).toHaveText('Save terms');
  await form.locator('#createProposalSubmitButton').click();
  await expect(form).toBeHidden({ timeout: 30_000 });
  await expect(page.locator('.share-modal-overlay')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(kind => {
    const saved = (window as any).proposalStorage.getAllProposals().filter((p: any) => p.termsConfirmed && p.kind === kind);
    return saved[saved.length - 1].proposalId;
  }, kind);
}

/** Pick who decides in an open create dialog; only an owner deal shows the money terms. */
export async function chooseProposalKind(dialog: Locator, kind: 'owner-deal'|'owner-vote'|'community-vote'): Promise<void> {
  await dialog.locator(`input[name="proposalKind"][value="${kind}"]`).locator('..').click();
  await expect(dialog).toHaveAttribute('data-proposal-kind', kind);
}
