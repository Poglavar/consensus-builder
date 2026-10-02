import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Serve the real frontend shell for monitor deep links on the local static test server. */
export async function installAreaMonitorSpaFallback(page: Page): Promise<void> {
  await page.route('**/monitors/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.isNavigationRequest() && request.method() === 'GET' && /^\/monitors\/\d+\/?$/.test(path)) {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: readFileSync(resolve(__dirname, '../../../frontend/index.html'), 'utf8'),
      });
    }
    return route.fallback();
  });

}
