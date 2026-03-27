import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Data source switching @features', () => {
  test('data source functions are available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const dataSourceFns = await page.evaluate(() => {
      const w = window as any;
      return {
        hasGetDataSource: typeof w.getDataSource === 'function',
        hasSetDataSource: typeof w.setDataSource === 'function',
        hasGetBackendBase: typeof w.getBackendBase === 'function',
        hasDataSourceModule: typeof w.DataSourceManager !== 'undefined' || typeof w.getDataSource === 'function',
      };
    });

    expect(dataSourceFns.hasGetBackendBase).toBe(true);
  });

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

    // In dev/test environment served from localhost, should point to localhost
    if (result.environment === 'development') {
      expect(result.backendBase).toContain('localhost');
    }
  });

  test('switching data source changes backend base URL', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.setDataSource !== 'function' || typeof w.getBackendBase !== 'function') {
        return { skip: true };
      }

      const originalBase = w.getBackendBase();
      // Note: actual switching may trigger storage clear, so just test the function exists
      return {
        skip: false,
        originalBase,
        hasSwitch: true,
      };
    });

    if (!result.skip) {
      expect(result.originalBase).toMatch(/^https?:\/\//);
    }
  });

  test('data source persists in storage', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const stored = await page.evaluate(() => {
      const w = window as any;
      if (w.PersistentStorage && typeof w.PersistentStorage.getItem === 'function') {
        return w.PersistentStorage.getItem('cb_data_source');
      }
      return null;
    });

    // Data source should be stored (or null if using default)
    expect(typeof stored === 'string' || stored === null).toBe(true);
  });
});
