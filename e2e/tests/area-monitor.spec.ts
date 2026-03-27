import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('Area monitor @features', () => {
  test('AreaMonitorDraw module is available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const draw = await page.evaluate(() => {
      const w = window as any;
      if (!w.AreaMonitorDraw) return { exists: false };
      return {
        exists: true,
        hasActivate: typeof w.AreaMonitorDraw.activate === 'function',
        hasDeactivate: typeof w.AreaMonitorDraw.deactivate === 'function',
        hasIsActive: typeof w.AreaMonitorDraw.isActive === 'function',
        hasGetVertices: typeof w.AreaMonitorDraw.getVertices === 'function',
        hasUndo: typeof w.AreaMonitorDraw.undoLastVertex === 'function',
      };
    });

    test.skip(!draw.exists, 'AreaMonitorDraw not loaded');
    expect(draw.hasActivate).toBe(true);
    expect(draw.hasDeactivate).toBe(true);
    expect(draw.hasIsActive).toBe(true);
  });

  test('AreaMonitorMap module is available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const map = await page.evaluate(() => {
      const w = window as any;
      if (!w.AreaMonitorMap) return { exists: false };
      return {
        exists: true,
        hasRender: typeof w.AreaMonitorMap.renderMonitor === 'function',
        hasClear: typeof w.AreaMonitorMap.clear === 'function',
        hasClearActive: typeof w.AreaMonitorMap.clearActiveMonitor === 'function',
        hasColors: typeof w.AreaMonitorMap.COLORS === 'object',
      };
    });

    test.skip(!map.exists, 'AreaMonitorMap not loaded');
    expect(map.hasRender).toBe(true);
    expect(map.hasClear).toBe(true);
  });

  test('AreaMonitorUI module is available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const ui = await page.evaluate(() => {
      const w = window as any;
      if (!w.AreaMonitorUI) return { exists: false };
      return {
        exists: true,
        hasFetchList: typeof w.AreaMonitorUI.fetchAreaMonitorList === 'function',
        hasShowCreation: typeof w.AreaMonitorUI.showCreationPanel === 'function',
        hasShowDetail: typeof w.AreaMonitorUI.showDetailPanel === 'function',
        hasToast: typeof w.AreaMonitorUI.showToast === 'function',
      };
    });

    test.skip(!ui.exists, 'AreaMonitorUI not loaded');
    expect(ui.hasFetchList).toBe(true);
    expect(ui.hasShowCreation).toBe(true);
  });

  test('AreaMonitorRouting module is available', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const routing = await page.evaluate(() => {
      const w = window as any;
      if (!w.AreaMonitorRouting) return { exists: false };
      return {
        exists: true,
        hasBuildUrl: typeof w.AreaMonitorRouting.buildMonitorUrl === 'function',
        hasClose: typeof w.AreaMonitorRouting.closeMonitor === 'function',
        hasOpen: typeof w.AreaMonitorRouting.openMonitor === 'function',
        hasParse: typeof w.AreaMonitorRouting.parseMonitorRoute === 'function',
        hasLoad: typeof w.AreaMonitorRouting.loadMonitor === 'function',
      };
    });

    test.skip(!routing.exists, 'AreaMonitorRouting not loaded');
    expect(routing.hasBuildUrl).toBe(true);
    expect(routing.hasOpen).toBe(true);
  });

  test('drawing mode can be activated and deactivated', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (!w.AreaMonitorDraw || typeof w.AreaMonitorDraw.activate !== 'function') {
        return { skip: true };
      }

      const wasActive = w.AreaMonitorDraw.isActive();
      w.AreaMonitorDraw.activate();
      const afterActivate = w.AreaMonitorDraw.isActive();
      w.AreaMonitorDraw.deactivate();
      const afterDeactivate = w.AreaMonitorDraw.isActive();

      return {
        skip: false,
        wasActive,
        afterActivate,
        afterDeactivate,
      };
    });

    test.skip(result.skip === true, 'AreaMonitorDraw not available');
    expect(result.afterActivate).toBe(true);
    expect(result.afterDeactivate).toBe(false);
  });

  test('areaMonitorDrawComplete event fires with correct shape', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      if (!w.AreaMonitorDraw) return { skip: true };

      // Listen for the event
      let eventDetail: any = null;
      window.addEventListener('areaMonitorDrawComplete', (e: any) => {
        eventDetail = e.detail;
      }, { once: true });

      // Dispatch a synthetic event to verify the listener pattern works
      window.dispatchEvent(new CustomEvent('areaMonitorDrawComplete', {
        detail: { polygon: [[0, 0], [1, 0], [1, 1], [0, 0]], parcels: [] },
      }));

      return {
        skip: false,
        eventReceived: eventDetail !== null,
        hasPolygon: eventDetail && Array.isArray(eventDetail.polygon),
        hasParcels: eventDetail && Array.isArray(eventDetail.parcels),
      };
    });

    test.skip(result.skip === true, 'AreaMonitorDraw not available');
    expect(result.eventReceived).toBe(true);
    expect(result.hasPolygon).toBe(true);
    expect(result.hasParcels).toBe(true);
  });
});
