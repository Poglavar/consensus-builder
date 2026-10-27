import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';

for (const width of [1600, 1000, 390]) {
  test(`right screen panels share the stack width and stay within the viewport at ${width}px`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openCity(page);
    await openParcel(page);
    const stack = page.locator('#click-stack');
    await expect(stack).toBeVisible();
    const reference = await stack.boundingBox();
    if (!reference) throw new Error('Stack did not open');
    if (width >= 768) expect(reference.width).toBe(400);
    const surface = await stack.locator('.click-stack__card').first().evaluate(el => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, radius: css.borderRadius };
    });
    await page.keyboard.press('Escape');
    const barBefore = await page.locator('#map-shell-bottom-right').boundingBox();
    for (const name of ['layers', 'settings', 'proposals']) {
      const panel = page.locator(`#${name}-sheet`);
      await page.locator(`#${name}-button`).click();
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      if (!box) throw new Error(`${name} did not open`);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      if (width >= 768) {
        expect(box.width).toBe(reference.width);
        expect(box.x).toBe(reference.x);
        expect(box.y).toBe(reference.y);
        expect(await panel.evaluate(el => {
          const css = getComputedStyle(el);
          return { background: css.backgroundColor, radius: css.borderRadius };
        })).toEqual(surface);
        const title = await panel.locator('.map-sheet-title').boundingBox();
        expect(title!.x - box.x).toBeCloseTo(13, 0);
      }
      const firstSection = panel.locator('details > summary').first();
      if (await firstSection.count()) await firstSection.click();
      expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    }
    expect(await page.locator('#map-shell-bottom-right').boundingBox()).toEqual(barBefore);
    // Wider navigation views remain centred rather than expanding the right column.
    if (width >= 768) {
      await page.locator('#bets-button').click();
      const bets = await page.locator('#bets-sheet').boundingBox();
      if (!bets) throw new Error('Bets did not open');
      expect(bets.width).toBe(560);
      expect(bets.x + bets.width / 2).toBeCloseTo(width / 2, 0);
    }
  });
}

test('map geometry editor uses the same right panel frame and keeps its actions reachable', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCity(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__rightPanelSession = w.OnMapEditor.open({ owner: 'panel-layout-check', title: 'Edit site', content: '<label>Name <input value="Site"></label>',
      footer: '<button type="button" class="btn btn-primary">Done</button>', onCancel() { w.__rightPanelSession.close(); } });
  });
  const panel = page.locator('#panel-layout-check-editor .on-map-editor__panel');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBe(400);
  expect(box!.x + box!.width).toBe(1270);
  await expect(panel.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('editor.png') });
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel).toHaveCount(0);
});

test('design draft editor shares the column without horizontal overflow', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCity(page);
  await page.evaluate(() => (window as any).createNewProposalDraft({ name: 'Site terms' }));
  const panel = page.locator('#proposal-editor-shell');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBe(400);
  expect(box!.x + box!.width).toBe(1270);
  expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(panel.locator('[data-editor-action="close"]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('draft-editor.png') });
  await panel.locator('[data-editor-action="close"]').click();
  await expect(panel).toBeHidden();
});
