import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

for (const control of ['inactive', 'ai'] as const) {
  test(`profile personalization persists its avatar and logout hands the actor to ${control}`, async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#username-display').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#welcome-modal')).toBeVisible();
    await page.locator('#selected-avatar').click();
    const avatar = page.locator('.avatar-option:not(.used)').first();
    const avatarSrc = await avatar.locator('img').getAttribute('src');
    await avatar.click();
    await page.locator('#username-input').fill(`Test ${control} actor`);
    await page.locator('#welcome-submit-btn').click();
    await expect(page.locator('#username-text')).toHaveText(`Test ${control} actor`);
    await expect(page.locator('#username-display img')).toHaveAttribute('src', avatarSrc!);
    const actorId = await page.evaluate(() => (window as any).getCurrentUserAgent().id);
    await page.reload();
    await expect(page.locator('#username-text')).toHaveText(`Test ${control} actor`);
    await page.locator('#username-display').click();
    const dialog = page.locator('.agent-dialog-modal');
    await expect(dialog).toBeVisible();
    await dialog.locator('.logout-button').click();
    await page.locator('#logout-cancel-btn').click();
    await expect(page.locator('#username-text')).toHaveText(`Test ${control} actor`);
    await dialog.locator('.logout-button').click();
    await page.locator(`#logout-${control}-btn`).click();
    await expect(page.locator('#username-text')).not.toHaveText(`Test ${control} actor`);
    await expect.poll(() => page.evaluate((id) => {
      const agent = (window as any).agentStorage.getAgent(id);
      return { userControlled: agent.userControlled, aiControlled: agent.aiControlled, controller: agent.controller };
    }, actorId)).toEqual({ userControlled: false, aiControlled: control === 'ai', controller: control === 'ai' ? 'algorithm' : 'inactive' });
  });
}

test('welcome links navigate and its language picker changes the active language', async ({ mockApi: page }) => {
  await openCity(page);
  await page.locator('#username-display').click();
  const welcome = page.locator('#welcome-modal');
  await expect(welcome).toBeVisible();

  const languagePicker = welcome.locator('.welcome-language-picker');
  const toggle = languagePicker.locator('[data-language-toggle]');
  for (const language of ['es', 'sr', 'hr', 'en']) {
    await toggle.click();
    const option = languagePicker.locator(`[data-language="${language}"]`);
    await option.click();
    await expect.poll(() => page.evaluate(() => (window as any).i18n.getLanguage())).toBe(language);
    await expect(option).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }

  await welcome.locator('a[href="/hackathon-demo.html"]').click();
  await expect(page).toHaveURL(/\/hackathon-demo\.html$/);
});

test('the profile wallet button opens the connector modal and its close button returns to the profile', async ({ mockApi: page }) => {
  await openCity(page);
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Wallet test actor');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#username-text')).toHaveText('Wallet test actor');

  await page.locator('#username-display').click();
  const profile = page.locator('.agent-dialog-modal');
  await expect(profile).toBeVisible();
  await profile.locator('.wallet-connect-button').click();
  const wallet = page.locator('.wallet-modal-overlay');
  await expect(wallet).toBeVisible();
  await wallet.locator('[data-wallet-modal-close]').click();
  await expect(wallet).toHaveCount(0);
  await expect(profile).toBeVisible();
  await profile.locator('.agent-dialog-modal-close').click();
  await expect(profile).toHaveCount(0);
});
