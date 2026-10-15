// Check dismissal and recovery after a malformed parcel causes the real building generator to fail.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';

const BROKEN_PARCEL_ID = 'HR-335754-9999';

test.describe('Building generation error recovery @features', () => {
  test('OK dismisses a real generation error and leaves the editor available to recover', async ({ mockApi: page }) => {
    // Supply a cadastral record whose empty polygon cannot form a superparcel. This stays at the
    // external parcel API boundary; the app's fabric, generator and popup handlers remain real.
    await page.route('**/parcels/parcelIds**', route => {
      const ids = new URL(route.request().url()).searchParams.get('ids')?.split(',') || [];
      if (!ids.includes(BROKEN_PARCEL_ID)) return route.fallback();
      return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        features: [{
          type: 'Feature',
          properties: { parcelId: BROKEN_PARCEL_ID, id: BROKEN_PARCEL_ID, parcel_id: BROKEN_PARCEL_ID },
          geometry: { type: 'Polygon', coordinates: [] },
        }],
      }),
      });
    });

    await openCity(page);
    await page.evaluate(async id => (window as any).CadastralParcelRepository.ensureIds([id]), BROKEN_PARCEL_ID);
    await expect.poll(() => page.evaluate(id => !!(window as any).LiveParcelFabric.get(id), BROKEN_PARCEL_ID)).toBe(true);

    // Exercise the same public entry used by the building editor after a parcel selection, with
    // the malformed cadastral fixture as its selected site.
    await page.evaluate(id => (window as any).openUrbanRuleForParcels({ blockName: 'Invalid test parcel', parcelIds: [id] }), BROKEN_PARCEL_ID);
    const editor = page.locator('#blockify-modal');
    await expect(editor).toBeVisible();

    const popup = page.locator('body > div').filter({ has: page.getByRole('button', { name: 'OK', exact: true }) }).last();
    await expect(popup).toBeVisible({ timeout: 20_000 });
    await expect(popup).toContainText(/Building block creation failed/i);
    await expect(page.locator('#btn-blockify-done')).toBeDisabled();
    await popup.getByRole('button', { name: 'OK', exact: true }).click();

    await expect(popup).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect(page.locator('#btn-blockify-done')).toBeDisabled();

    // The visitor can leave the failed attempt and use the ordinary parcel editor successfully.
    await page.locator('#blockify-modal .on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
    await openParcel(page, 'proposals', PARCEL_ID);
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#blockify-modal .on-map-editor__header .close-circle-btn').click();
  });
});
