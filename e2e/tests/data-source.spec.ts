import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Data source switching. getBackendBase() resolves off window.location and the detected environment,
 * so it genuinely needs a page — but only one test in this file ever asserted that.
 *
 * Three tests were dropped: an existence check (`typeof getBackendBase === 'function'`), a
 * "switching data source changes backend base URL" test whose own comment admitted it did not switch
 * anything and only re-asserted the URL shape, and a persistence test whose entire assertion was
 * `typeof stored === 'string' || stored === null` — true of every possible value.
 */

test.describe('Data source switching @features', () => {
  test('default data source resolves to localhost in development', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      return {
        environment: w.current_environment,
        backendBase: typeof w.getBackendBase === 'function' ? w.getBackendBase() : null,
        dataSource: typeof w.getDataSource === 'function' ? w.getDataSource() : null,
      };
    });

    expect(result.backendBase).toMatch(/^https?:\/\//);
    // In dev/test environment served from localhost, should point to localhost
    if (result.environment === 'development') {
      expect(result.backendBase).toContain('localhost');
    }
  });
});
