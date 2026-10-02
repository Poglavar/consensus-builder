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
