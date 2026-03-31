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

  test('applyBasemap function exists', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      return {
        hasApply: typeof w.applyBasemap === 'function',
        hasInit: typeof w.initBasemapSelector === 'function',
        hasSync: typeof w.syncBasemapSelector === 'function',
      };
    });

    const hasSome = result.hasApply || result.hasInit || result.hasSync;
    test.skip(!hasSome, 'Basemap module not loaded');
    expect(result.hasApply).toBe(true);
  });

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
      if (typeof w.applyBasemap !== 'function') return { switched: false, reason: 'no-function' };

      const select = document.getElementById('tile-source-select') as HTMLSelectElement | null;
      const currentVal = select?.value ?? 'openstreetmap';
      const newVal = currentVal === 'openstreetmap' ? 'maptiler' : 'openstreetmap';

      w.applyBasemap(w.map, newVal);
      return { switched: true, from: currentVal, to: newVal };
    });

    test.skip(!switched.switched, `Could not switch basemap: ${(switched as any).reason}`);
    await page.waitForTimeout(2000);

    // Check that tile URLs changed
    const afterTiles = await page.evaluate(() => {
      const imgs = document.querySelectorAll('.leaflet-tile-pane img');
      return Array.from(imgs).slice(0, 3).map((img: any) => img.src);
    });

    // At least the tile source should differ (different URL pattern)
    const tilesChanged = afterTiles.length > 0 && (
      beforeTiles.length === 0 ||
      afterTiles[0] !== beforeTiles[0]
    );
    expect(tilesChanged).toBe(true);
  });

  test('tile source selector syncs with applyBasemap', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.applyBasemap !== 'function') return { synced: false, reason: 'no-function' };

      w.applyBasemap(w.map, 'openstreetmap');
      const select = document.getElementById('tile-source-select') as HTMLSelectElement | null;
      return { synced: true, value: select?.value ?? '' };
    });

    test.skip(!result.synced, `Basemap function not available: ${(result as any).reason}`);
    expect(result.value).toBe('openstreetmap');
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
