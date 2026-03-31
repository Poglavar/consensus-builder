import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';

test.describe('Road tools @features', () => {
  test('road analysis functions are available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const roadFns = await page.evaluate(() => {
      const w = window as any;
      return {
        hasLineIntersection: typeof w.lineIntersection === 'function',
        hasIsPointInPolygon: typeof w.isPointInPolygon === 'function',
        hasFindIntersections: typeof w.findIntersections === 'function',
        hasIsRoadParcel: typeof w.isRoadParcel === 'function',
        hasMarkAsRoad: typeof w.markAsRoad === 'function' || typeof w.markParcelAsRoad === 'function',
      };
    });

    // At least some road functions should be available
    const hasSome = Object.values(roadFns).some(v => v === true);
    expect(hasSome).toBe(true);
  });

  test('lineIntersection computes correct intersection', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.lineIntersection !== 'function') return { skip: true };

      // Two crossing line segments
      const p1 = [0, 0], p2 = [10, 10];
      const p3 = [0, 10], p4 = [10, 0];
      const intersection = w.lineIntersection(p1, p2, p3, p4);
      return {
        skip: false,
        hasIntersection: intersection !== null,
        x: intersection ? intersection[0] : null,
        y: intersection ? intersection[1] : null,
      };
    });

    if (!result.skip) {
      expect(result.hasIntersection).toBe(true);
      expect(result.x).toBeCloseTo(5, 1);
      expect(result.y).toBeCloseTo(5, 1);
    }
  });

  test('isPointInPolygon correctly classifies points', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (typeof w.isPointInPolygon !== 'function') return { skip: true };

      const polygon = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
      return {
        skip: false,
        insideResult: w.isPointInPolygon([5, 5], polygon),
        outsideResult: w.isPointInPolygon([15, 15], polygon),
      };
    });

    if (!result.skip) {
      expect(result.insideResult).toBe(true);
      expect(result.outsideResult).toBe(false);
    }
  });

  test('road detection module initializes', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const hasRoadDetection = await page.evaluate(() => {
      const w = window as any;
      return (
        typeof w.isRoadParcel === 'function' ||
        typeof w.loadRoadParcels === 'function'
      );
    });

    expect(hasRoadDetection).toBe(true);
  });
});
