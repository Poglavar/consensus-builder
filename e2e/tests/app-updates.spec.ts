import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
const manifest = (number: number) => ({ version: 1, component: 'urbangametheory-frontend', buildId: `deploy-${number}`,
  buildNumber: number, generatedAt: '2026-10-27T12:00:00Z' });
async function runningBuild(page: import('@playwright/test').Page, number = 12) {
  await page.addInitScript(value => { (window as any).__BUILD_INFO = value; }, manifest(number));
}
async function openUpdateSettings(page: import('@playwright/test').Page) {
  await page.locator('#settings-button').click();
  await page.locator('#app-running-build').scrollIntoViewIfNeeded();
}

test('manual check spins, announces a new build, supports Later, and reloads only on request', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await runningBuild(page);
  let latest = 12, releaseResponse: (() => void) | null = null, hold = false;
  await page.route('**/release.json?*', async route => {
    if (hold) await new Promise<void>(resolve => { releaseResponse = resolve; });
    await route.fulfill({ json: manifest(latest) });
  });
  await openCity(page); await openUpdateSettings(page);
  await expect(page.locator('#app-running-build')).toHaveText('Build 12');
  await expect(page.locator('#app-update-state')).toHaveText('You are up to date.');
  latest = 13; hold = true;
  const check = page.locator('#app-update-check'); await check.click();
  await expect(check).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#app-update-state')).toHaveText('Checking for updates…');
  await expect.poll(() => !!releaseResponse).toBe(true);
  hold = false; releaseResponse!();
  await expect(check).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#app-update-state')).toHaveText('Build 13 is available.');
  await expect(page.locator('#app-update-notice')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('settings-update.png') });
  await page.keyboard.press('Escape');
  await page.locator('#app-update-later').click();
  await expect(page.locator('#app-update-notice')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.evaluate(() => (window as any).AppUpdates.check());
  await expect(page.locator('#app-update-notice')).toBeHidden();
  latest = 14; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#app-update-notice')).toBeVisible();
  await expect(page.locator('#app-running-build')).toHaveText('Build 12');
  await runningBuild(page, 14);
  await openUpdateSettings(page);
  await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('#settings-sheet [data-app-update-reload]').click()]);
  await expect(page.locator('#app-running-build')).toHaveText('Build 14');
  await expect(page.locator('#app-update-notice')).toBeHidden();
});

test('phone notification stays readable and a failed check preserves the known update', async ({ mockApi: page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await runningBuild(page);
  let fail = false;
  await page.route('**/release.json?*', route => fail ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: manifest(13) }));
  await openCity(page);
  const notice = page.locator('#app-update-notice'); await expect(notice).toBeVisible();
  const box = await notice.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('phone-notice.png') });
  await openUpdateSettings(page); fail = true; await page.locator('#app-update-check').click();
  await expect(page.locator('#app-update-state')).toHaveText('Could not check for updates. Try again.');
  await expect(page.locator('#app-update-check')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#app-running-build')).toHaveText('Build 12');
  await expect(page.locator('#settings-sheet [data-app-update-reload]')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('phone-settings.png') });
});

test('Reload leaves an active map editor intact', async ({ mockApi: page }) => {
  await runningBuild(page);
  await page.route('**/release.json?*', route => route.fulfill({ json: manifest(13) }));
  await openCity(page);
  await expect(page.locator('#app-update-notice')).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__updateEditor = w.OnMapEditor.open({ owner: 'update-edit-check', title: 'Edit site', content: '<input value="Unsaved geometry">', onCancel() { w.__updateEditor.close(); } });
  });
  await page.locator('#app-update-notice [data-app-update-reload]').click();
  await expect(page.locator('#app-update-blocked')).toContainText('Finish or cancel editing');
  await expect(page.locator('#update-edit-check-editor .on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#update-edit-check-editor input')).toHaveValue('Unsaved geometry');
});
