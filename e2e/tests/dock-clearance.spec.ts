// Real shell/stack CSS and collision controller, without loading the map renderer or source APIs.
import { test, expect } from '@playwright/test';
import path from 'node:path';
const frontend = path.resolve(__dirname, '../../frontend');

for (const id of ['click-stack', 'three-click-stack']) {
  test(`${id} leaves navigation stationary and uses only necessary bottom clearance`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.setContent(`<!doctype html><html><body><main id="map-container" style="position:relative;height:100dvh">
      <div id="map-shell-bottom-right" class="map-shell-cluster map-shell-cluster--bottom-right">
        ${['Lists', 'Activity', 'Bets'].map(label => `<button class="map-shell-button map-shell-button--labelled">${label}</button>`).join('')}
      </div>
      <div id="map-feedback-stack" class="map-feedback-stack"><div id="floating-status" class="floating-status cb-toast cb-toast--status"><span id="floating-status-text">Ready to inspect the selected parcel</span></div></div>
      <section id="parcel-info-panel" hidden></section>
      <div id="${id}" class="click-stack right-dock-panel visible" hidden><div class="click-stack__sections"><section class="click-stack__section is-expanded"><div class="click-stack__card"><h2 class="click-stack__heading"><button class="click-stack__row">Parcel</button></h2><div class="click-stack__body"><p>${'Parcel properties<br>'.repeat(120)}</p></div></div></section></div></div>
    </main></body></html>`);
    for (const file of ['tokens', 'primitives', 'base', 'map', 'panels', 'utilities', 'map-shell']) {
      await page.addStyleTag({ path: path.join(frontend, `css/${file}.css`) });
    }
    await page.addScriptTag({ path: path.join(frontend, 'js/ui/dock-clearance.js') });
    const bar = page.locator('#map-shell-bottom-right'), message = page.locator('#floating-status'), stack = page.locator(`#${id}`);
    const before = { bar: await bar.boundingBox(), message: await message.boundingBox() };
    // A hosted parcel used to trigger viewport recentering when it opened.
    await page.locator('#parcel-info-panel').evaluate(el => el.classList.add('visible', 'is-hosted'));
    await stack.evaluate(el => { (el as HTMLElement).hidden = false; });
    expect(await bar.boundingBox()).toEqual(before.bar); expect(await message.boundingBox()).toEqual(before.message);
    await expect.poll(async () => (await stack.boundingBox())!.y + (await stack.boundingBox())!.height).toBeCloseTo(890, 0);
    await page.screenshot({ path: testInfo.outputPath('wide-desktop.png') });

    await page.setViewportSize({ width: 1000, height: 900 });
    const messageGap = async () => {
      const box = (await stack.boundingBox())!, obstacle = (await message.boundingBox())!;
      return obstacle.y - (box.y + box.height);
    };
    await expect.poll(messageGap).toBeGreaterThanOrEqual(8);
    await expect.poll(messageGap).toBeLessThan(9);
    const centered = await bar.boundingBox(); expect(centered!.x + centered!.width / 2).toBeCloseTo(500, 0);
    await page.screenshot({ path: testInfo.outputPath('narrow-desktop.png') });

    // The app can finish updating the map's height after the window resize event.
    await page.locator('#map-container').evaluate(el => { (el as HTMLElement).style.height = '820px'; });
    await expect.poll(messageGap).toBeGreaterThanOrEqual(8);
    await expect.poll(messageGap).toBeLessThan(9);
    await page.locator('#map-container').evaluate(el => { (el as HTMLElement).style.height = '100dvh'; });
    await expect.poll(messageGap).toBeGreaterThanOrEqual(8);
    await expect.poll(messageGap).toBeLessThan(9);

    // Text changes also reflow clearance without moving either control's horizontal anchor.
    await page.locator('#floating-status-text').evaluate(el => { el.textContent = ''; });
    const navigationGap = async () => {
      const box = (await stack.boundingBox())!, obstacle = (await bar.boundingBox())!;
      return obstacle.y - (box.y + box.height);
    };
    await expect.poll(navigationGap).toBeGreaterThanOrEqual(8);
    await expect.poll(navigationGap).toBeLessThan(9);
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect.poll(async () => (await stack.boundingBox())!.y + (await stack.boundingBox())!.height).toBeCloseTo(890, 0);
    await stack.evaluate(el => { (el as HTMLElement).hidden = true; });
    await page.locator('#parcel-info-panel').evaluate(el => el.classList.remove('visible'));
    expect(await bar.boundingBox()).toEqual(before.bar);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--right-dock-clearance'))).toBe('');
  });
}
