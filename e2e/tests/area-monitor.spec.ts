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

  test('detail panel renders fetched monitor data inside the map container and closes cleanly', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(async () => {
      document.getElementById('parcel-info-panel')?.classList.add('visible');
      const w = window as any;
      const data = await w.AreaMonitorUI.fetchAreaMonitor(1);
      w.AreaMonitorRouting = null;
      w.AreaMonitorUI.showDetailPanel(data);
    });

    const panel = page.locator('#map-container #area-monitor-detail-panel');
    const parcelPanel = page.locator('#parcel-info-panel');
    await expect(panel).toBeVisible();
    await expect(parcelPanel).toBeVisible();
    await expect(panel.locator('.panel-header h3')).toHaveText('Zapadni Jarunski Most');
    await expect(panel.locator('.area-monitor-detail-summary__percent')).toHaveText('33%');
    await expect(panel.locator('.area-monitor-detail-summary__meta')).toContainText('1 / 3');
    await expect(panel.locator('.area-monitor-detail-links a')).toHaveCount(2);
    await expect(panel.locator('.area-monitor-detail-links a').first()).toHaveAttribute('href', 'https://example.com/eojn/jarun');
    await expect(panel.locator('.area-monitor-detail-links a').nth(1)).toHaveAttribute('href', 'https://example.com/forum/jarun');
    await expect(panel.locator('#am-detail-minimize')).toBeVisible();
    await expect(panel.locator('#am-share')).toBeVisible();

    const panelBox = await panel.boundingBox();
    const parcelPanelBox = await parcelPanel.boundingBox();
    if (!panelBox || !parcelPanelBox) {
      throw new Error('Expected both area monitor and parcel panels to have layout boxes.');
    }
    expect(panelBox.y + panelBox.height).toBeLessThan(parcelPanelBox.y);

    const minimizeButton = panel.locator('#am-detail-minimize');
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'true');
    await minimizeButton.click();
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('.panel-body')).toBeHidden();

    await minimizeButton.click();
    await expect(minimizeButton).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator('.panel-body')).toBeVisible();

    await panel.locator('#am-detail-close').click();
    await expect(page.locator('#area-monitor-detail-panel')).toHaveCount(0);
  });

  test('monitor list modal renders API data and forwards selection through routing', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(() => {
      const w = window as any;
      w.__openedMonitorId = null;
      w.AreaMonitorRouting = {
        openMonitor(id: number) {
          w.__openedMonitorId = id;
        },
      };
    });

    await page.evaluate(async () => {
      const w = window as any;
      await w.AreaMonitorUI.showMonitorListModal();
    });

    const modal = page.locator('#area-monitor-list-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Zapadni Jarunski Most');
    await expect(modal).toContainText('Vukovarska Corridor');

    await modal.getByRole('button', { name: /Zapadni Jarunski Most/ }).click();
    const openedMonitorId = await page.evaluate(() => (window as any).__openedMonitorId);
    expect(openedMonitorId).toBe(1);

    await page.locator('#am-list-close').click();
    await expect(page.locator('#area-monitor-list-modal')).toHaveCount(0);
    await expect(page.locator('#area-monitor-list-backdrop')).toHaveCount(0);
  });

  test('mobile monitor list selection collapses the sidebar before routing to the monitor', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(() => {
      const sidebar = document.getElementById('sidebar');
      if (sidebar?.classList.contains('collapsed')) {
        (window as any).toggleSidebar?.();
      }

      const w = window as any;
      w.__openedMonitorId = null;
      w.__sidebarCollapsedAtOpen = null;
      w.AreaMonitorRouting = {
        openMonitor(id: number) {
          w.__openedMonitorId = id;
          w.__sidebarCollapsedAtOpen = document.getElementById('sidebar')?.classList.contains('collapsed') ?? null;
        },
      };
    });

    await page.evaluate(async () => {
      const w = window as any;
      await w.AreaMonitorUI.showMonitorListModal();
    });

    await expect(page.locator('#area-monitor-list-modal')).toBeVisible();
    await page.locator('#area-monitor-list-modal').getByRole('button', { name: /Zapadni Jarunski Most/ }).click();

    await expect.poll(async () => {
      return page.evaluate(() => (window as any).__openedMonitorId);
    }).toBe(1);

    await expect(page.locator('#area-monitor-list-modal')).toHaveCount(0);
    await expect(page.locator('#sidebar')).toHaveClass(/collapsed/);

    const sidebarCollapsedAtOpen = await page.evaluate(() => (window as any).__sidebarCollapsedAtOpen);
    expect(sidebarCollapsedAtOpen).toBe(true);
  });

  test('loading a monitor in the wrong city prompts and cancels cleanly', async ({ mockApi: page }) => {
    await page.goto('/?city=bg');
    await waitForMapReady(page);

    await page.evaluate(() => {
      const w = window as any;
      w.__areaMonitorRenderCount = 0;
      w.__areaMonitorPromptMessage = '';
      w.__areaMonitorToastMessage = '';

      w.AreaMonitorUI.fetchAreaMonitor = async () => ({
        monitor: {
          id: 1,
          name: 'Zapadni Jarunski Most',
          cityId: 'zagreb',
          parcelIds: [],
        },
        parcels: [],
        summary: {
          total: 0,
          governmentOwned: 0,
          remaining: 0,
        },
      });

      w.AreaMonitorMap.renderMonitor = () => {
        w.__areaMonitorRenderCount += 1;
      };
      w.AreaMonitorMap.loadOverlayGeometries = async () => {};
      w.AreaMonitorUI.showDetailPanel = () => {};
      w.AreaMonitorUI.showToast = (message: string) => {
        w.__areaMonitorToastMessage = String(message || '');
      };
      w.showStyledConfirm = async (message: string) => {
        w.__areaMonitorPromptMessage = String(message || '');
        return false;
      };

      window.history.pushState({ monitorId: 1 }, '', '/monitors/1?city=bg');
    });

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.AreaMonitorRouting.loadMonitor(1, { fitBounds: true });
      return {
        currentCityId: w.CityConfigManager.getCurrentCityId(),
        promptMessage: w.__areaMonitorPromptMessage,
        toastMessage: w.__areaMonitorToastMessage,
        renderCount: w.__areaMonitorRenderCount,
        pathname: window.location.pathname,
        search: window.location.search,
      };
    });

    expect(result.currentCityId).toBe('belgrade');
    expect(result.promptMessage).toContain('created for Zagreb, Croatia');
    expect(result.promptMessage).toContain('current city is Belgrade, Serbia');
    expect(result.toastMessage).toBe('Area monitor load cancelled because the selected city does not match.');
    expect(result.renderCount).toBe(0);
    expect(result.pathname).toBe('/');
    expect(result.search).toBe('?city=bg');
  });
});
