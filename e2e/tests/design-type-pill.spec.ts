// Real click-stack modules and theme styles keep the inspected design type visible and unambiguous.
import { test, expect } from '@playwright/test';
import path from 'node:path';
const frontend = path.resolve(__dirname, '../../frontend');
for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`design type and selector at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<!doctype html><html data-theme="${theme}"><body class="three-mode-active"><main id="map-container"></main></body></html>`);
    for (const file of ['tokens', 'primitives', 'base', 'map', 'panels', 'map-shell', 'three-click-stack', 'mobile-sheets']) {
      await page.addStyleTag({ path: path.join(frontend, `css/${file}.css`) });
    }
    for (const file of ['proposals/design-goals', 'click-stack/click-stack-model', 'click-stack/click-stack-relations', 'three-click-stack']) {
      await page.addScriptTag({ path: path.join(frontend, `js/${file}.js`) });
    }
    await page.evaluate(() => {
      const w = window as any;
      w.getProposalGoalBadge = (goal: string) => ({ text: { park: '🌳', 'urban-rule': '📜📐', 'road-track': '🛣️' }[goal] });
      const designs = [
        { id: 'park', label: 'River garden', proposal: { goal: 'park' } },
        { id: 'rule', label: 'Courtyard heights', proposal: { goal: 'urban-rule' } },
        { id: 'road', label: 'Main street', proposal: { goal: 'road-track' } }
      ];
      w.ThreeClickStack.show({ designs }, { focus: 'designs', container: document.getElementById('map-container') }, {
        activate(_kind: string, item: any, body: HTMLElement) {
          const title = document.createElement('h3'); title.textContent = item.label; body.append(title);
        }
      });
    });
    const panel = page.locator('#three-click-stack'), row = panel.locator('.click-stack__row');
    const badge = row.locator('.proposal-type-badge');
    await expect(row).toContainText('Design (3)');
    await expect(badge).toHaveText('🌳Park');
    await expect(badge).toBeInViewport();
    const select = panel.getByLabel('Design to inspect', { exact: true });
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['Park · River garden', 'Urban rule · Courtyard heights', 'Road or track · Main street']);
    await expect(panel).toContainText('These designs overlap here or use this parcel.');
    const parkStyle = await badge.evaluate(el => ({ color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor }));
    expect(parkStyle.color).not.toBe(parkStyle.bg);
    await select.selectOption('rule');
    await expect(badge).toHaveAttribute('data-design-goal', 'urban-rule');
    await expect(badge).toHaveText('📜📐Urban rule');
    expect(await badge.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(parkStyle.bg);
    await row.click();
    await expect(badge).toBeVisible();
    await expect(select).toHaveCount(0);
    const bounds = await row.boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  });
}
