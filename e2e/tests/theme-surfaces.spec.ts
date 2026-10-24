// Check the real account/Actors dialogs and the CSS cascade of every floating surface family.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

for (const width of [1280, 390]) {
  test(`panels share theme glass at ${width}px`, async ({ mockApi: page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openCity(page);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => (window as any).CbTheme.set(value), theme);
      const failures = await page.evaluate(() => {
        const host = document.createElement('div');
        host.style.visibility = 'hidden';
        document.querySelector('#map-container')!.append(host);
        const surfaces = [
          ['cb-dialog', ''], ['click-stack__card', ''], ['info-panel', ''], ['info-panel road-analysis-modal', ''],
          ['map-sheet', ''], ['map-sheet map-sheet--dock', ''], ['proposal-editor-shell', ''],
          ['on-map-editor__panel', ''], ['site-panel', ''], ['info-panel', 'site-info-panel'],
          ['urban-block-panel', ''], ['planning-inspector', ''], ['parcel-estimate-panel', ''],
          ['share-plan-panel-content', ''], ['grain-score-panel', ''], ['command-palette', ''],
          ['on-map-editor__tools reparcel-tools-map', ''], ['ai-scene-follow-card', ''],
          ['memory-monitor-panel', ''],
        ];
        const reference = document.createElement('div');
        reference.style.background = 'var(--cb-glass-sheet)';
        host.append(reference);
        const expected = getComputedStyle(reference).backgroundColor;
        const blur = `blur(${getComputedStyle(document.documentElement).getPropertyValue('--cb-panel-blur').trim()})`;
        const failures: string[] = [];
        const sectionWrapper = document.createElement('div');
        sectionWrapper.className = 'click-stack__section';
        host.append(sectionWrapper);
        if (getComputedStyle(sectionWrapper).backgroundColor !== 'rgba(0, 0, 0, 0)') {
          failures.push('click-stack__section wrapper: ' + getComputedStyle(sectionWrapper).backgroundColor);
        }
        for (const [className, id] of surfaces) {
          const element = document.createElement('div');
          element.className = className;
          element.id = id;
          host.append(element);
          const style = getComputedStyle(element);
          if (style.backgroundColor !== expected || style.backdropFilter !== blur) {
            failures.push(`${className}: ${style.backgroundColor}, ${style.backdropFilter}`);
          }
        }
        // Use the actual details element: phone-specific ID rules used to make it opaque.
        const details = document.querySelector('#proposal-details-panel')!;
        const style = getComputedStyle(details);
        if (style.backgroundColor !== expected) failures.push(`proposal details: ${style.backgroundColor}`);
        host.remove();
        return failures;
      });
      expect(failures).toEqual([]);
    }
  });
}

test('account and Actors dialogs expose the shared glass without opaque inner sections', async ({ mockApi: page }) => {
  await openCity(page);
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Theme reviewer');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await page.locator('#username-display').click();
  const account = page.locator('.agent-dialog-modal');
  await expect(account).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => (window as any).CbTheme.set(value), theme);
    await expect(account).toHaveCSS('background-color', theme === 'light' ? 'rgba(255, 255, 255, 0.8)' : 'rgba(23, 28, 34, 0.8)');
  }
  await account.locator('.agent-dialog-modal-close').click();
  await page.locator('#activity-button').click();
  await page.locator('#activity-actors-tab').click();
  const actors = page.locator('#activity-sheet');
  await expect(actors.locator('[data-activity-actors]')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => (window as any).CbTheme.set(value), theme);
    await expect(actors).toHaveCSS('background-color', theme === 'light' ? 'rgba(255, 255, 255, 0.8)' : 'rgba(23, 28, 34, 0.8)');
    for (const selector of ['.ae-profiles', '.ae-activity', '.ae-run-detail']) {
      await expect(actors.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
  }
});
