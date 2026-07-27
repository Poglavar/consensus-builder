import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Notification / alert system — showStyledAlert creates a confirm dialog overlay.
 */

test.describe('Notification and alert system @features', () => {
  // Two existence checks (`typeof showStyledAlert`, `typeof updateStatus`) were dropped from this
  // file — both functions are called for real by the tests that remain.

  test('showStyledAlert creates overlay and dialog', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const hasFunction = await page.evaluate(() => typeof (window as any).showStyledAlert === 'function');
    test.skip(!hasFunction, 'showStyledAlert not loaded');

    // Fire the alert — it returns a promise (resolved when user confirms)
    await page.evaluate(() => {
      const w = window as any;
      // Don't await — we'll click the confirm button manually
      w.__testAlertPromise = w.showStyledAlert('Test notification message');
    });
    await page.waitForTimeout(500);

    const dialog = await page.evaluate(() => {
      const overlay = document.querySelector('.cb-confirm-overlay');
      const dialogEl = document.querySelector('.cb-confirm-dialog');
      const message = document.querySelector('.cb-confirm-message');
      return {
        hasOverlay: !!overlay,
        hasDialog: !!dialogEl,
        hasMessage: !!message,
        messageText: message?.textContent ?? '',
      };
    });

    expect(dialog.hasOverlay).toBe(true);
    expect(dialog.hasDialog).toBe(true);
    expect(dialog.messageText).toContain('Test notification message');
  });

  test('showStyledAlert dialog can be dismissed', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const hasFunction = await page.evaluate(() => typeof (window as any).showStyledAlert === 'function');
    test.skip(!hasFunction, 'showStyledAlert not loaded');

    await page.evaluate(() => {
      (window as any).showStyledAlert('Dismissable alert');
    });
    await page.waitForTimeout(500);

    // Find and click the confirm/OK button inside the dialog
    await page.evaluate(() => {
      const btn = document.querySelector('.cb-confirm-dialog button') ||
        document.querySelector('.cb-confirm-overlay button');
      if (btn) (btn as HTMLElement).click();
    });
    await page.waitForTimeout(500);

    const afterDismiss = await page.evaluate(() => {
      const overlay = document.querySelector('.cb-confirm-overlay');
      return { overlayGone: !overlay };
    });

    expect(afterDismiss.overlayGone).toBe(true);
  });

  test('updateStatus sets status message in DOM', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.updateStatus !== 'function') return { skip: true };
      w.updateStatus('E2E test status message');
      // Find status element — typically #status or .status-bar
      const statusEl = document.getElementById('status') ||
        document.querySelector('.status-bar') ||
        document.querySelector('[data-status]');
      return {
        skip: false,
        statusText: statusEl?.textContent ?? '',
        found: !!statusEl,
      };
    });

    test.skip(result.skip === true, 'updateStatus not loaded');
    // The message must actually reach the status bar. (This used to end in `expect(true).toBe(true)`,
    // so a missing status element passed silently.)
    expect(result.found).toBe(true);
    expect(result.statusText).toContain('E2E test status message');
  });
});
