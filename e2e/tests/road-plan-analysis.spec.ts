import { test, expect } from '../helpers/fixtures';
import { clickMapPoint, openCity, openParcel } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';

const PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

test.describe('Government plan and road analysis controls @features', () => {
  test('loads and applies a government plan through its real tools controls', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), PARCEL_IDS);
    await expect.poll(() => page.evaluate(ids => ids.filter((id: string) => !!(window as any).LiveParcelFabric.get(id)).length, PARCEL_IDS)).toBe(PARCEL_IDS.length);

    await page.locator('#layers-button').click();
    await page.locator('#showGovernmentRoadPlan').check();
    await expect.poll(() => page.evaluate(() => (window as any).governmentRoadPlanLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).getGovernmentPlanCollection?.()?.features?.[0]?.geometry?.type)).toBe('Polygon');

    await page.locator('#layers-button').click();
    await page.locator('#tools-button').click();
    const apply = page.locator('#applyGovernmentRoadPlanButton');
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect.poll(() => page.evaluate(() => (window as any).lastGovernmentPlanAutoApplyStats?.result)).toBe('applied');
    await expect.poll(() => page.evaluate(() => (window as any).lastGovernmentPlanAutoApplyStats?.newSegments || 0)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().some((proposal: any) => proposal.applied && proposal.roadProposal?.definition?.kind === 'government_plan'))).toBe(true);
  });

  test('area monitor paints and submits the loaded city plan polygon', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    const createRequests: any[] = [];
    await page.route('**/area-monitors**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return route.continue();
      if (request.method() === 'POST' && url.pathname.endsWith('/area-monitors')) {
        createRequests.push(request.postDataJSON());
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 77, name: createRequests[0].name, cityId: 'zagreb', parcelIds: [] }) });
      }
      return route.continue();
    });
    await openCity(page);

    await page.locator('#tools-button').click();
    await page.locator('#amCityPlanToggle').check();
    await expect.poll(() => page.evaluate(() => (window as any).governmentRoadPlanLayer?.getLayers?.().length || 0)).toBeGreaterThan(0);
    await expect(page.locator('#areaMonitorFromPlanButton')).toBeEnabled();
    await page.locator('#areaMonitorFromPlanButton').click();
    await expect(page.locator('#areaMonitorFromPlanButton')).toHaveClass(/active/);
    await expect(page.locator('#areaMonitorDrawButton')).toBeDisabled();

    // The visible green plan vertices are the polygon's real vertices; close by clicking the first.
    for (const point of [[15.9820, 45.80015], [15.98255, 45.80015], [15.98255, 45.80055], [15.9820, 45.80055], [15.9820, 45.80015]]) {
      await clickMapPoint(page, point[0], point[1]);
    }
    await expect(page.locator('#area-monitor-creation-panel')).toBeVisible();
    await page.locator('#am-name').fill('Plan-derived watch area');
    await page.locator('#am-create').click();
    await expect.poll(() => createRequests.length).toBe(1);
    expect(createRequests[0]).toMatchObject({ name: 'Plan-derived watch area', cityId: 'zagreb', polygon: { type: 'Polygon' } });
    expect(createRequests[0].polygon.coordinates[0]).toHaveLength(5);
  });

  test('road analysis visualization controls change real centerline, width, focus, and clear state', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await openParcel(page);
    await page.locator('#parcel-info-panel .parcel-tab-btn').filter({ hasText: 'Tools' }).click();
    await page.locator('#analyzeRoadButton').click();
    await expect(page.locator('#road-analysis-panel')).toHaveClass(/visible/);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length)).toBeGreaterThan(0);
    await page.locator('.tab-btn[onclick="switchTab(this, \'visualization-tab\')"]').click();

    const paths = () => page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length);
    const initialPaths = await paths();
    const centerline = page.locator('#showCenterline');
    await expect(centerline).toBeChecked();
    await centerline.uncheck();
    await expect.poll(paths).toBeLessThan(initialPaths);
    await centerline.check();
    await expect.poll(paths).toBeGreaterThan(initialPaths - 1);

    const widthLines = page.locator('#showWidthLines');
    await expect(widthLines).toBeChecked();
    const withWidths = await paths();
    await widthLines.uncheck();
    await expect.poll(paths).toBeLessThan(withWidths);
    await widthLines.check();

    await page.getByRole('button', { name: 'Focus View' }).click();
    await expect.poll(() => page.evaluate(() => map.getBounds().contains(roadAnalysisLayers.centerline.getBounds()))).toBe(true);

    await page.getByRole('button', { name: 'Clear All' }).click();
    await expect.poll(paths).toBeLessThan(initialPaths);
    await expect(page.locator('#road-analysis-panel')).toHaveClass(/visible/);
  });
});
