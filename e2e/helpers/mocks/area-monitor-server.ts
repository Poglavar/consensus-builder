import { Page } from '@playwright/test';

/** Serve the real frontend shell for monitor deep links on the local static test server. */
export async function installAreaMonitorSpaFallback(page: Page): Promise<void> {
  await page.route('**/monitors/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.isNavigationRequest() && request.method() === 'GET' && /^\/monitors\/\d+\/?$/.test(path)) {
      // Read through the active test server so deep links keep its source instrumentation.
      const response = await route.fetch({ url: new URL('/index.html', url.origin).href });
      return route.fulfill({ response });
    }
    return route.fallback();
  });

}
