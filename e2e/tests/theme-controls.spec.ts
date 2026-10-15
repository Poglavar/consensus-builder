// Verify appearance buttons change the rendered UI, persist an explicit preference, and follow
// operating-system changes only in System mode.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

test('appearance choices repaint the sheets, survive reload, and System follows the OS @features', async ({ mockApi: page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openCity(page);
  await page.locator('#settings-button').click();
  const background = () => page.locator('#settings-sheet').evaluate(node => getComputedStyle(node).backgroundColor);
  await page.locator('#theme-choice-light').click();
  const light = await background();
  await expect(page.locator('#theme-choice-light')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#theme-choice-dark').click();
  await expect.poll(background).not.toBe(light);
  const dark = await background();
  expect(await page.evaluate(() => localStorage.getItem('cb.theme'))).toBe('dark');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#settings-button').click();
  await expect(page.locator('#theme-choice-dark')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(background).toBe(dark);
  await page.locator('#theme-choice-system').click();
  await expect.poll(background).toBe(light);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(background).toBe(dark);
  await page.locator('#theme-choice-light').click();
  await expect.poll(background).toBe(light);
  await expect(page.locator('#theme-choice-system')).toHaveAttribute('aria-pressed', 'false');
});
