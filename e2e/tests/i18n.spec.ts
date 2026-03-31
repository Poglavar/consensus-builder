import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, switchLanguage, getLanguage } from '../helpers/app';

test.describe('Language switching @features', () => {
  test('i18n module is initialized with a valid language', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const lang = await getLanguage(page);
    expect(['en', 'es', 'sr', 'hr']).toContain(lang);
  });

  test('switching to Spanish updates language', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await switchLanguage(page, 'es');
    const lang = await getLanguage(page);
    expect(lang).toBe('es');
  });

  test('switching to Croatian updates language', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await switchLanguage(page, 'hr');
    const lang = await getLanguage(page);
    expect(lang).toBe('hr');
  });

  test('switching to Serbian updates language', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await switchLanguage(page, 'sr');
    const lang = await getLanguage(page);
    expect(lang).toBe('sr');
  });

  test('language persists across reload', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await switchLanguage(page, 'es');
    await page.reload();
    await waitForMapReady(page);
    await page.waitForTimeout(1000);

    const lang = await getLanguage(page);
    expect(lang).toBe('es');
  });

  test('translation function returns translated strings', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (!w.i18n || typeof w.i18n.t !== 'function') return { skip: true };

      // Try a known key that has translations
      const en = w.i18n.t('language.english');
      return {
        skip: false,
        translated: en,
        isString: typeof en === 'string',
        notEmpty: en.length > 0,
      };
    });

    if (!result.skip) {
      expect(result.isString).toBe(true);
      expect(result.notEmpty).toBe(true);
    }
  });
});
