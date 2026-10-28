// Satellite pages use the same selected-language dictionaries and never download unused locales.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';

for (const example of [
  { page: 'feedback', lang: 'es', selector: '#feedback-language', heading: 'Comentarios e informes de errores' },
  { page: 'mcp-privacy', lang: 'sr', selector: '#privacy-language', heading: 'Pravila privatnosti MCP-a' },
  { page: 'parcel-coverage-report', lang: 'hr', selector: '#report-language', heading: 'Gdje možemo pronaći registre katastarskih čestica?' },
]) {
  test(`${example.page} downloads only English and ${example.lang}`, async ({ page }) => {
    const requested: string[] = [];
    page.on('request', request => {
      const match = new URL(request.url()).pathname.match(/\/i18n\/([a-z]+)\.json$/);
      if (match) requested.push(match[1]);
    });
    await page.goto(`/${example.page}.html?lang=${example.lang}`);
    const heading = page.locator(example.page === 'parcel-coverage-report' ? '#report-title' : 'h1');
    await expect(heading).toHaveText(example.heading);
    expect(requested.sort()).toEqual(['en', example.lang].sort());
    await selectNativeOption(page.locator(example.selector), example.page === 'parcel-coverage-report' ? 'en' : 'en-US');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(requested).toHaveLength(2);
  });
}

test('language picker stays busy until the newly selected dictionary loads', async ({ mockApi: page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/i18n/es.json*', async route => { await held; await route.continue(); });
  await page.goto('/?city=new_york&lang=en&reduceMotion=1');
  await page.evaluate(async () => {
    const win = window as any;
    await win.i18n.translationsReady;
    const host = document.createElement('div');
    host.innerHTML = win.renderLanguagePickerHtml();
    document.body.append(host);
    win.bindLanguageSegmented(host);
    (host.querySelector('[data-language="es-ES"]') as HTMLButtonElement).click();
  });
  const button = page.locator('[data-language="es-ES"][aria-busy="true"]');
  await expect(button).toHaveCount(1);
  release();
  await expect(page.locator('[data-language="es-ES"][aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('#proposals-button .map-shell-button-label')).toHaveText('Diseños');
});
