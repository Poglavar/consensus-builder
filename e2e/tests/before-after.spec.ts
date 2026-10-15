// The before/after divider outside the land readjustment modal (dividers.md): an applied proposal
// in the details panel (M2), the bet dialog's two pictures (M3), the cross-section editor's chip
// (M4), a replaced version's outline (M5) and one parcel of an applied readjustment (M6). The
// modal's own divider is covered by land-readjustment-audit.spec.ts and designer-controls.spec.ts.
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, openParcel, createSpace, showProposal, drawCorridor, clickMapPoint, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';

const PROPOSAL_ACCOUNT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
// A 1×1 PNG stands in for a rendered picture; the dialog accepts data URLs like any other image.
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const beforeMap = (page: Page) => page.locator('#map .map-compare__before');
const divider = (page: Page) => page.locator('#map .map-compare__handle');
const dragging = (page: Page) => page.evaluate(() => (window as any).map.dragging.enabled());
const beforeLayers = async (page: Page) => JSON.parse((await beforeMap(page).getAttribute('data-layers')) || '{}');

// The full reader, with its parcels section open (the per-parcel chips live there).
async function openParcelsSection(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).toggleProposalDetailsPanelMinimized(false));
  const summary = page.locator('#proposal-details-panel details.proposal-detail-section summary').filter({ hasText: 'Land & ownership' });
  await expect(summary).toBeVisible();
  if (!(await summary.evaluate(el => (el.parentElement as HTMLDetailsElement).open))) await summary.click();
}

function marketsPayload(pictures: { screenshotUrl: string | null; screenshotBeforeUrl: string | null }) {
  const market = { address: 'HQqbGtviQr5KRs4x8CWSCVhnkrLKDiYqXmVSBY8GZdfw', yesPool: '250000', noPool: '50000', poolAtomic: '300000', resolved: false, outcome: null };
  return {
    city: 'zagreb', generatedAt: '2026-10-12T07:00:00.000Z', cluster: 'devnet', stakeDecimals: 6,
    marketProgram: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB', stakeMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    summary: { contests: 1, proposals: 1, markets: 1, openMarkets: 1, poolAtomic: '300000' },
    contests: [{
      id: 'c-test', parcelIds: ['HR-335614-2311'], proposalCount: 1, mintedCount: 1, marketCount: 1, openMarketCount: 1,
      poolAtomic: '300000', latestCreatedAt: '2026-10-02T00:00:00Z',
      proposals: [{
        id: 789, proposalId: 'minted-one', title: 'Plan-led infill', goal: 'single', lifecycleStatus: 'Active', createdAt: '2026-10-01T09:30:00Z',
        expiresAt: null, author: 'densifier-01', agent: true, proposalRole: null, parcelIds: ['HR-335614-2311'],
        proposalAccount: PROPOSAL_ACCOUNT, bettable: true, canOpenMarket: false, market, ...pictures
      }]
    }]
  };
}

test.describe('Before / after on the main map @features', () => {
  test('an applied proposal compares the ground as it stands with the map it changed, from the details panel', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);

    const button = page.locator('#proposal-details-panel .btn-compare-proposal');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();

    await expect(beforeMap(page)).toBeVisible();
    const handle = divider(page);
    await expect(handle).toHaveAttribute('role', 'slider');
    await expect(handle).toHaveAttribute('aria-valuenow', '50');
    // On the main map the labels ride the divider: its bottom corners sit under the tab bar.
    await expect(handle.locator('.map-compare__label--before')).toHaveText('Before');
    await expect(handle.locator('.map-compare__label--after')).toHaveText('After');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await dragging(page)).toBe(false);

    // The before map carries the host's basemap and the parcels, on one canvas.
    await expect.poll(() => beforeMap(page).locator('img.leaflet-tile').count()).toBeGreaterThan(0);
    await expect.poll(() => beforeMap(page).locator('canvas').count()).toBeGreaterThan(0);
    expect((await beforeLayers(page)).parcels).toBeGreaterThan(0);

    // The divider took focus and the keyboard moves it.
    await expect(handle).toBeFocused();
    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '0');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '6');
    expect(await beforeMap(page).evaluate(el => (el as HTMLElement).style.clipPath)).toMatch(/^inset\(0(px)? [\d.]+px 0(px)? 0(px)?\)$/);

    await button.click();
    await expect(beforeMap(page)).toHaveCount(0);
    await expect(divider(page)).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await dragging(page)).toBe(true);

    // Unapplying ends the comparison and takes the button with it: there is no "after" any more.
    await button.click();
    await expect(beforeMap(page)).toBeVisible();
    await page.evaluate(id => (window as any).removeProposalFromMap(id), id);
    await expect(beforeMap(page)).toHaveCount(0);
    await expect(page.locator('#proposal-details-panel .btn-compare-proposal')).toHaveCount(0);
    expect(await dragging(page)).toBe(true);
  });

  test('divider release preserves comparison and normal parcel selection still works', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    const button = page.locator('#proposal-details-panel .btn-compare-proposal');
    await button.click();
    const state = () => page.evaluate(() => {
      const w = window as any;
      return { center: w.map.getCenter(), proposal: w.currentlyHighlightedProposalId, parcel: w.selectedParcelId };
    });
    const original = await state();
    await page.evaluate(() => {
      const w = window as any; w.__dividerMapClicks = 0;
      w.map.on('click', () => w.__dividerMapClicks++);
    });
    const mapBox = (await page.locator('#map').boundingBox())!;
    for (const percent of [72, 28]) {
      const grip = (await divider(page).locator('.map-compare__grip').boundingBox())!;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(mapBox.x + mapBox.width * percent / 100, grip.y + grip.height / 2 + (percent === 72 ? 80 : 0), { steps: 24 });
      await page.mouse.up();
      await expect(divider(page)).toBeVisible();
      await expect.poll(async () => Number(await divider(page).getAttribute('aria-valuenow'))).toBeCloseTo(percent, 1);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(await state()).toEqual(original);
    }
    await divider(page).locator('.map-compare__grip').click();
    expect(await page.evaluate(() => (window as any).__dividerMapClicks)).toBe(0);
    await clickMapPoint(page, 15.9829, 45.80025);
    await expect(page.locator('#parcel-menu')).toBeVisible();
    await expect(page.locator('#parcel-menu')).toContainText('1235');
    await expect(beforeMap(page)).toHaveCount(0);
    expect(await dragging(page)).toBe(true);
  });

  test('a record that replaces an earlier version outlines that version on the before side', async ({ mockApi: page }) => {
    await openCity(page);
    const previousId = await page.evaluate(([parcelId, geometry]) => (window as any).proposalStorage.addProposal({
      title: 'Earlier version', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
      structureProposal: { kind: 'square', geometry }, applied: false
    }), [PARCEL_ID, PARCEL_GEOMETRY] as const);
    const currentId = await page.evaluate(([parcelId, geometry, previousId]) => (window as any).proposalStorage.addProposal({
      title: 'Newer version', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
      structureProposal: { kind: 'square', geometry }, sourceProposalId: previousId
    }), [PARCEL_ID, PARCEL_GEOMETRY, previousId] as const);
    await page.evaluate(id => (window as any).applyProposalToMap(id), currentId);
    await expect.poll(() => page.evaluate(id => (window as any).isApplied((window as any).getProposalByIdOrHash(id)), currentId)).toBe(true);

    await showProposal(page, currentId);
    await page.locator('#proposal-details-panel .btn-compare-proposal').click();
    await expect(beforeMap(page)).toBeVisible();
    const layers = await beforeLayers(page);
    expect(layers.previous).toBe(1);
    expect(layers.parcels).toBeGreaterThan(0);
  });

  test('one parcel of an applied readjustment is outlined before, and the plots it became after', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--reparcellization').click();
    const modal = page.locator('.on-map-reparcellization');
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    await modal.locator('[data-reparcel-commit]').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.reparcellization))).toBe(true);
    const id = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.reparcellization).proposalId);

    await showProposal(page, id);
    await openParcelsSection(page);
    const chip = page.locator('#proposal-details-panel .btn-compare-parcel').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    const parcelId = await chip.getAttribute('data-focus-parcel');
    expect(parcelId).toBe(PARCEL_ID);

    await chip.click();
    await expect(beforeMap(page)).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => (window as any).ProposalBeforeAfter.activeFocus())).toBe(parcelId);
    expect((await beforeLayers(page)).focus).toBe(1);
    // The plots that came out of the parcel, outlined on the live map in the modal's blue.
    await expect.poll(() => page.locator('#map .leaflet-overlay-pane path[stroke="#0369a1"]').count()).toBeGreaterThan(0);

    // The same chip again closes it and clears the outline.
    await chip.click();
    await expect(beforeMap(page)).toHaveCount(0);
    await expect(page.locator('#map .leaflet-overlay-pane path[stroke="#0369a1"]')).toHaveCount(0);
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  test('the cross-section editor opens the comparison from its own chip and closes it with the editor', async ({ mockApi: page }) => {
    await openCity(page);
    const roadId = await drawCorridor(page, 'road');
    await showProposal(page, roadId);
    const crossSection = page.locator('#proposal-details-panel .btn-cross-section');
    await expect(crossSection).toBeVisible();
    await crossSection.click();

    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor).toBeVisible();
    const chip = editor.locator('.corridor-editor-compare');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Before / after');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();
    await expect(beforeMap(page)).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(divider(page)).toHaveAttribute('role', 'slider');

    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
    await expect(beforeMap(page)).toHaveCount(0);
    await expect(divider(page)).toHaveCount(0);
  });
});

test.describe('Before / after on a phone @features', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('touch divider release and tap preserve comparison, and cancellation ends the drag', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    await page.evaluate(() => (window as any).toggleProposalDetailsPanelMinimized(true));
    const button = page.locator('#proposal-details-panel .btn-compare-proposal');
    await button.click();
    const cdp = await page.context().newCDPSession(page);
    const mapBox = (await page.locator('#map').boundingBox())!;
    const originalCenter = await page.evaluate(() => (window as any).map.getCenter());
    const grip = (await divider(page).locator('.map-compare__grip').boundingBox())!;
    const point = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2, radiusX: 1, radiusY: 1, force: 1, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: mapBox.x + mapBox.width * .75 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(divider(page)).toBeVisible();
    await expect.poll(async () => Number(await divider(page).getAttribute('aria-valuenow'))).toBeCloseTo(75, 1);
    await divider(page).locator('.map-compare__grip').tap();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => (window as any).map.getCenter())).toEqual(originalCenter);
    const next = (await divider(page).locator('.map-compare__grip').boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, x: next.x + next.width / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.mouse.move(mapBox.x + mapBox.width * .2, point.y);
    await expect.poll(async () => Number(await divider(page).getAttribute('aria-valuenow'))).toBeCloseTo(75, 1);
    // Cancellation must allow a fresh finger gesture, rather than leaving the controller active.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, x: next.x + next.width / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, x: mapBox.x + mapBox.width * .25 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => Number(await divider(page).getAttribute('aria-valuenow'))).toBeCloseTo(25, 1);
    const outside = await page.evaluate(() => {
      const w = window as any, p = w.map.latLngToContainerPoint([45.80025, 15.9829]);
      const box = w.map.getContainer().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y };
    });
    await page.touchscreen.tap(outside.x, outside.y);
    await expect(page.locator('#parcel-menu')).toBeVisible();
    await expect(page.locator('#parcel-menu')).toContainText('1235');
    await expect(beforeMap(page)).toHaveCount(0);
    expect(await dragging(page)).toBe(true);
    await cdp.detach();
  });

  test('the compact card offers the comparison and the divider stays inside the viewport', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    await page.evaluate(() => (window as any).toggleProposalDetailsPanelMinimized(true));
    const button = page.locator('#proposal-details-panel .btn-compare-proposal');
    await expect(button).toBeVisible();
    await button.click();
    await expect(beforeMap(page)).toBeVisible();
    const box = await divider(page).locator('.map-compare__grip').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    for (const side of ['before', 'after']) {
      const label = await divider(page).locator(`.map-compare__label--${side}`).boundingBox();
      expect(label).not.toBeNull();
      expect(label!.x).toBeGreaterThanOrEqual(0);
      expect(label!.x + label!.width).toBeLessThanOrEqual(390);
    }
    await button.click();
    await expect(beforeMap(page)).toHaveCount(0);
  });
});

test.describe('Before / after in the bet dialog @features', () => {
  test('the dialog puts the thumbnail and the same ground without the proposal under one divider', async ({ mockApi: page }) => {
    await page.route('**/markets?*', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(marketsPayload({ screenshotUrl: PIXEL_PNG, screenshotBeforeUrl: PIXEL_PNG })) }));
    await page.goto(`/?city=zg&bets=${PROPOSAL_ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    const compare = dialog.locator('.bets-dialog__compare');
    await expect(compare).toBeVisible();
    await expect(compare.locator('img')).toHaveCount(2);
    await expect(compare.locator('img.map-compare__before')).toHaveCount(1);
    const handle = compare.locator('.map-compare__handle');
    await expect(handle).toHaveAttribute('role', 'slider');
    await expect(handle).toHaveAttribute('aria-valuenow', '50');
    await expect(compare.locator('.map-compare__label--before')).toHaveText('Before');
    await expect(compare.locator('.map-compare__label--after')).toHaveText('After');

    await handle.focus();
    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '100');
    // Nothing clipped away any more: Chrome folds four equal sides into inset(0px).
    expect(await compare.locator('img.map-compare__before').evaluate(el => (el as HTMLElement).style.clipPath)).toMatch(/^inset\((0px|0(px)? 0px 0(px)? 0(px)?)\)$/);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.bets-dialog__compare, .map-compare__handle')).toHaveCount(0);
  });

  test('without a before picture the dialog keeps its plain thumbnail', async ({ mockApi: page }) => {
    await page.route('**/markets?*', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(marketsPayload({ screenshotUrl: PIXEL_PNG, screenshotBeforeUrl: null })) }));
    await page.goto(`/?city=zg&bets=${PROPOSAL_ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.bets-dialog__thumb')).toHaveCount(1);
    await expect(dialog.locator('.bets-dialog__compare')).toHaveCount(0);
  });
});
