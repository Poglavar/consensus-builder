import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Corridor surface runs @features', () => {
  test('surface runs omit the tunnelled centerline edge', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const result = await page.evaluate(() => {
      const w = window as any;
      const nodes = [15.9740, 15.9750, 15.9760, 15.9770].map(lng => ({ lat: 45.8085, lng }));
      const tunnel = w.makeBuildingTunnelRecord(nodes[1], nodes[2], [{ id: 'building-under' }], { segmentId: 'seg-1' });
      const runs = w.corridorSurfaceRuns([nodes], [tunnel]);
      return {
        tunnelEdge: tunnel.edgeKey,
        runCount: runs.length,
        runs: runs.map((run: any[]) => run.map(p => p.lng)),
      };
    });
    expect(result.tunnelEdge).toBeTruthy();
    expect(result.runCount).toBe(2);
    expect(result.runs).toEqual([[15.974, 15.975], [15.976, 15.977]]);
  });
});
