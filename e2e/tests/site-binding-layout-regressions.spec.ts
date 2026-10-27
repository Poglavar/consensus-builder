import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { fixtureSiteBinding } from '../helpers/mocks/site-binding';
import type { Page } from '@playwright/test';

async function drawSite(page: Page) {
  await page.evaluate(async () => {
    const w = window as any;
    await w.CadastralParcelRepository.ensureIds(['HR-335754-1235']);
    w.map.setView([45.80025, 15.98255], 19, { animate: false });
  });
  await clickMapPoint(page, 15.98255, 45.80025);
  await page.locator('#click-stack [data-command="ground.drawSite"]').click();
  const panel = page.locator('#site-panel');
  await expect(panel).toBeVisible();
  for (const [lng, lat] of [[15.98235, 45.80012], [15.98275, 45.80012], [15.98275, 45.80038], [15.98235, 45.80038]]) {
    await clickMapPoint(page, lng, lat);
  }
  await panel.locator('[data-site-action="finish"]').click();
  await expect(panel.locator('[data-site-action="propose"]')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => !!(window as any).SiteTool.current().server)).toBe(true);
  const site = await page.evaluate(() => structuredClone((window as any).SiteTool.current().site));
  await panel.locator('[data-site-action="propose"]').click();
  return site;
}

async function editSavedLayout(page: Page, id: string) {
  await page.locator('#proposals-button').click();
  await page.locator(`#proposals-sheet .lists-item[data-list-id="${id}"] .lists-item__title`).click();
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  const editor = page.locator('.on-map-reparcellization');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  await expect(editor.locator('[data-reparcel-commit]')).toBeEnabled();
  return editor;
}

test('an applied site subdivision edits its own open ground and survives reload', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(120_000);
  await openCity(page);
  const site = await drawSite(page);
  await page.locator('#site-info-panel .parcel-build-btn--parcel-layout').click();
  let editor = page.locator('.on-map-reparcellization');
  await expect(editor.locator('[data-reparcel-commit]')).toBeEnabled();
  await editor.locator('[data-parcel-layout-count]').fill('3');
  await editor.locator('[data-parcel-layout-count]').press('Enter');
  await expect(editor.locator('[data-reparcel-newplots-table] tbody tr')).toHaveCount(3);
  await editor.locator('[data-reparcel-commit]').click();
  const record = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.goal === 'parcel-layout'));
  await expect.poll(async () => (await record())?.applied).toBe(true);
  const id = (await record()).proposalId;
  expect((await record()).parcelLayout.openGroundM2).toBeGreaterThan(0);
  editor = await editSavedLayout(page, id);
  await editor.locator('[data-parcel-layout-count]').fill('4');
  await editor.locator('[data-parcel-layout-count]').press('Enter');
  await expect(editor.locator('[data-reparcel-newplots-table] tbody tr')).toHaveCount(4);
  await editor.locator('[data-reparcel-commit]').click();
  await expect.poll(async () => (await record())?.parcelLayout?.plots?.length).toBe(4);
  await page.reload({ waitUntil: 'commit' });
  await waitForMapReady(page);
  await page.waitForFunction(() => !!(window as any).proposalStorage && (window as any).map?._loaded && !document.body.classList.contains('app-loading'));
  await expect.poll(async () => (await record())?.applied).toBe(true);
  expect((await record()).site).toEqual(site);
  editor = await editSavedLayout(page, id);
  await expect(editor.locator('[data-reparcel-newplots-table] tbody tr')).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath('subdivision-reopened.png') });
  await editor.locator('[data-reparcel-cancel]').click();
});

test('unknown coverage blocks initial site Park application and keeps a retryable drawing', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await openCity(page);
  let unknown = true, requests = 0;
  await page.route('**/designs/binding', async route => {
    requests++;
    const body = route.request().postDataJSON();
    const binding = fixtureSiteBinding(body.site, body.toleranceM || 0);
    await route.fulfill({ json: { binding: unknown ? { ...binding, coverage: 'unknown', parcels: [], unknownM2: binding.siteM2 } : binding } });
  });
  const site = await drawSite(page);
  await page.locator('#site-info-panel .parcel-build-btn--park').click();
  await expect(page.locator('#structure-geometry-editor .on-map-editor__panel')).toBeVisible();
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
  expect(requests).toBeGreaterThan(1);
  const draft = await page.evaluate(() => (window as any).proposalDraftStore.getActiveDraft());
  expect(draft.fields.site).toEqual(site);
  expect(draft.editorPayload.placement.bindingStatus).toBe('pending');
  unknown = false;
  await page.locator('#structure-geometry-editor [data-action="save"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied && p.goal === 'park').length)).toBe(1);
  const saved = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()[0]);
  expect(saved.site).toEqual(site);
  expect(saved.binding.coverage).toBe('partial');
});
