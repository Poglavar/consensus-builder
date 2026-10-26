// The city planet reports whether the current address can reproduce the applied composition,
// and remains an icon-only globe launcher in model and aerial 3D, including narrow screens.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, stubBasemapTiles } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';

const plans = require('../../frontend/js/plan-record.js');

test('planet follows local creation, exact plan membership, edits, application and deletion', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await openCity(page);
  const planet = page.locator('.map-search__chip');
  await expect(planet).toHaveAttribute('data-share-state', 'shared');
  await expect(planet).toHaveAttribute('title', /ready to share/);
  const id = await createSpace(page, 'park');
  await expect(planet).toHaveAttribute('data-share-state', 'local');
  await expect(planet).toHaveAttribute('aria-label', /Local changes.*use Share/);
  const original = await page.evaluate(id => (window as any).DesignRecord.published((window as any).proposalStorage.getProposal(id)), id);
  const index = pageIndex(page), cid = fileDesign(index, original);
  await page.evaluate(({ id, cid }) => {
    const w = window as any;
    w.DesignSync.markPublished(w.proposalStorage.getProposal(id), { cid, apiBase: w.resolveBackendBaseUrl() });
  }, { id, cid });
  // Publication does not make an address without members reproduce a design.
  await expect(planet).toHaveAttribute('data-share-state', 'local');
  const planCid = filePlan(index, plans.create('Park plan', [cid], { mode: '2d', at: '45.80025,15.9822,18', city: 'zg', language: 'en' }));
  await page.goto(`/plans/${planCid}?city=zg&at=45.80025,15.9822,18&lang=en&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect(planet).toHaveAttribute('data-share-state', 'shared');
  const colors = await planet.locator('.map-search__planet').evaluate(icon => ({
    actual: getComputedStyle(icon).color,
    expected: getComputedStyle(document.documentElement).getPropertyValue('--cb-success').trim()
  }));
  expect(colors.actual).not.toBe('');
  await page.evaluate(id => {
    const w = window as any, record = w.proposalStorage.getProposal(id);
    record.title = 'Locally edited park';
    return w.proposalStorage.save();
  }, id);
  await expect(planet).toHaveAttribute('data-share-state', 'local');
  await page.evaluate(({ id, title }) => {
    const w = window as any;
    w.proposalStorage.getProposal(id).title = title;
    return w.proposalStorage.save();
  }, { id, title: original.title });
  await expect(planet).toHaveAttribute('data-share-state', 'shared');
  await page.evaluate(id => (window as any).ProposalManager.unapplyProposal(id), id);
  await expect(planet).toHaveAttribute('data-share-state', 'local');
  await page.evaluate(id => (window as any).ProposalManager.applyProposal(id), id);
  await expect(planet).toHaveAttribute('data-share-state', 'shared');
  await page.evaluate(() => (window as any).map.setView([45.80035, 15.9823], 18, { animate: false }));
  await expect(planet).toHaveAttribute('data-share-state', 'shared');
  await page.evaluate(id => (window as any).ProposalManager.deleteProposal(id), id);
  await expect(planet).toHaveAttribute('data-share-state', 'local');
});

for (const mode of ['model', 'photo'] as const) {
  test(`${mode} keeps the status planet alone and opens the globe`, async ({ mockApi: page }) => {
    await page.setViewportSize(mode === 'model' ? { width: 1280, height: 844 } : { width: 320, height: 757 });
    await stubBasemapTiles(page);
    await mockBuildingScene(page);
    if (mode === 'photo') await mockPhotoTiles(page);
    await openCity(page);
    const planet = page.locator('.map-search__chip');
    await expect(planet).toHaveAttribute('data-share-state', 'shared');
    await expect(planet.locator('.map-search__planet')).toBeVisible();
    await page.locator(mode === 'model' ? '#mode-3d-toggle' : '#mode-realistic-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as any).__mapModeState)).toEqual({ desired: mode, pending: false });
    await expect(planet).toBeVisible();
    await expect(planet.locator('.map-search__planet')).toBeVisible();
    await expect(planet.locator('.map-search__chip-label').first()).toBeHidden();
    await expect(page.locator('.map-search__field')).toBeHidden();
    const box = await planet.boundingBox();
    expect(box).toBeTruthy();
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);
    await expect(planet).toHaveAttribute('data-share-state', 'shared');
    await page.keyboard.press('/');
    await expect(page.locator('#map-search-input')).toBeHidden();
    await page.locator('#mode-2d-toggle').click();
    await expect(planet.locator('.map-search__chip-label').first()).toBeVisible();
    await expect(page.locator('.map-search__field')).toBeVisible();
    await page.locator(mode === 'model' ? '#mode-3d-toggle' : '#mode-realistic-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as any).__mapModeState)).toEqual({ desired: mode, pending: false });
    await planet.click();
    await expect(page.locator('#world-view')).toBeVisible({ timeout: 15_000 });
  });
}
