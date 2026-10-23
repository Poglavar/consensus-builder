import { test, expect } from '../helpers/fixtures';
import { applyLayout } from '../helpers/agreements';
import { openCity, createSpace, openParcel, stubBasemapTiles, showProposal } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

test('the rooster touches each inspected parcel with its beak and highlights only that parcel', async ({ mockApi: page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { layoutId } = await applyLayout(page);
  await showProposal(page, layoutId);
  await page.evaluate(() => {
    const w = window as any;
    const original = Element.prototype.animate;
    w.__pecks = 0;
    Element.prototype.animate = function(frames: any, options: any) {
      const animation = original.call(this, frames, options);
      if (this.matches('.grain-rooster__body') && frames[1]?.transform?.includes('rotate(-35deg)')) {
        animation.pause();
        animation.currentTime = options.duration * frames[1].offset;
        w.__pecks++;
        let release: any;
        const finished = new Promise(resolve => { release = resolve; });
        w.__releasePeck = () => { animation.cancel(); release(); };
        return { finished, cancel: () => animation.cancel() } as any;
      }
      return animation;
    };
  });
  await page.locator('#proposals-button').click();
  await page.locator('#roosterScoreButton').click();
  for (let index = 1; index <= 2; index++) {
    await expect.poll(() => page.evaluate(() => (window as any).__pecks)).toBe(index);
    const sample = await page.evaluate(() => {
      const w = window as any;
      const active = document.querySelector('.grain-score-parcel.is-active') as SVGPathElement;
      const beak = document.querySelector('[data-grain-role="beak"]') as SVGPathElement;
      const contact = new DOMPoint(28, 79).matrixTransform(beak.getScreenCTM()!);
      const inParcelFrame = contact.matrixTransform(active.getScreenCTM()!.inverse());
      return {
        active: document.querySelectorAll('.grain-score-parcel.is-active').length,
        inside: active.isPointInFill(inParcelFrame),
        otherHighlights: [...document.querySelectorAll('.grain-score-parcel:not(.is-active)')].filter(el => Number(getComputedStyle(el).opacity) > 0).length,
        selectedProposal: w.currentlyHighlightedProposalId,
      };
    });
    expect(sample).toEqual({ active: 1, inside: true, otherHighlights: 0, selectedProposal: null });
    await page.evaluate(() => (window as any).__releasePeck());
  }
  await expect(page.locator('#grain-score-panel [data-grain-role="result"]')).toBeVisible({ timeout: 15_000 });
});

test('Share design focus and checkbox inclusion are independent, with centered mode controls', async ({ mockApi: page }) => {
  await openCity(page);
  await createSpace(page, 'park');
  const second = sampleParcels.features[1].properties.parcelId;
  await page.evaluate(async id => { await (window as any).CadastralParcelRepository.ensureIds([id]); }, second);
  await openParcel(page, 'proposals', second);
  await page.locator('.parcel-build-btn--square').click();
  await page.locator('#proposals-button').click();
  await page.locator('#shareAppliedProposalsButton').click();
  const panel = page.locator('.share-plan-panel');
  await expect(panel.locator('.share-plan-row')).toHaveCount(2);
  const first = panel.locator('.share-plan-row').first();
  const secondRow = panel.locator('.share-plan-row').nth(1);
  const originalCenter = await page.evaluate(() => (window as any).map.getCenter());
  await first.locator('input').uncheck();
  expect(await page.evaluate(() => (window as any).map.getCenter())).toEqual(originalCenter);
  await first.locator('.share-plan-row__main').click();
  await expect(first).toHaveClass(/is-picked/);
  await expect(first.locator('input')).not.toBeChecked();
  const focused = await page.evaluate(() => ({ center: (window as any).map.getCenter(), zoom: (window as any).map.getZoom() }));
  await secondRow.locator('input').uncheck();
  expect(await page.evaluate(() => ({ center: (window as any).map.getCenter(), zoom: (window as any).map.getZoom() }))).toEqual(focused);
  await expect(first).toHaveClass(/is-picked/);
  await expect(secondRow).not.toHaveClass(/is-picked/);
  await first.locator('input').check();
  await expect(first).toHaveClass(/is-picked/);
  const filter = await panel.locator('.share-plan-filter').boundingBox();
  const buttons = await panel.locator('.share-plan-mode-switch').boundingBox();
  expect(buttons!.x + buttons!.width / 2).toBeCloseTo(filter!.x + filter!.width / 2, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await secondRow.locator('.share-plan-row__main').click();
  await expect(secondRow.locator('.share-plan-row__main')).toHaveAttribute('aria-pressed', 'true');
  await expect(first.locator('.share-plan-row__main')).toHaveAttribute('aria-pressed', 'false');
  await expect(secondRow.locator('input')).not.toBeChecked();
  expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(844 / 2 + 1);
  const focusVisible = await page.evaluate(() => {
    const w = window as any;
    const proposal = w.proposalStorage.getAllProposals().find((p: any) => p.structureProposal?.kind === 'square');
    const center = w.resolveStandaloneProposalFocusBounds(proposal).getCenter();
    const point = w.map.latLngToContainerPoint(center);
    return point.y < document.querySelector('.share-plan-panel')!.getBoundingClientRect().top;
  });
  expect(focusVisible).toBe(true);
  const mobileFilter = await panel.locator('.share-plan-filter').boundingBox();
  const mobileButtons = await panel.locator('.share-plan-mode-switch').boundingBox();
  expect(mobileButtons!.x + mobileButtons!.width / 2).toBeCloseTo(mobileFilter!.x + mobileFilter!.width / 2, 0);
});
