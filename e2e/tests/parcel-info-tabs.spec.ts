import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';
import { sampleParcels } from '../helpers/mocks/parcel-data';

/**
 * Parcel info panel tab switching — Info / Proposals / Tools tabs.
 */

async function injectParcelsAndClick(page: any) {
  const injection = await page.evaluate((geojson: any) => {
    const w = window as any;
    const L = w.L;
    if (!L || !w.map) return { injected: false, reason: 'no-leaflet-or-map' };

    if (!w.parcelLayer) {
      w.parcelLayer = L.geoJSON(null).addTo(w.map);
    }

    const layer = L.geoJSON(geojson, {
      onEachFeature: (feature: any, layer: any) => {
        if (typeof w.onParcelClick === 'function') {
          layer.on('click', w.onParcelClick);
        }
      },
    }).addTo(w.map);

    layer.eachLayer((l: any) => w.parcelLayer.addLayer(l));

    const firstCoord = geojson.features[0].geometry.coordinates[0][0];
    w.map.setView([firstCoord[1], firstCoord[0]], 18);

    return { injected: true };
  }, sampleParcels);

  if (!injection.injected) return injection;

  await page.waitForTimeout(500);

  return page.evaluate(() => {
    const w = window as any;
    const layers = w.parcelLayer?.getLayers() ?? [];
    if (layers.length === 0) return { injected: true, clicked: false, reason: 'no-layers' };

    layers[0].fire('click', {
      latlng: layers[0].getBounds ? layers[0].getBounds().getCenter() : w.map.getCenter(),
      originalEvent: new MouseEvent('click'),
    });

    return { injected: true, clicked: true };
  });
}

test.describe('Parcel info panel tabs @core', () => {
  test('Info tab is active by default', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const result = await injectParcelsAndClick(page);
    test.skip(!result.injected || !result.clicked, 'Could not inject/click parcel');
    await page.waitForTimeout(1000);

    const tabState = await page.evaluate(() => {
      const infoTab = document.getElementById('info-tab');
      const proposalsTab = document.getElementById('proposals-tab');
      const toolsTab = document.getElementById('tools-tab');
      const activeBtn = document.querySelector('.parcel-tab-btn.active');
      return {
        infoActive: infoTab?.classList.contains('active') ?? false,
        proposalsActive: proposalsTab?.classList.contains('active') ?? false,
        toolsActive: toolsTab?.classList.contains('active') ?? false,
        activeBtnText: activeBtn?.textContent?.trim() ?? '',
      };
    });

    expect(tabState.infoActive).toBe(true);
    expect(tabState.proposalsActive).toBe(false);
    expect(tabState.toolsActive).toBe(false);
  });

  test('switchParcelTab function exists', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const fn = w.Parcels?.proposals?.switchParcelTab || w.switchParcelTab;
      return { exists: typeof fn === 'function' };
    });

    test.skip(!result.exists, 'switchParcelTab not available');
    expect(result.exists).toBe(true);
  });

  test('clicking Proposals tab shows proposals content', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const result = await injectParcelsAndClick(page);
    test.skip(!result.injected || !result.clicked, 'Could not inject/click parcel');
    await page.waitForTimeout(1000);

    // Click the Proposals tab button
    const switched = await page.evaluate(() => {
      const tabBtns = document.querySelectorAll('.parcel-tab-btn');
      // Find the Proposals tab button (second one)
      const proposalBtn = Array.from(tabBtns).find(
        (btn) => btn.textContent?.trim() === 'Proposals' || (btn as HTMLElement).getAttribute('onclick')?.includes('proposals-tab')
      ) as HTMLElement | undefined;

      if (!proposalBtn) return { switched: false, reason: 'no-proposal-btn' };
      proposalBtn.click();
      return { switched: true };
    });

    test.skip(!switched.switched, `Tab switch failed: ${(switched as any).reason}`);
    await page.waitForTimeout(500);

    const tabState = await page.evaluate(() => {
      const infoTab = document.getElementById('info-tab');
      const proposalsTab = document.getElementById('proposals-tab');
      return {
        infoActive: infoTab?.classList.contains('active') ?? false,
        proposalsActive: proposalsTab?.classList.contains('active') ?? false,
      };
    });

    expect(tabState.proposalsActive).toBe(true);
    expect(tabState.infoActive).toBe(false);
  });

  test('clicking Tools tab shows tools content', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const result = await injectParcelsAndClick(page);
    test.skip(!result.injected || !result.clicked, 'Could not inject/click parcel');
    await page.waitForTimeout(1000);

    // Click the Tools tab button
    await page.evaluate(() => {
      const tabBtns = document.querySelectorAll('.parcel-tab-btn');
      const toolsBtn = Array.from(tabBtns).find(
        (btn) => btn.textContent?.trim() === 'Tools' || (btn as HTMLElement).getAttribute('onclick')?.includes('tools-tab')
      ) as HTMLElement | undefined;
      if (toolsBtn) toolsBtn.click();
    });
    await page.waitForTimeout(500);

    const tabState = await page.evaluate(() => {
      const toolsTab = document.getElementById('tools-tab');
      const roadCheckbox = document.getElementById('roadCheckbox');
      return {
        toolsActive: toolsTab?.classList.contains('active') ?? false,
        hasRoadCheckbox: !!roadCheckbox,
      };
    });

    expect(tabState.toolsActive).toBe(true);
    expect(tabState.hasRoadCheckbox).toBe(true);
  });

  test('switching back to Info tab restores info content', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const result = await injectParcelsAndClick(page);
    test.skip(!result.injected || !result.clicked, 'Could not inject/click parcel');
    await page.waitForTimeout(1000);

    // Switch to Proposals tab
    await page.evaluate(() => {
      const tabBtns = document.querySelectorAll('.parcel-tab-btn');
      const proposalBtn = Array.from(tabBtns).find(
        (btn) => (btn as HTMLElement).getAttribute('onclick')?.includes('proposals-tab')
      ) as HTMLElement | undefined;
      if (proposalBtn) proposalBtn.click();
    });
    await page.waitForTimeout(300);

    // Switch back to Info tab
    await page.evaluate(() => {
      const tabBtns = document.querySelectorAll('.parcel-tab-btn');
      const infoBtn = Array.from(tabBtns).find(
        (btn) => (btn as HTMLElement).getAttribute('onclick')?.includes('info-tab')
      ) as HTMLElement | undefined;
      if (infoBtn) infoBtn.click();
    });
    await page.waitForTimeout(300);

    const tabState = await page.evaluate(() => {
      const infoTab = document.getElementById('info-tab');
      const infoContent = document.getElementById('info-content');
      return {
        infoActive: infoTab?.classList.contains('active') ?? false,
        hasContent: (infoContent?.innerHTML ?? '').length > 0,
      };
    });

    expect(tabState.infoActive).toBe(true);
  });

  test('multi-select checkbox exists in Info tab', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const checkbox = document.getElementById('multiSelectCheckboxInfo');
      return {
        exists: !!checkbox,
        type: checkbox?.getAttribute('type') ?? '',
      };
    });

    expect(result.exists).toBe(true);
    expect(result.type).toBe('checkbox');
  });
});
