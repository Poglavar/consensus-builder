// New dictionaries stay on demand; Arabic controls work in RTL on phones and restore LTR on a switch.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';

const locales = [
  { lang: 'ar', locale: 'ar-EG', direction: 'rtl', label: 'القوائم' },
  { lang: 'fr', locale: 'fr-FR', direction: 'ltr', label: 'Listes' },
  { lang: 'pt', locale: 'pt-PT', direction: 'ltr', label: 'Listas' },
];
// Every locale the picker offers (js/i18n.js LOCALE_CHOICES), in picker order.
const pickerLocales = ['en-GB', 'en-US', 'es-ES', 'es-CO', 'sr-Latn-RS', 'hr-HR', 'ar-EG', 'fr-FR', 'pt-PT'];
for (const item of locales) {
  test(`${item.lang}: map renders translated controls and downloads only its selected dictionary`, async ({ mockApi: page }) => {
    const dictionaries: string[] = [];
    page.on('request', request => {
      const match = new URL(request.url()).pathname.match(/\/i18n\/([a-z]+)\.json$/);
      if (match) dictionaries.push(match[1]);
    });
    await page.goto(`/?city=new_york&lang=${item.lang}&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('lang', item.lang);
    await expect(page.locator('html')).toHaveAttribute('dir', item.direction);
    await expect(page.locator('#proposals-button .map-shell-button-label')).toHaveText(item.label);
    expect(dictionaries.sort()).toEqual(['en', item.lang].sort());
    expect(await page.evaluate(() => (window as any).i18n.getLocale())).toBe(item.locale);
    if (item.lang === 'ar') {
      const positions = await page.evaluate(async () => {
        const win = window as any;
        const point = () => { const p = win.map.latLngToContainerPoint([40.713, -74.006]); return [p.x, p.y]; };
        const before = point();
        win.i18n.setLanguage('fr');
        await win.i18n.loadLanguage('fr');
        return { before, after: point() };
      });
      expect(positions.after).toEqual(positions.before);
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    }
  });
}

test('English startup does not download Arabic, French or Portuguese', async ({ mockApi: page }) => {
  const dictionaries: string[] = [];
  page.on('request', request => {
    const match = new URL(request.url()).pathname.match(/\/i18n\/([a-z]+)\.json$/);
    if (match) dictionaries.push(match[1]);
  });
  await page.goto('/?city=new_york&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#proposals-button .map-shell-button-label')).toHaveText('Lists');
  await page.evaluate(() => (window as any).i18n.translationsReady);
  expect(dictionaries).toEqual(['en']);
});

test('Arabic feedback is readable on a phone, preserves URL direction and switches back to French', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/feedback.html?lang=ar');
  const arrow = page.locator('.cb-back-link > svg.cb-back-link__icon');
  await expect(arrow).toBeVisible();
  expect(await arrow.evaluate(el => getComputedStyle(el).transform)).toBe('matrix(-1, 0, 0, 1, 0, 0)');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.evaluate(() => (window as any).i18n.translationsReady);
  const input = page.locator('#feedback-page-url');
  await input.fill('https://example.test/?city=new_york');
  expect(await input.evaluate(element => getComputedStyle(element).direction)).toBe('ltr');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('#feedback-language option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(pickerLocales);
  await selectNativeOption(page.locator('#feedback-language'), 'fr-FR');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('#feedback-submit')).toHaveText('Envoyer le signalement');
  await expect(arrow).toBeVisible();
  expect(await arrow.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  await expect(input).toHaveValue('https://example.test/?city=new_york');
});

test('all locale buttons fit in a phone dialog and Arabic selection completes', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?city=new_york&lang=en&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const win = window as any;
    await win.i18n.translationsReady;
    const body = document.createElement('div');
    body.innerHTML = win.renderLanguagePickerHtml('test-locale-picker');
    win.CbDialog.open({ title: 'Language', body });
    win.bindLanguageSegmented(body);
  });
  const picker = page.locator('.test-locale-picker');
  expect(await picker.locator('[data-language]').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-language')))).toEqual(pickerLocales);
  expect(await picker.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await picker.locator('[data-language="ar-EG"]').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#proposals-button .map-shell-button-label')).toHaveText('القوائم');
  await expect(picker.locator('[aria-busy="true"]')).toHaveCount(0);
});

test('Arabic report keeps its first column at the reading edge on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/parcel-coverage-report.html?lang=ar');
  await expect(page.locator('#report-content')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const positions = await page.locator('.city-table-wrap').evaluate(element => {
    const cell = element.querySelector('th')!;
    const before = cell.getBoundingClientRect().right;
    element.scrollLeft = -300;
    return { before, after: cell.getBoundingClientRect().right, inset: getComputedStyle(cell).insetInlineStart };
  });
  expect(positions.inset).toBe('0px');
  expect(Math.abs(positions.before - positions.after)).toBeLessThanOrEqual(1);
});
