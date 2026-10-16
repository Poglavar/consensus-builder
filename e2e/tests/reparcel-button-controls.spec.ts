// Exercise reparcellization editing, ownership assignment, draft history, and commit effects.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import type { Page } from '@playwright/test';

const layout = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { label: 'West plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9819,45.8],[15.9821,45.8],[15.98215,45.80025],[15.9821,45.8005],[15.9819,45.8005],[15.9819,45.8]]] } },
    { type: 'Feature', properties: { label: 'East plot' }, geometry: { type: 'Polygon', coordinates: [[[15.9821,45.8],[15.9825,45.8],[15.9825,45.8005],[15.9821,45.8005],[15.98215,45.80025],[15.9821,45.8]]] } },
  ],
};

test.beforeEach(async ({ mockApi: page }) => {
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>',
  }));
});

async function openReadjustment(page: Page) {
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openParcel(page, 'proposals', PARCEL_ID);
  await page.locator('.parcel-build-btn--reparcellization').click();
  const modal = page.locator('.on-map-reparcellization');
  await expect(modal.locator('.on-map-editor__panel')).toBeVisible();
  await expect(modal.locator('[data-reparcel-commit]')).toBeEnabled({ timeout: 15_000 });
  return modal;
}

async function manualLayout(page: Page) {
  const modal = page.locator('.on-map-reparcellization');
  await modal.locator('label.reparcel-alg-option:has(input[value="manual"])').click();
  await modal.locator('[data-reparcel-upload]').setInputFiles({
    name: 'two-plots.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(layout)),
  });
  await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(2);
  return modal;
}

async function visiblePlotPoints(page: Page, count: number) {
  const points = await page.evaluate((wanted) => {
    const w = window as any;
    const map = w.map;
    let geometry: any = null;
    map?.eachLayer((layer: any) => {
      if (layer.options?.pane === 'reparcelTools' && layer.options.color === '#dc2626'
        && layer._path?.isConnected && layer.feature?.geometry) geometry = layer.feature.geometry;
    });
    if (!geometry || !w.turf) throw new Error('The readjustment site has no rendered pool boundary');
    const feature = { type: 'Feature', properties: {}, geometry };
    const [minLng, minLat, maxLng, maxLat] = w.turf.bbox(feature);
    const mapRect = map.getContainer().getBoundingClientRect();
    const obstacles = [...document.querySelectorAll('.on-map-reparcellization .on-map-editor__panel, .reparcel-tools')]
      .map((element: any) => element.getBoundingClientRect());
    const candidates: Array<{ x: number; y: number }> = [];
    for (const xRatio of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const yRatio of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const coordinate = [minLng + (maxLng - minLng) * xRatio, minLat + (maxLat - minLat) * yRatio];
        if (!w.turf.booleanPointInPolygon(w.turf.point(coordinate), feature)) continue;
        const point = map.latLngToContainerPoint([coordinate[1], coordinate[0]]);
        const screen = { x: mapRect.left + point.x, y: mapRect.top + point.y };
        const visible = screen.x >= mapRect.left && screen.x <= mapRect.right
          && screen.y >= mapRect.top && screen.y <= mapRect.bottom
          && screen.x >= 8 && screen.x <= w.innerWidth - 8 && screen.y >= 8 && screen.y <= w.innerHeight - 8
          && map.getContainer().contains(document.elementFromPoint(screen.x, screen.y))
      && !obstacles.some((rect: DOMRect) => screen.x >= rect.left && screen.x <= rect.right
            && screen.y >= rect.top && screen.y <= rect.bottom);
        if (visible && candidates.every(other => Math.hypot(other.x - screen.x, other.y - screen.y) > 24)) {
          candidates.push(screen);
          if (candidates.length === wanted) return candidates;
        }
      }
    }
    throw new Error(`Could not find ${wanted} unobstructed map points inside the readjustment site`);
  }, count);
  return points as Array<{ x: number; y: number }>;
}

async function visibleCutLineEndpoints(page: Page) {
  const endpoints = await page.evaluate(() => {
    const w = window as any;
    const map = w.map;
    let geometry: any = null;
    map?.eachLayer((layer: any) => {
      if (layer.options?.pane === 'reparcelTools' && layer.options.color === '#dc2626'
        && layer._path?.isConnected && layer.feature?.geometry) geometry = layer.feature.geometry;
    });
    if (!geometry || !w.turf) throw new Error('The readjustment site has no rendered pool boundary');
    const feature = { type: 'Feature', properties: {}, geometry };
    const [minLng, minLat, maxLng, maxLat] = w.turf.bbox(feature);
    const mapRect = map.getContainer().getBoundingClientRect();
    const obstacles = [...document.querySelectorAll('.on-map-reparcellization .on-map-editor__panel, .reparcel-tools')]
      .map((element: any) => element.getBoundingClientRect());
    const visible = (screen: { x: number; y: number }) => screen.x >= mapRect.left && screen.x <= mapRect.right
      && screen.y >= mapRect.top && screen.y <= mapRect.bottom
      && screen.x >= 8 && screen.x <= w.innerWidth - 8 && screen.y >= 8 && screen.y <= w.innerHeight - 8
      && map.getContainer().contains(document.elementFromPoint(screen.x, screen.y))
      && !obstacles.some((rect: DOMRect) => screen.x >= rect.left && screen.x <= rect.right
        && screen.y >= rect.top && screen.y <= rect.bottom);
    const candidates = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].flatMap(ratio => {
      const lng = minLng + (maxLng - minLng) * ratio;
      const lat = minLat + (maxLat - minLat) * ratio;
      return [0.08, 0.04, 0.02].flatMap(extension => [
        [[minLng - (maxLng - minLng) * extension, lat], [maxLng + (maxLng - minLng) * extension, lat]],
        [[lng, minLat - (maxLat - minLat) * extension], [lng, maxLat + (maxLat - minLat) * extension]],
      ]);
    });
    for (const coordinates of candidates) {
      const line = w.turf.lineString(coordinates);
      if (w.turf.lineIntersect(line, feature).features.length < 2) continue;
      const screens = coordinates.map((coordinate: number[]) => {
        const point = map.latLngToContainerPoint([coordinate[1], coordinate[0]]);
        return { x: mapRect.left + point.x, y: mapRect.top + point.y };
      });
      if (screens.every(visible)) return screens;
    }
    throw new Error('No boundary-crossing line fits the unobstructed map area');
  });
  return endpoints as Array<{ x: number; y: number }>;
}

test.describe('reparcellization button controls @core', () => {
  test('Close and Cancel exit the editor, with Cancel confirming a draft discard', async ({ mockApi: page }) => {
    let modal = await openReadjustment(page);
    const initialPlan = await page.evaluate(() => JSON.stringify((window as any).pendingReparcellizationPlan ?? null));
    await modal.locator('.on-map-editor__header .close-circle-btn').click();
    await expect(modal).toBeHidden();
    expect(await page.evaluate(() => JSON.stringify((window as any).pendingReparcellizationPlan ?? null))).toBe(initialPlan);

    modal = await openReadjustment(page);
    await modal.locator('.cash-offer-input').first().fill('12.34');
    await modal.locator('[data-reparcel-cancel]').click();
    const discard = page.getByRole('button', { name: 'Discard changes', exact: true });
    await expect(discard).toBeVisible();
    await discard.click();
    await expect(modal).toBeHidden();
    expect(await page.evaluate(() => JSON.stringify((window as any).pendingReparcellizationPlan ?? null))).toBe(initialPlan);
  });

  test('Draw plot creates draft points, Undo point removes the latest point, and Cancel removes the draft', async ({ mockApi: page }) => {
    await openReadjustment(page);
    const modal = await manualLayout(page);
    const draw = modal.locator('[data-reparcel-draw]');
    await draw.click();
    await expect(draw).toHaveAttribute('aria-pressed', 'true');
    await expect(modal.locator('[data-reparcel-draw-toolbar]')).toBeVisible();
    for (const point of await visiblePlotPoints(page, 2)) await page.mouse.click(point.x, point.y);
    const points = page.locator('#map-container .reparcel-vertex-handle');
    await expect(points).toHaveCount(2);
    const undo = modal.locator('[data-reparcel-undo]');
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(points).toHaveCount(1);
    await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(2);
    await modal.locator('[data-reparcel-cancel-draw]').click();
    await expect(modal.locator('[data-reparcel-draw-toolbar]')).toBeHidden();
    await expect(draw).toHaveAttribute('aria-pressed', 'false');
    await expect(points).toHaveCount(0);
    await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(2);
  });

  test('Erase boundary merges the two draft plots and clears its map target', async ({ mockApi: page }) => {
    await openReadjustment(page);
    const modal = await manualLayout(page);
    await modal.locator('[data-reparcel-erase]').click();
    const eraseLines = page.locator('#map-container path.reparcel-erase-line');
    await expect(modal.locator('[data-reparcel-erase]')).toHaveAttribute('aria-pressed', 'true');
    await expect(eraseLines).toHaveCount(2);
    const target = await eraseLines.first().evaluate((path: SVGPathElement) => {
      const length = path.getTotalLength();
      if (!length || !path.ownerSVGElement) return null;
      const local = path.getPointAtLength(length * 0.2);
      const point = path.ownerSVGElement.createSVGPoint();
      point.x = local.x;
      point.y = local.y;
      const matrix = path.getScreenCTM();
      if (!matrix) return null;
      const screen = point.matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    });
    if (!target) throw new Error('The shared boundary has no visible SVG target point');
    await page.mouse.click(target.x, target.y);
    await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(1);
    await expect(eraseLines).toHaveCount(0);
    await expect(modal.locator('[data-reparcel-status]')).toContainText(/no boundaries|boundary/i);
    await modal.locator('[data-reparcel-erase]').click();
    await expect(modal.locator('[data-reparcel-erase]')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Node editing removes a cut endpoint and Undo restores the split draft geometry', async ({ mockApi: page }) => {
    await openReadjustment(page);
    const modal = page.locator('.on-map-reparcellization');
    await modal.locator('label.reparcel-alg-option:has(input[value="manual"])').click();
    const nodes = modal.locator('[data-reparcel-nodes]');
    await expect(nodes).toHaveAttribute('aria-pressed', 'true');
    await nodes.click();
    await expect(nodes).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#map-container .reparcel-node-handle')).toHaveCount(0);
    await nodes.click();
    await expect(nodes).toHaveAttribute('aria-pressed', 'true');

    const rows = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row');
    const beforeSplit = await rows.count();
    await modal.locator('[data-reparcel-line]').click();
    const map = page.locator('#map-container');
    await expect(modal.locator('[data-reparcel-draw-toolbar]')).toBeVisible();
    for (const point of await visibleCutLineEndpoints(page)) await page.mouse.click(point.x, point.y);
    await expect(modal.locator('[data-reparcel-finish]')).toBeEnabled();
    await modal.locator('[data-reparcel-finish]').click();
    await expect.poll(() => rows.count()).toBeGreaterThan(beforeSplit);
    const splitPlotCount = await rows.count();

    const nodeHandles = map.locator('.reparcel-node-handle');
    await expect(nodeHandles).toHaveCount(2);
    const paths = page.locator('#map-container .leaflet-reparcelPlots-pane path.leaflet-interactive');
    const initialGeometry = await paths.evaluateAll(elements => elements.map(element => element.getAttribute('d')));
    await nodeHandles.first().click();
    const popup = page.locator('.reparcel-node-popup');
    await expect(popup).toBeVisible();
    await popup.getByRole('button', { name: 'Remove node' }).click();
    await expect(rows).toHaveCount(splitPlotCount - 1);
    await expect.poll(() => nodeHandles.count()).toBeLessThan(2);
    const editedGeometry = await paths.evaluateAll(elements => elements.map(element => element.getAttribute('d')));
    expect(editedGeometry).not.toEqual(initialGeometry);
    await expect(modal.locator('[data-reparcel-undo-edit]')).toBeEnabled();
    await modal.locator('[data-reparcel-undo-edit]').click();
    await expect(rows).toHaveCount(splitPlotCount);
    await expect(nodeHandles).toHaveCount(2);
    await expect.poll(() => paths.evaluateAll(elements => elements.map(element => element.getAttribute('d')))).toEqual(initialGeometry);
    // Undo is still enabled because the original split itself remains in the history. The first
    // undo restored the split after removing the node; it should not erase the earlier undo step.
    await expect(modal.locator('[data-reparcel-undo-edit]')).toBeEnabled();
  });

  test('All public reassigns every plot to the City and persists the draft result', async ({ mockApi: page }) => {
    await openReadjustment(page);
    const modal = await manualLayout(page);
    await modal.locator('[data-reparcel-assign]').click();
    const allPublic = modal.locator('[data-reparcel-all-public]');
    await expect(allPublic).toBeVisible();
    await allPublic.click();
    await expect(modal.locator('[data-reparcel-newplots-table]')).toContainText('Public land');
    await expect(modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row')).toHaveCount(2);
    await modal.locator('[data-reparcel-commit]').click();
    await expect(modal).toBeHidden();
    const polygons = await page.evaluate(() => (window as any).pendingReparcellizationPlan?.polygons);
    expect(polygons).toHaveLength(2);
    expect(polygons.every((plot: any) => plot.owners.length === 1 && plot.owners[0].ownerKey === 'public-land')).toBe(true);
  });

  test('Edit shares opens the recipient editor and Apply shares persists the selected plot split', async ({ mockApi: page }) => {
    await openReadjustment(page);
    const modal = await manualLayout(page);
    await modal.locator('[data-reparcel-assign]').click();
    await page.locator('#map-container .leaflet-reparcelPlots-pane path.leaflet-interactive').first().click();
    const popup = page.locator('.reparcel-owner-popup');
    await expect(popup).toBeVisible();
    await popup.getByRole('checkbox', { name: 'Owner A', exact: true }).check();
    await popup.getByRole('checkbox', { name: 'Public land', exact: true }).last().check();
    const ownerShare = popup.getByRole('spinbutton', { name: 'Owner A share (%)' });
    const publicShare = popup.getByRole('spinbutton', { name: 'Public land share (%)' });
    const ownerKey = await ownerShare.getAttribute('data-owner-key');
    const publicLandKey = await publicShare.getAttribute('data-owner-key');
    expect(ownerKey).toBeTruthy();
    expect(publicLandKey).toBe('public-land');
    await expect(ownerShare).toHaveValue('50');
    await expect(publicShare).toHaveValue('50');
    await popup.getByRole('button', { name: 'Apply shares', exact: true }).click();
    await expect(popup).toHaveCount(0);
    const firstPlot = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row').first();
    await expect(firstPlot).toContainText('50.0%');
    await firstPlot.getByRole('button', { name: 'Edit shares', exact: true }).click();
    const editor = page.locator('.reparcel-owner-popup');
    await expect(editor.getByRole('spinbutton', { name: 'Owner A share (%)' })).toHaveValue('50');
    await expect(editor.getByRole('spinbutton', { name: 'Public land share (%)' })).toHaveValue('50');
    await editor.getByRole('button', { name: 'Apply shares', exact: true }).click();
    await expect(editor).toHaveCount(0);

    const secondPlot = modal.locator('[data-reparcel-newplots-table] .reparcel-newplot-row').nth(1);
    await secondPlot.getByRole('button', { name: 'Edit shares', exact: true }).click();
    const secondEditor = page.locator('.reparcel-owner-popup');
    const secondOwner = secondEditor.getByRole('checkbox', { name: 'Owner A', exact: true });
    if (!(await secondOwner.isChecked())) await secondOwner.check();
    await secondEditor.getByRole('button', { name: 'Apply shares', exact: true }).click();
    await expect(secondEditor).toHaveCount(0);
    await expect(modal.locator('[data-reparcel-newplots-table]')).not.toContainText('Unassigned');
    await modal.locator('[data-reparcel-commit]').click();
    const polygons = await page.evaluate(() => (window as any).pendingReparcellizationPlan?.polygons);
    expect(polygons.some((plot: any) => plot.owners.length === 2
      && plot.owners.some((owner: any) => owner.ownerKey === ownerKey && owner.share === 0.5)
      && plot.owners.some((owner: any) => owner.ownerKey === 'public-land' && owner.share === 0.5))).toBe(true);
  });

  test('owner popup Close dismisses, and Use private-land proportions restores the joint shares', async ({ mockApi: page }) => {
    await openReadjustment(page);
    const modal = await manualLayout(page);
    await modal.locator('[data-reparcel-assign]').click();
    const boundary = page.locator('#map-container .leaflet-reparcelPlots-pane path.leaflet-interactive').first();
    await boundary.click();
    const popup = page.locator('.reparcel-owner-popup');
    await expect(popup).toBeVisible();
    await popup.locator('.reparcel-owner-popup__close').click();
    await expect(popup).toHaveCount(0);

    await boundary.click();
    await expect(popup).toBeVisible();
    await popup.getByRole('button', { name: 'Use private-land proportions', exact: true }).click();
    await expect(popup).toHaveCount(0);
    await modal.locator('[data-reparcel-commit]').click();
    const jointPlot = await page.evaluate(() => (window as any).pendingReparcellizationPlan?.polygons?.find((plot: any) => plot.jointPool));
    expect(jointPlot).toBeTruthy();
    expect(jointPlot.owners.length).toBeGreaterThan(0);
    expect(jointPlot.owners.every((owner: any) => owner.ownerKey !== 'public-land')).toBe(true);
    expect(jointPlot.owners.reduce((sum: number, owner: any) => sum + owner.share, 0)).toBeCloseTo(1, 8);
  });

  test('the building courtyard chooser applies the selected authored block', async ({ mockApi: page }) => {
    await openReadjustment(page);
    const modal = page.locator('.on-map-reparcellization');
    await modal.locator('label.reparcel-alg-option:has(input[value="amend"])').click();
    await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(1);
    await page.evaluate(() => {
      const ring = [[15.9819,45.8],[15.9825,45.8],[15.9825,45.8005],[15.9819,45.8005],[15.9819,45.8]];
      const hole = [[15.9821,45.8001],[15.9823,45.8001],[15.9823,45.8003],[15.9821,45.8003],[15.9821,45.8001]];
      for (const title of ['Courtyard candidate A', 'Courtyard candidate B']) {
        (window as any).proposalStorage.addProposal({
          title, goal: 'buildings', primaryType: 'Building', cadastreParcelIds: ['HR-335754-1234'], applied: false,
          buildingProposal: { parameters: { mode: 'block' } },
          geometry: { blockMassing: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring, hole.slice().reverse()] } } },
        });
      }
    });
    await modal.locator('[data-reparcel-courtyard-building]').click();
    const chooser = page.locator('.reparcel-owner-popup');
    await expect(chooser.getByRole('button', { name: 'Courtyard candidate A' })).toBeVisible();
    await chooser.getByRole('button', { name: 'Courtyard candidate B' }).click();
    await expect(chooser).toHaveCount(0);
    await expect(modal.locator('[data-reparcel-status]')).toContainText('Courtyard carved');
    await expect(modal.locator('.reparcel-newplot-row')).toHaveCount(2);
    await modal.locator('[data-reparcel-commit]').click();
    const derivation = await page.evaluate(() => (window as any).pendingReparcellizationPlan?.polygons.find((plot: any) => plot.jointPool)?.derivation);
    expect(derivation?.sourceTitle).toBe('Courtyard candidate B');
  });
});
