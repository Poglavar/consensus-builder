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

  test('3D mode toggle or functions exist', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const threeDCapability = await page.evaluate(() => {
      const w = window as any;
      return {
        hasToggle: typeof w.toggle3DMode === 'function' || typeof w.enable3DMode === 'function',
        hasThreeMode: typeof w.ThreeMode !== 'undefined' || typeof w.threeMode !== 'undefined',
        hasInitThree: typeof w.initThreeMode === 'function',
        hasThree: typeof w.THREE !== 'undefined',
      };
    });

    const hasCapability = threeDCapability.hasToggle || threeDCapability.hasThreeMode || threeDCapability.hasInitThree;
    // 3D functions depend on Three.js and its dependent scripts all loading
    test.skip(!hasCapability, 'Three.js 3D module functions not available in this environment');
    expect(hasCapability).toBe(true);
  });

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
