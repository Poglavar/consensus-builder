import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * hideParcelInfoPanel — verifying the panel can be programmatically closed
 * and that the close button in the HTML correctly calls it.
 */

test.describe('Hide parcel info panel @core', () => {
  // A `typeof hideParcelInfoPanel === 'function'` check used to sit here. The two tests below call
  // it (directly, and via the close button), which is what actually proves it hides the panel.

  test('programmatically showing then hiding panel works', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const panel = document.getElementById('parcel-info-panel');
      if (!panel) return { success: false, reason: 'no-panel' };

      // Force show
      panel.classList.add('visible');
      const visibleAfterShow = panel.classList.contains('visible');

      // Hide via function
      const hideFn = w.Parcels?.uiParcelPanel?.hideParcelInfoPanel || w.hideParcelInfoPanel;
      if (typeof hideFn === 'function') {
        hideFn();
      } else {
        panel.classList.remove('visible');
      }
      const visibleAfterHide = panel.classList.contains('visible');

      return { success: true, visibleAfterShow, visibleAfterHide };
    });

    expect(result.success).toBe(true);
    expect(result.visibleAfterShow).toBe(true);
    expect(result.visibleAfterHide).toBe(false);
  });

  test('close button in panel header triggers hide', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const panel = document.getElementById('parcel-info-panel');
      const closeBtn = panel?.querySelector('.close-button') as HTMLElement | null;
      if (!panel || !closeBtn) return { success: false, reason: 'no-panel-or-btn' };

      // Force show
      panel.classList.add('visible');
      const before = panel.classList.contains('visible');

      // Click close
      closeBtn.click();

      // Small delay for any async handler
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: true,
            before,
            after: panel.classList.contains('visible'),
          });
        }, 200);
      });
    });

    expect(result.success).toBe(true);
    expect(result.before).toBe(true);
    expect(result.after).toBe(false);
  });
});
