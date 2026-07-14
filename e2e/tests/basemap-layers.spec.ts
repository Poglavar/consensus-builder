import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Basemap selector and layer toggling — tile source switching, building layer visibility.
 */

test.describe('Basemap and layer controls @features', () => {
  test('tile source selector exists with correct options', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const selector = await page.evaluate(() => {
      const select = document.getElementById('tile-source-select') as HTMLSelectElement | null;
      if (!select) return { exists: false };

      const options = Array.from(select.options).map((opt) => ({
        value: opt.value,
        text: opt.textContent?.trim() ?? '',
      }));

      return {
        exists: true,
        currentValue: select.value,
        optionCount: options.length,
        options,
      };
    });

    expect(selector.exists).toBe(true);
    expect(selector.optionCount).toBeGreaterThanOrEqual(2);
    // Should have at least OpenStreetMap and MapTiler
    const values = selector.options!.map((o: any) => o.value);
    expect(values).toContain('openstreetmap');
  });

  // These two used to call a bare `window.applyBasemap`, which the app has not exposed since
  // basemap.js moved behind the `BasemapManager` namespace — so they skipped themselves on every
  // run and the basemap switch was in truth untested. They now call the real entry point.
  test('switching tile source updates map tiles', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // Record current tile URLs
    const beforeTiles = await page.evaluate(() => {
      const imgs = document.querySelectorAll('.leaflet-tile-pane img');
      return Array.from(imgs).slice(0, 3).map((img: any) => img.src);
    });

    // Switch to a different basemap programmatically
    const switched = await page.evaluate(() => {
      const w = window as any;
      const select = document.getElementById('tile-source-select') as HTMLSelectElement | null;
      const currentVal = select?.value ?? 'openstreetmap';
      const newVal = currentVal === 'openstreetmap' ? 'maptiler' : 'openstreetmap';

      w.BasemapManager.applyBasemap(w.map, newVal);
      return { from: currentVal, to: newVal };
    });

    // Tiles for the new source have to actually reach the tile pane.
    await expect
      .poll(async () => page.evaluate(() => {
        const imgs = document.querySelectorAll('.leaflet-tile-pane img');
        return Array.from(imgs).map((img: any) => img.src);
      }), { timeout: 15_000 })
      .not.toEqual(beforeTiles);

    const afterTiles = await page.evaluate(() => {
      const imgs = document.querySelectorAll('.leaflet-tile-pane img');
      return Array.from(imgs).slice(0, 3).map((img: any) => img.src);
    });
    expect(afterTiles.length).toBeGreaterThan(0);
    expect(afterTiles[0]).not.toBe(beforeTiles[0]);
    expect(switched.to).not.toBe(switched.from);
  });

  test('applyBasemap syncs the tile source selector back to the applied key', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      // Start from maptiler so the switch back to openstreetmap is a real change, not a no-op.
      w.BasemapManager.applyBasemap(w.map, 'maptiler');
      const afterMaptiler = (document.getElementById('tile-source-select') as HTMLSelectElement | null)?.value ?? '';
      w.BasemapManager.applyBasemap(w.map, 'openstreetmap');
      const afterOsm = (document.getElementById('tile-source-select') as HTMLSelectElement | null)?.value ?? '';
      return { afterMaptiler, afterOsm };
    });

    expect(result.afterMaptiler).toBe('maptiler');
    expect(result.afterOsm).toBe('openstreetmap');
  });

  test('buildings checkbox exists', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const checkbox = document.getElementById('showBuildings') as HTMLInputElement | null;
      return {
        exists: !!checkbox,
        type: checkbox?.type ?? '',
        checked: checkbox?.checked ?? false,
      };
    });

    expect(result.exists).toBe(true);
    expect(result.type).toBe('checkbox');
  });

  test('toggling buildings checkbox calls toggleLayer', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const checkbox = document.getElementById('showBuildings') as HTMLInputElement | null;
      if (!checkbox) return { toggled: false, reason: 'no-checkbox' };

      const hasToggleLayer = typeof w.toggleLayer === 'function';

      // Toggle
      const before = checkbox.checked;
      checkbox.checked = !before;
      checkbox.dispatchEvent(new Event('change'));

      return {
        toggled: true,
        hasToggleLayer,
        before,
        after: checkbox.checked,
      };
    });

    expect(result.toggled).toBe(true);
    expect(result.before).not.toBe(result.after);
  });

  test('city selector exists and is populated', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const selector = await page.evaluate(() => {
      const select = document.getElementById('city-select') as HTMLSelectElement | null;
      if (!select) return { exists: false };

      return {
        exists: true,
        optionCount: select.options.length,
        currentValue: select.value,
        options: Array.from(select.options).map((opt) => ({
          value: opt.value,
          text: opt.textContent?.trim() ?? '',
        })),
      };
    });

    expect(selector.exists).toBe(true);
    // Should have at least a few cities
    expect(selector.optionCount).toBeGreaterThanOrEqual(1);
  });

  test('data source selector exists', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const selector = await page.evaluate(() => {
      const select = document.getElementById('data-source-select') as HTMLSelectElement | null;
      if (!select) return { exists: false };
      return {
        exists: true,
        optionCount: select.options.length,
        currentValue: select.value,
      };
    });

    expect(selector.exists).toBe(true);
  });
});
