// The before/after divider outside the parcel-layout editor (dividers.md): an applied proposal
// in the details panel (M2), the bet dialog's two pictures (M3), the cross-section editor's chip
// (M4), a replaced version's outline (M5) and one parcel of an applied parcel layout (M6). The
// editor's own divider is covered by parcel-layout-audit.spec.ts and designer-controls.spec.ts.
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, openParcel, createSpace, showProposal, drawCorridor, clickMapPoint, PARCEL_ID, PARCEL_GEOMETRY, showProposalTab, unfoldStack } from '../helpers/runtime';
import { pageIndex } from '../helpers/mocks/shared-server';
import { fileIndexedAgreement, MINTED_ACCOUNT as AGREEMENT_ACCOUNT, OPEN_POOL } from '../helpers/agreements';
// A 1×1 PNG stands in for a rendered picture; the dialog accepts data URLs like any other image.
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const beforeMap = (page: Page) => page.locator('#map .map-compare__before');
const divider = (page: Page) => page.locator('#map .map-compare__handle');
const dragging = (page: Page) => page.evaluate(() => (window as any).map.dragging.enabled());
const beforeLayers = async (page: Page) => JSON.parse((await beforeMap(page).getAttribute('data-layers')) || '{}');

// The full reader, with its parcels section open (the per-parcel chips live there).
async function openParcelsSection(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).toggleProposalDetailsPanelMinimized(false));
  await showProposalTab(page, 'details');
  const summary = page.locator('#proposal-details-panel details.proposal-detail-section summary').filter({ hasText: 'Land & ownership' });
  await expect(summary).toBeVisible();
  if (!(await summary.evaluate(el => (el.parentElement as HTMLDetailsElement).open))) await summary.click();
}

// A minted agreement with an open pool, as the page's index lists it (GET /markets), with its rendered
// pictures: the map with its designs (screenshotUrl) and the same ground without them
// (screenshotBeforeUrl). An untitled agreement is named by its designs' titles.
function fileBet(page: Page, pictures: { screenshotUrl: string | null; screenshotBeforeUrl: string | null },
  { title = 'Plan-led infill', designTitles = ['Infill park'] }: { title?: string | null; designTitles?: string[] } = {}): void {
  fileIndexedAgreement(pageIndex(page), { title, designTitles, minted: {}, pool: OPEN_POOL, row: pictures });
}

test.describe('Before / after on the main map @features', () => {
  test('an applied proposal compares the ground as it stands with the map it changed, from the details panel', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);

    const button = page.locator('#proposal-details-panel .btn-compare-proposal');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await unfoldStack(page);
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

    await unfoldStack(page);
    await button.click();
    await expect(beforeMap(page)).toHaveCount(0);
    await expect(divider(page)).toHaveCount(0);
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(await dragging(page)).toBe(true);

    // Unapplying ends the comparison and hides its action: there is no "after" any more.
    await unfoldStack(page);
    await button.click();
    await expect(beforeMap(page)).toBeVisible();
    await page.evaluate(id => (window as any).removeProposalFromMap(id), id);
    await expect(beforeMap(page)).toHaveCount(0);
    await expect(page.locator('#proposal-details-panel .btn-compare-proposal')).toBeHidden();
    expect(await dragging(page)).toBe(true);
  });

  test('divider release preserves comparison and normal parcel selection still works', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createSpace(page, 'park');
    await showProposal(page, id);
    // Keep both grip positions on exposed map, outside the expanded proposal panel (a card hosted
    // in the click stack has no − of its own; the stack's width is the panel's).
    const minimize = page.locator('#proposal-details-minimize');
    if (await minimize.isVisible()) await minimize.click();
    const button = page.locator('#proposal-details-panel .btn-compare-proposal');
    await unfoldStack(page);
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
    await expect(page.locator('#click-stack')).toBeVisible();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="parcels"]')).toContainText('1235');
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
      structureProposal: { kind: 'square', geometry },
      proposalOrigin: { relation: 'revision', source: { kind: 'local', localProposalId: previousId }, title: 'Earlier version' }
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

  test('one parcel of an applied parcel layout is outlined before, and the plots it became after', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--parcel-layout').click();
    const modal = page.locator('.on-map-reparcellization');
    await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
    await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
    await modal.locator('[data-reparcel-commit]').click();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((p: any) => p.applied && p.goal === 'parcel-layout'))).toBe(true);
    const id = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.goal === 'parcel-layout').proposalId);

    await showProposal(page, id);
    await openParcelsSection(page);
    const chip = page.locator('#proposal-details-panel .btn-compare-parcel').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    const parcelId = await chip.getAttribute('data-focus-parcel');
    expect(parcelId).toBe(PARCEL_ID);

    await unfoldStack(page);
    await chip.click();
    await expect(beforeMap(page)).toBeVisible();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => (window as any).ProposalBeforeAfter.activeFocus())).toBe(parcelId);
    expect((await beforeLayers(page)).focus).toBe(1);
    // The plots that came out of the parcel, outlined on the live map in the editor's blue.
    await expect.poll(() => page.locator('#map .leaflet-overlay-pane path[stroke="#0369a1"]').count()).toBeGreaterThan(0);

    // The same chip again closes it and clears the outline.
    await unfoldStack(page);
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
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    const chip = editor.locator('.corridor-editor-compare');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Before / after');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await unfoldStack(page);
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
    await unfoldStack(page);
    await button.click();
    const cdp = await page.context().newCDPSession(page);
    await expect(page.locator('#click-stack > .mobile-dock-sheet-handle')).toBeHidden();
    const mapBox = (await page.locator('#map').boundingBox())!;
    const originalCenter = await page.evaluate(() => (window as any).map.getCenter());
    const gripControl = divider(page).locator('.map-compare__grip');
    await expect.poll(() => gripControl.evaluate(el => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    const grip = (await gripControl.boundingBox())!;
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
      // Tap the exposed northern part of the neighbour, above the folded phone panel.
      const w = window as any, p = w.map.latLngToContainerPoint([45.80045, 15.9829]);
      const box = w.map.getContainer().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y };
    });
    await page.touchscreen.tap(outside.x, outside.y);
    await expect(page.locator('#click-stack')).toBeVisible();
    await expect(page.locator('#click-stack .click-stack__section[data-kind="parcels"]')).toContainText('1235');
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
    await unfoldStack(page);
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
    await unfoldStack(page);
    await button.click();
    await expect(beforeMap(page)).toHaveCount(0);
  });
});

test.describe('Before / after in the bet dialog @features', () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    test(`keeps the complete portrait image inside its comparison frame at ${viewport.width}px`, async ({ mockApi: page }) => {
      await page.setViewportSize(viewport);
      const portrait = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 512; canvas.height = 768;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#dddddd'; ctx.fillRect(0, 0, 512, 768);
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 512, 80);
        ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 688, 512, 80);
        return canvas.toDataURL();
      });
      fileBet(page, { screenshotUrl: portrait, screenshotBeforeUrl: portrait });
      await page.goto(`/bets/${AGREEMENT_ACCOUNT}?city=zg&reduceMotion=1`);
      const compare = page.locator('#proposalMarketOverlay .bets-dialog__compare');
      await expect(compare).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => compare.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalHeight === 768))).toBe(true);
      const sizes = await compare.locator('img').evaluateAll(images => images.map(image => {
        const box = image.getBoundingClientRect(); return { width: box.width, height: box.height };
      }));
      for (const size of sizes) expect(size.width / size.height).toBeCloseTo(512 / 768, 2);
      expect((await compare.boundingBox())!.width).toBeLessThanOrEqual(sizes[0].width + 2);
      await expect.poll(() => compare.getByRole('slider').evaluate(el => parseFloat((el as HTMLElement).style.left))).toBeCloseTo(sizes[0].width / 4, 0);
      // The phone sheet scrolls: inspect each end where it is exposed, above its fixed footer.
      const pixels = [];
      for (const end of ['start', 'end'] as const) {
        await compare.evaluate((el, block) => el.scrollIntoView({ block, behavior: 'instant' }), end);
        const png = await compare.screenshot();
        pixels.push(await page.evaluate(async ({ dataUrl, end }) => {
          const img = new Image(); img.src = dataUrl; await img.decode();
          const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
          return Array.from(ctx.getImageData(Math.floor(img.width / 2), end === 'start' ? 12 : img.height - 5, 1, 1).data).slice(0, 3);
        }, { dataUrl: `data:image/png;base64,${png.toString('base64')}`, end }));
      }
      expect(pixels).toEqual([[255, 0, 0], [0, 0, 255]]);
    });
  }

  test('the dialog puts the thumbnail and the same ground without the agreement under one divider', async ({ mockApi: page }) => {
    fileBet(page, { screenshotUrl: PIXEL_PNG, screenshotBeforeUrl: PIXEL_PNG });
    await page.goto(`/?city=zg&bets=${AGREEMENT_ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const compare = dialog.locator('.bets-dialog__compare');
    await expect(compare).toBeVisible();
    await expect(compare.locator('img')).toHaveCount(2);
    await expect(compare.locator('img.map-compare__before')).toHaveCount(1);
    const handle = compare.locator('.map-compare__handle');
    await expect(handle).toHaveAttribute('role', 'slider');
    await expect(handle).toHaveAttribute('aria-valuenow', '25');
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

  // An agreement of several designs is one bet: its pictures show all of them before and after, and
  // an untitled one is named by its designs (bets-model.js labelOf).
  test('a bet on an agreement of several designs uses its whole before and after image pair', async ({ mockApi: page }) => {
    fileBet(page, { screenshotUrl: PIXEL_PNG, screenshotBeforeUrl: PIXEL_PNG }, { title: null, designTitles: ['North park', 'South square'] });
    await page.goto(`/bets/${AGREEMENT_ACCOUNT}?city=zg&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator('.cb-dialog__title')).toHaveText('Will North park + South square execute on-chain?');
    const compare = dialog.locator('.bets-dialog__compare');
    await expect(compare.locator('img')).toHaveCount(2);
    // The two pictures cover the same frame, so the divider compares like with like.
    const sizes = await compare.locator('img').evaluateAll(images => images.map(image => image.getBoundingClientRect().height));
    expect(Math.abs(sizes[0] - sizes[1])).toBeLessThan(1);
    expect((await compare.boundingBox())!.height).toBeGreaterThanOrEqual(sizes[0]);
    const slider = compare.getByRole('slider');
    await expect(slider).toHaveAttribute('aria-valuenow', '25');
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
  });

  test('without a before picture the dialog keeps its plain thumbnail', async ({ mockApi: page }) => {
    fileBet(page, { screenshotUrl: PIXEL_PNG, screenshotBeforeUrl: null });
    await page.goto(`/?city=zg&bets=${AGREEMENT_ACCOUNT}&reduceMotion=1`);
    const dialog = page.locator('#proposalMarketOverlay');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator('.bets-dialog__thumb')).toHaveCount(1);
    await expect(dialog.locator('.bets-dialog__compare')).toHaveCount(0);
  });
});
