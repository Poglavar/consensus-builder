import { test, expect } from '../helpers/fixtures';

test.describe('Public urban-planning landing page @core', () => {
  test('explains the product and opens the live map', async ({ mockApi: page }) => {
    await page.goto('/urban-planning.html');

    await expect(page).toHaveTitle('Consensus Builder · Free urban planning software');
    await expect(page.getByRole('heading', { level: 1, name: 'Consensus Builder: free urban planning software' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A focused map tool for participatory planning' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/ArcGIS|Esri/i);
    await expect(page.locator('main')).toContainText('community zoning and development proposals');
    await expect(page.locator('main')).toContainText('does not create an adopted zoning plan');
    await expect(page.getByRole('link', { name: 'planning workflow guide' })).toBeVisible();
    const heroImage = page.locator('main header.intro-with-visual > img');
    await expect.poll(() => heroImage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    let imageBox = await heroImage.boundingBox();
    expect(imageBox).toBeTruthy();
    expect(imageBox!.width / imageBox!.height).toBeCloseTo(2, 1);

    await page.screenshot({ path: '/private/tmp/urban-planning-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { level: 1, name: 'Consensus Builder: free urban planning software' })).toBeVisible();
    imageBox = await heroImage.boundingBox();
    expect(imageBox).toBeTruthy();
    expect(imageBox!.width / imageBox!.height).toBeCloseTo(2, 1);
    await page.getByRole('link', { name: 'Community planning' }).click();
    await expect(page.getByRole('heading', { name: 'Community zoning proposals on real ground' })).toBeInViewport();
    const lastMapLink = page.getByRole('link', { name: 'Open Consensus Builder and explore the map' });
    await lastMapLink.scrollIntoViewIfNeeded();
    await expect(lastMapLink).toBeInViewport();
    await page.screenshot({ path: '/private/tmp/urban-planning-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByRole('link', { name: 'Explore the urban planning map' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#map')).toBeVisible();
    await page.locator('#settings-button').click();
    await expect(page.locator('#settings-sheet')).toBeVisible();
    await expect(page.locator('.settings-brand-title')).toHaveText('Consensus Builder');
  });
});
