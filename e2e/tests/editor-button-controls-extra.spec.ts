// Purpose: exercise dynamically created editor controls that appeared after the primary editor-control audit.
import { test, expect } from '../helpers/fixtures';
import { openCity, clickMapPoint, openParcel, drawCorridor, showProposal, runParcelCommand } from '../helpers/runtime';

test.describe('Dynamic editor control effects @features', () => {
  test('selecting and deleting a polygon vertex removes it from the live site boundary', async ({ mockApi: page }) => {
    await openCity(page);
    await runParcelCommand(page, 15.9822, 45.80025, 'parcel.useAsSite');
    const ring = () => page.evaluate(() => (window as any).SiteTool.current().ring.length);
    const initialCount = await ring();
    expect(initialCount).toBeGreaterThan(3);

    const vertices = page.locator('#map-container .polygon-geometry-editor__vertex');
    await expect(vertices).toHaveCount(initialCount);
    await vertices.first().click();
    const deleteVertex = page.getByRole('button', { name: 'Delete this corner', exact: true });
    await expect(deleteVertex).toBeVisible();
    await deleteVertex.click();
    await expect.poll(ring).toBe(initialCount - 1);
    await expect(deleteVertex).toHaveCount(0);
  });

  test('track speed cards start drawing with each selected speed and minimum radius', async ({ mockApi: page }) => {
    await openCity(page);
    const choices = [
      { speed: 50, radius: 300 },
      { speed: 80, radius: 500 },
      { speed: 120, radius: 1000 },
      { speed: 160, radius: 2000 },
      { speed: 200, radius: 3500 },
      { speed: 250, radius: 5000 },
    ];
    for (const choice of choices) {
      await openParcel(page, 'proposals');
      await page.locator('.parcel-transport-btn--track').click();
      const modal = page.locator('#track-speed-modal');
      await expect(modal).toBeVisible();
      await modal.locator('.track-speed-option[data-speed="' + choice.speed + '"]').click();
      await expect(modal).toBeHidden();
      await expect(page.locator('#road-drawing-controls')).toBeVisible();
      await expect.poll(() => page.evaluate(() => Function('return trackSpeed')())).toBe(choice.speed);
      await expect.poll(() => page.evaluate(() => Function('return trackMinCurvatureRadius')())).toBe(choice.radius);
      await page.locator('#road-drawing-controls').getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('#road-drawing-controls')).toBeHidden();
    }
  });

  test('corridor limits switch between parcels and buildings and each survey toggle updates', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await drawCorridor(page, 'road');
    await showProposal(page, id);
    const details = page.locator('#proposal-details-panel');
    const expand = details.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await details.locator('.btn-cross-section').click();
    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();

    const buildings = editor.locator('.corridor-limit-option[data-limit="buildings"]');
    await buildings.click();
    await expect(buildings).toHaveAttribute('aria-pressed', 'true');
    // The sources in use (the Buildings layer), then each other source in Zagreb's list (its outline).
    for (const survey of ['used', 'dgu', 'osm']) {
      const button = editor.locator('.corridor-limit-option[data-survey="' + survey + '"]');
      await expect(button).toBeVisible();
      const wasPressed = await button.getAttribute('aria-pressed');
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', wasPressed === 'true' ? 'false' : 'true');
    }
    const parcels = editor.locator('.corridor-limit-option[data-limit="parcels"]');
    await parcels.click();
    await expect(parcels).toHaveAttribute('aria-pressed', 'true');
    await expect(editor.locator('.corridor-limit-option[data-survey]')).toHaveCount(0);
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(editor).toHaveCount(0);
  });
});
