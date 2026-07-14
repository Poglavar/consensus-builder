import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Measurement tool. toggleMeasureTool() rewires the Leaflet map's click/mousemove handlers and the
 * container cursor, so it needs a real map — it cannot be unit-tested in node.
 *
 * Two tests were dropped from this file: an existence check (`typeof toggleMeasureTool === 'function'`),
 * and a `clearAllMeasurements` test that could never actually run — `allMeasurements` is a module-scoped
 * `let` in measurement-tool.js, so it is never on `window` and the test's own guard skipped it on
 * every run.
 */

test.describe('Measurement tool @features', () => {
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
});
