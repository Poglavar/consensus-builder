import { test, expect } from '../helpers/fixtures';

test('feedback form sends the reviewed report and shows its private receipt', async ({ page }) => {
  let sent: Record<string, string> = {};
  await page.route('**/feedback', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { report: { id: sent.reportId, status: 'received' } }, headers: { 'access-control-allow-origin': '*' } });
  });
  const privatePage = 'https://urbangametheory.xyz/designs?city=birmingham&token=private#draft=private';
  await page.goto(`/feedback.html?lang=en&page=${encodeURIComponent(privatePage)}`);
  await expect(page.getByLabel('Page or plan link (optional)')).toHaveValue('https://urbangametheory.xyz/designs?city=birmingham');
  await page.getByLabel('Report type').selectOption('feedback');
  await page.getByLabel('Your report', { exact: true }).fill('Please make full-plan sharing clearer.');
  await page.getByRole('button', { name: 'Send report', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Your report was received');
  expect(sent).toMatchObject({ kind: 'feedback', source: 'web', message: 'Please make full-plan sharing clearer.' });
  expect(sent.reportId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByLabel('Your report', { exact: true })).toHaveValue('');
});

test('a failed report keeps its text and reuses its receipt ID on retry in the selected language', async ({ page }) => {
  const sent: Array<Record<string, string>> = [];
  await page.route('**/feedback', async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: sent.length === 1 ? 503 : 201, json: sent.length === 1 ? { code: 'feedback-unavailable' } : { report: { id: sent[0].reportId, status: 'received' } }, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('/feedback.html?lang=hr');
  await page.getByLabel('Vaša prijava', { exact: true }).fill('Tri ceste su pogrešno označene kao izmijenjene.');
  await page.getByRole('button', { name: 'Pošalji prijavu' }).click();
  await expect(page.getByRole('status')).toContainText('Tekst je sačuvan');
  await expect(page.getByLabel('Vaša prijava', { exact: true })).not.toBeEmpty();
  await page.getByRole('button', { name: 'Pošalji prijavu' }).click();
  await expect(page.getByRole('status')).toContainText('Vaša je prijava zaprimljena');
  expect(sent[1].reportId).toBe(sent[0].reportId);
  await page.locator('#feedback-language').selectOption('es-ES');
  await expect(page.getByRole('button', { name: 'Enviar informe' })).toBeVisible();
});

test('the map contact section links to the feedback form', async ({ mockApi: page }) => {
  await page.goto('/?city=new_york');
  await expect(page.locator('[data-feedback-link]')).toHaveAttribute('href', '/feedback.html', { timeout: 30_000 });
  await expect(page.locator('[data-feedback-link]')).toContainText('Feedback');
  await page.locator('#settings-button').click();
  const info = page.locator('#settings-sheet [data-section="info"]');
  if (!await info.locator('[data-feedback-link]').isVisible()) await info.locator('.sheet-section-title').first().click();
  await info.locator('[data-feedback-link]').click();
  await expect(page).toHaveURL(/\/feedback\.html\?/);
  await expect(page.locator('#feedback-message')).toBeVisible();
});
