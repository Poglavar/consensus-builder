import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint } from '../helpers/runtime';

test.describe('Map measurement and pinpoint @features', () => {
  test('two real clicks measure distance; Clear removes the line and markers', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#tools-button').click();
    await page.locator('#measureButton').click();
    await page.locator('#tools-button').click();
    await clickMapPoint(page, 15.982, 45.8001);
    await clickMapPoint(page, 15.9824, 45.8001);
    await expect(page.locator('.measurement-label')).toHaveCount(1);
    const distance = parseFloat(await page.locator('.measurement-label').innerText());
    expect(distance).toBeGreaterThan(25);
    expect(distance).toBeLessThan(40);
    await expect(page.locator('.measurement-marker')).toHaveCount(2);
    await page.locator('#tools-button').click();
    await page.locator('#clearMeasurementsButton').click();
    await expect(page.locator('.measurement-label')).toHaveCount(0);
    await expect(page.locator('.measurement-marker')).toHaveCount(0);
    await expect(page.locator('.measurement-line')).toHaveCount(0);
    await page.locator('#measureButton').click();
    expect(await page.evaluate(() => (window as any).measureMode)).toBe(false);
  });

  test('pinpoint reports coordinates and the cadastral parcel under the cursor; Escape exits', async ({ mockApi: page }) => {
    const diagnostics: string[] = [];
    page.on('console', message => { if (message.text().startsWith('[whatIsHere]')) diagnostics.push(message.text()); });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCity(page);
    await page.locator('#tools-button').click();
    await page.locator('#pinpointButton').click();
    await page.locator('#tools-button').click();
    await clickMapPoint(page, 15.9822, 45.80025);
    await expect(page.locator('.pinpoint-readout')).toContainText('45.800');
    await expect.poll(() => diagnostics.join(' ')).toContain('parcel(s) cover this point');
    const coordinates = await page.locator('.pinpoint-readout').innerText();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(coordinates);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pinpoint-readout')).toBeHidden();
    expect(await page.evaluate(() => (window as any).pinpointToolIsActive())).toBe(false);
  });
});
