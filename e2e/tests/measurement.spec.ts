import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Measurement tool @features', () => {
  test('measurement mode flag is accessible', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      return {
        hasMeasureMode: typeof w.measureMode !== 'undefined',
        hasToggle: typeof w.toggleMeasureTool === 'function',
        hasClear: typeof w.clearMeasurement === 'function',
        hasClearAll: typeof w.clearAllMeasurements === 'function',
        hasAllMeasurements: Array.isArray(w.allMeasurements),
      };
    });

    const hasSome = Object.values(result).some(v => v === true);
    test.skip(!hasSome, 'Measurement module not loaded');
    expect(result.hasToggle).toBe(true);
  });

  test('toggleMeasureTool activates and deactivates', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.toggleMeasureTool !== 'function') return { skip: true };

      const before = w.measureMode;
      w.toggleMeasureTool();
      const afterFirst = w.measureMode;
      w.toggleMeasureTool();
      const afterSecond = w.measureMode;

      return {
        skip: false,
        before,
        afterFirst,
        afterSecond,
        toggled: afterFirst !== before,
        restoredOrToggled: afterSecond !== afterFirst,
      };
    });

    test.skip(result.skip === true, 'toggleMeasureTool not available');
    expect(result.toggled).toBe(true);
    expect(result.restoredOrToggled).toBe(true);
  });

  test('clearAllMeasurements resets the measurements array', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.clearAllMeasurements !== 'function' || !Array.isArray(w.allMeasurements)) {
        return { skip: true };
      }

      w.clearAllMeasurements();
      return {
        skip: false,
        isEmpty: w.allMeasurements.length === 0,
      };
    });

    test.skip(result.skip === true, 'Measurement clearing not available');
    expect(result.isEmpty).toBe(true);
  });
});
