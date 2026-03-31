import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Frontend resilience @core', () => {
  test('lens entries fall back to defaults when persisted storage is corrupted', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await page.waitForFunction(() => typeof (window as any).getLensEntries === 'function');

    const baseline = await page.evaluate(() => {
      const w = window as any;
      return w.getLensEntries();
    });

    await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      w.PersistentStorage.setItem('lensEntries', '{bad json');
    });

    await page.reload();
    await waitForMapReady(page);
    await page.waitForFunction(() => typeof (window as any).getLensEntries === 'function');

    const recovered = await page.evaluate(() => {
      const w = window as any;
      return w.getLensEntries();
    });

    expect(recovered).toEqual(baseline);
  });

  test('agent storage load clears malformed persisted data instead of throwing', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await page.waitForFunction(() => typeof (window as any).agentStorage?.load === 'function');

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      w.PersistentStorage.setItem('consensus_agents', '{bad json');
      w.agentStorage.agents = new Map([['temp-agent', { id: 'temp-agent', name: 'Temp Agent' }]]);

      try {
        w.agentStorage.load();
      } catch (error: any) {
        return {
          threw: true,
          message: error && error.message ? error.message : String(error),
          count: -1,
        };
      }

      return {
        threw: false,
        count: typeof w.agentStorage.getAllAgents === 'function' ? w.agentStorage.getAllAgents().length : null,
      };
    });

    expect(result.threw).toBe(false);
    expect(result.count).toBe(0);
  });
});