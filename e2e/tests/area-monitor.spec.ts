import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

/**
 * Area monitor. Everything here is genuinely browser-bound: drawing hooks the Leaflet map, and the
 * detail panel / list modal / wrong-city prompt are all rendered DOM.
 *
 * Five tests were dropped from this file. Four were `typeof AreaMonitorX.y === 'function'` roll-calls
 * over the four modules — all of those functions are called for real below. The fifth dispatched its
 * own `areaMonitorDrawComplete` CustomEvent and asserted it received it, which tests the browser's
 * event loop rather than any application code.
 */

test.describe('Area monitor @features', () => {
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
