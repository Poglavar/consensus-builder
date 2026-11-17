import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace } from '../helpers/runtime';
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
    w.__updateEditor = w.OnMapEditor.open({ owner: 'update-edit-check', title: 'Edit site', content: '<p data-draft-geometry>Unsaved geometry</p>', onCancel() { w.__updateEditor.close(); } });
  });
  await page.locator('#app-update-notice [data-app-update-reload]').click();
  await expect(page.locator('#app-update-blocked')).toContainText('Finish or cancel editing: Edit site');
  await expect(page.locator('#update-edit-check-editor .on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#update-edit-check-editor [data-draft-geometry]')).toHaveText('Unsaved geometry');
  await expect(page.locator('.app-update-review')).toContainText('Edit site');
  await expect(page.getByRole('button', { name: 'Reload and keep drafts', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#update-edit-check-editor [data-draft-geometry]')).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`update review lists saved drafts and reload preserves them at ${width}px`, async ({ mockApi: page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await runningBuild(page);
    await page.route('**/release.json?*', route => route.fulfill({ json: manifest(13) }));
    await openCity(page);
    const id = await createSpace(page, 'park');
    const publishedAt = '2026-11-17T09:04:38.000Z';
    await page.evaluate(publishedAt => {
      const w: any = window;
      const content = w.PlanRecord.create('Dated plan', [w.Cid.cidOfObject({ fixture: 'design' })],
        { city: w.resolveCurrentCityCode(), at: '45.8,15.98,17', mode: '2d', language: 'en' });
      w.NamedPlans.remember({ cid: w.Cid.cidOfObject(content), content, publishedAt, published: true });
    }, publishedAt);
    await page.locator('#app-update-notice [data-app-update-reload]').click();
    const review = page.locator('.app-update-review');
    await expect(review).toContainText('publication is optional and public');
    await expect(review.locator('li')).toHaveCount(1);
    await page.getByRole('button', { name: 'Review Designs', exact: true }).click();
    await expect(page.locator('#proposals-sheet')).toBeVisible();
    await expect(page.locator(`#proposal-list-host [data-list-id="${id}"]`)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#app-update-notice [data-app-update-reload]').click();
    const reload = page.getByRole('button', { name: 'Reload and keep drafts', exact: true });
    await expect(reload).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('draft-review.png') });
    await reload.focus();
    await Promise.all([page.waitForEvent('domcontentloaded'), page.keyboard.press('Enter')]);
    await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage?.getProposal(id), id)).toBe(true);
    await expect(page.locator('.app-update-review')).toHaveCount(0);
    await page.evaluate(() => (window as any).ListsPanel.reviewDrafts('plans'));
    await page.locator('[data-list-filter="publication"]').selectOption('all');
    const stamp = page.locator('#plan-list-host time');
    await expect(stamp).toHaveAttribute('datetime', publishedAt);
    await expect(stamp).toContainText(':38');
    await page.screenshot({ path: testInfo.outputPath('plan-timestamp.png') });
  });
}
