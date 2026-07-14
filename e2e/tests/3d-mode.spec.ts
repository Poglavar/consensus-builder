import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectors } from '../helpers/selectors';

test.describe('3D mode @features', () => {
  test('Three.js library is loaded', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const hasThree = await page.evaluate(() => {
      const w = window as any;
      return typeof w.THREE !== 'undefined';
    });

    expect(hasThree).toBe(true);
  });

  // A `typeof toggle3DMode === 'function'` check used to sit here. It named globals the app no
  // longer exposes, so it skipped itself on every run — and it booted a browser to do so. Entering
  // 3D for real (canvas, picking, isolation) is covered by proposal-editor.spec.ts.

  test('Three.js scene can be created', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const canCreateScene = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.THREE === 'undefined') return false;
      try {
        const scene = new w.THREE.Scene();
        return scene !== null && typeof scene === 'object';
      } catch {
        return false;
      }
    });

    expect(canCreateScene).toBe(true);
  });
});
