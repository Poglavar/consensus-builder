import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, PARCEL_ID } from '../helpers/runtime';

test.describe('Parcel inspector @core', () => {
  test('a map click exposes cadastral identity, area and private ownership', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await expect(page.locator('#parcel-info-panel')).toBeHidden();
    await openParcel(page);
    await expect(page.locator('#parcel-info-title')).toContainText(PARCEL_ID);
    await expect(page.locator('#info-content')).toContainText('m²');
    await expect(page.locator('#info-content')).toContainText('Private owner');
    await expect(page.locator('#info-content')).not.toContainText('Privatni vlasnik');
    await page.locator('#parcel-info-panel .close-button').click();
    await page.evaluate(() => (window as any).i18n.setLanguage('hr'));
    const center = await page.evaluate(id => {
      const bounds = (window as any).ParcelPresenter.getLayer(id).getBounds();
      const point = bounds.getCenter();
      return { lng: point.lng, lat: point.lat };
    }, PARCEL_ID);
    await clickMapPoint(page, center.lng, center.lat);
    await expect(page.locator('#parcel-menu')).toBeVisible();
    await page.locator('#parcel-menu').getByRole('menuitem', { name: 'Detalji', exact: true }).click();
    await expect(page.locator('#parcel-info-panel')).toBeVisible();
    await expect(page.locator('#info-content')).toContainText('Privatni vlasnik');
    await expect(page.locator('#info-content')).not.toContainText('Private owner');
    expect(await page.evaluate(() => (window as any).currentParcel.id)).toBe(PARCEL_ID);
    // Desktop: no blank phone drag handle above the panel, and the map credit stays on the bottom
    // line under the shell's button row instead of being lifted behind the panel.
    await expect(page.locator('#parcel-info-panel .mobile-dock-sheet-handle')).toBeHidden();
    // The provider credit is MapCredits' control since adf27515 (it replaced Leaflet's attribution).
    const creditsControl = page.locator('.map-credits-control');
    const panelControl = page.locator('#parcel-info-panel');
    await expect(creditsControl).toBeVisible();
    await expect(panelControl).toBeVisible();
    const credit = await creditsControl.boundingBox();
    const panel = await panelControl.boundingBox();
    const bottomRow = await page.locator('#map-shell-bottom-right').boundingBox();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(credit!.x).toBeGreaterThanOrEqual(0);
    expect(credit!.y).toBeGreaterThanOrEqual(0);
    expect(credit!.x + credit!.width).toBeLessThanOrEqual(viewport!.width);
    expect(credit!.y + credit!.height).toBeLessThanOrEqual(viewport!.height);
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.y).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport!.width);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport!.height);
    // The desktop inspector is docked on the right and attribution stays at bottom-left. Either
    // axis can provide clearance; requiring the credit below the panel rejects this valid layout.
    const separatedHorizontally = credit!.x + credit!.width <= panel!.x || panel!.x + panel!.width <= credit!.x;
    const separatedVertically = credit!.y + credit!.height <= panel!.y || panel!.y + panel!.height <= credit!.y;
    expect(separatedHorizontally || separatedVertically).toBe(true);
    expect(credit!.y + credit!.height).toBeGreaterThan(bottomRow!.y - credit!.height);
    expect(credit!.y + credit!.height).toBeLessThanOrEqual(bottomRow!.y + 1);
  });
  test('government ownership follows the clicked parcel', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'info', 'HR-335754-1235');
    await expect(page.locator('#info-content')).toContainText('REPUBLIKA HRVATSKA');
    await expect(page.locator('#parcel-info-title')).toContainText('1235');
  });
  test('tabs open the palette and tools; close dismisses the inspector', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page);
    await page.locator('#parcel-info-panel').getByRole('button', { name: 'Proposals', exact: true }).click();
    await expect(page.locator('.parcel-build-palette')).toBeVisible();
    await expect(page.locator('.parcel-build-btn')).toHaveCount(15);
    await page.locator('#parcel-info-panel').getByRole('button', { name: 'Tools', exact: true }).click();
    await expect(page.locator('#parcelBuilderButton')).toBeVisible();
    await page.locator('#parcel-info-panel .close-button').click();
    await expect(page.locator('#parcel-info-panel')).toBeHidden();
  });
});
