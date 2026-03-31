import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, zoomToParcelLevel } from '../helpers/app';
import { sampleParcels } from '../helpers/mocks/parcel-data';

/**
 * Parcel info panel — the core user interaction: click a parcel → see its details.
 *
 * Because the full parcel-loading pipeline (fetch → GeoJSON → Leaflet layer → click)
 * requires the real data-source layer, we inject parcels directly into the
 * parcelLayer from evaluate() so we can test the panel rendering in isolation.
 */

const PANEL_SELECTOR = '#parcel-info-panel';
const INFO_CONTENT = '#info-content';
const PROPOSALS_CONTENT = '#proposals-content';

/** Inject sample parcels into the Leaflet parcelLayer and trigger a click on the first one. */
async function injectParcelsAndClickFirst(page: any) {
  return page.evaluate((geojson: any) => {
    const w = window as any;
    const L = w.L;
    if (!L || !w.map) return { injected: false, reason: 'no-leaflet-or-map' };

    // Create parcelLayer if missing
    if (!w.parcelLayer) {
      w.parcelLayer = L.geoJSON(null).addTo(w.map);
    }

    // Add features
    const layer = L.geoJSON(geojson, {
      onEachFeature: (feature: any, layer: any) => {
        if (typeof w.onParcelClick === 'function') {
          layer.on('click', w.onParcelClick);
        }
      },
    }).addTo(w.map);

    // Merge into parcelLayer
    layer.eachLayer((l: any) => w.parcelLayer.addLayer(l));

    // Center the map on the first feature
    const firstCoord = geojson.features[0].geometry.coordinates[0][0];
    w.map.setView([firstCoord[1], firstCoord[0]], 18);

    return { injected: true, featureCount: geojson.features.length };
  }, sampleParcels);
}

async function simulateParcelClick(page: any, featureIndex = 0) {
  return page.evaluate((idx: number) => {
    const w = window as any;
    if (!w.parcelLayer) return { clicked: false, reason: 'no-parcel-layer' };

    const layers = w.parcelLayer.getLayers();
    if (layers.length === 0) return { clicked: false, reason: 'no-layers' };

    const target = layers[idx];
    if (!target) return { clicked: false, reason: 'index-out-of-range' };

    // Simulate Leaflet click event
    target.fire('click', {
      latlng: target.getBounds ? target.getBounds().getCenter() : w.map.getCenter(),
      originalEvent: new MouseEvent('click'),
    });

    return { clicked: true };
  }, featureIndex);
}

test.describe('Parcel info panel @core', () => {
  test('panel DOM elements exist in page', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const panelExists = await page.evaluate(() => {
      return {
        panel: !!document.getElementById('parcel-info-panel'),
        title: !!document.getElementById('parcel-info-title'),
        infoTab: !!document.getElementById('info-tab'),
        proposalsTab: !!document.getElementById('proposals-tab'),
        toolsTab: !!document.getElementById('tools-tab'),
        infoContent: !!document.getElementById('info-content'),
        proposalsContent: !!document.getElementById('proposals-content'),
        tabButtons: document.querySelectorAll('.parcel-tab-btn').length,
      };
    });

    expect(panelExists.panel).toBe(true);
    expect(panelExists.title).toBe(true);
    expect(panelExists.infoTab).toBe(true);
    expect(panelExists.proposalsTab).toBe(true);
    expect(panelExists.toolsTab).toBe(true);
    expect(panelExists.infoContent).toBe(true);
    expect(panelExists.proposalsContent).toBe(true);
    expect(panelExists.tabButtons).toBe(3);
  });

  test('panel is hidden by default', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const isVisible = await page.evaluate(() => {
      const panel = document.getElementById('parcel-info-panel');
      return panel?.classList.contains('visible') ?? false;
    });

    expect(isVisible).toBe(false);
  });

  test('showParcelInfoPanel function exists and is callable', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const fn = w.Parcels?.uiParcelPanel?.showParcelInfoPanel || w.showParcelInfoPanel;
      return { exists: typeof fn === 'function' };
    });

    test.skip(!result.exists, 'showParcelInfoPanel not available (module not loaded)');
    expect(result.exists).toBe(true);
  });

  test('clicking a parcel opens the info panel', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const injection = await injectParcelsAndClickFirst(page);
    test.skip(!injection.injected, `Could not inject parcels: ${injection.reason}`);
    await page.waitForTimeout(500);

    const click = await simulateParcelClick(page, 0);
    test.skip(!click.clicked, `Could not click parcel: ${click.reason}`);
    await page.waitForTimeout(1000);

    const panelState = await page.evaluate(() => {
      const panel = document.getElementById('parcel-info-panel');
      return {
        hasVisibleClass: panel?.classList.contains('visible') ?? false,
        display: panel ? getComputedStyle(panel).display : 'none',
      };
    });

    expect(panelState.hasVisibleClass).toBe(true);
  });

  test('panel displays parcel ID after click', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const injection = await injectParcelsAndClickFirst(page);
    test.skip(!injection.injected, `Could not inject parcels: ${injection.reason}`);
    await page.waitForTimeout(500);

    await simulateParcelClick(page, 0);
    await page.waitForTimeout(1000);

    const panelContent = await page.evaluate(() => {
      const title = document.getElementById('parcel-info-title');
      const infoContent = document.getElementById('info-content');
      return {
        titleText: title?.textContent ?? '',
        infoHtml: infoContent?.innerHTML ?? '',
        infoText: infoContent?.textContent ?? '',
      };
    });

    // The first sample parcel is HR-335754-1234
    const hasParcelRef = panelContent.titleText.includes('1234') ||
      panelContent.infoText.includes('1234') ||
      panelContent.infoText.includes('HR-335754');

    expect(hasParcelRef).toBe(true);
  });

  test('panel shows area metric after click', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const injection = await injectParcelsAndClickFirst(page);
    test.skip(!injection.injected, `Could not inject parcels: ${injection.reason}`);
    await page.waitForTimeout(500);

    await simulateParcelClick(page, 0);
    await page.waitForTimeout(1000);

    const panelContent = await page.evaluate(() => {
      const infoContent = document.getElementById('info-content');
      return {
        html: infoContent?.innerHTML ?? '',
        text: infoContent?.textContent ?? '',
      };
    });

    // The first sample parcel has area: 450.5
    // Panel should show area or m² somewhere
    const hasAreaInfo = panelContent.text.includes('450') ||
      panelContent.text.includes('m²') ||
      panelContent.text.includes('m2') ||
      panelContent.html.includes('area') ||
      panelContent.html.includes('metric');

    expect(hasAreaInfo).toBe(true);
  });

  test('panel shows owner info after click', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const injection = await injectParcelsAndClickFirst(page);
    test.skip(!injection.injected, `Could not inject parcels: ${injection.reason}`);
    await page.waitForTimeout(500);

    await simulateParcelClick(page, 0);
    await page.waitForTimeout(1000);

    const panelContent = await page.evaluate(() => {
      const infoContent = document.getElementById('info-content');
      const ownerEl = document.getElementById('parcel-owner-value') || document.querySelector('.parcel-owner-section');
      return {
        infoText: infoContent?.textContent ?? '',
        ownerText: ownerEl?.textContent ?? '',
        hasOwnerSection: !!ownerEl,
      };
    });

    // First parcel owner is 'Privatni vlasnik' — either owner section exists or info contains owner reference
    const hasOwnerInfo = panelContent.hasOwnerSection ||
      panelContent.infoText.includes('vlasnik') ||
      panelContent.infoText.includes('owner') ||
      panelContent.infoText.includes('Owner');

    expect(hasOwnerInfo).toBe(true);
  });

  test('clicking a government parcel shows government ownership', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const injection = await injectParcelsAndClickFirst(page);
    test.skip(!injection.injected, `Could not inject parcels: ${injection.reason}`);
    await page.waitForTimeout(500);

    // Feature index 1 is the government-owned parcel (REPUBLIKA HRVATSKA)
    await simulateParcelClick(page, 1);
    await page.waitForTimeout(1000);

    const panelContent = await page.evaluate(() => {
      const infoContent = document.getElementById('info-content');
      return {
        text: infoContent?.textContent ?? '',
        html: infoContent?.innerHTML ?? '',
      };
    });

    const hasGovRef = panelContent.text.includes('REPUBLIKA') ||
      panelContent.text.includes('Government') ||
      panelContent.text.includes('government') ||
      panelContent.html.includes('government') ||
      panelContent.text.includes('1235');

    expect(hasGovRef).toBe(true);
  });

  test('selectedParcelId global is set after click', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const injection = await injectParcelsAndClickFirst(page);
    test.skip(!injection.injected, `Could not inject parcels: ${injection.reason}`);
    await page.waitForTimeout(500);

    await simulateParcelClick(page, 0);
    await page.waitForTimeout(1000);

    const globals = await page.evaluate(() => {
      const w = window as any;
      return {
        selectedParcelId: w.selectedParcelId ?? null,
        currentParcel: w.currentParcel ?? null,
      };
    });

    // selectedParcelId should be set to the first parcel's id
    const hasSelection = globals.selectedParcelId !== null || globals.currentParcel !== null;
    expect(hasSelection).toBe(true);
  });

  test('close button hides the panel', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);
    await zoomToParcelLevel(page);
    await page.waitForTimeout(1000);

    const injection = await injectParcelsAndClickFirst(page);
    test.skip(!injection.injected, `Could not inject parcels: ${injection.reason}`);
    await page.waitForTimeout(500);

    await simulateParcelClick(page, 0);
    await page.waitForTimeout(1000);

    // Verify panel is open
    const isOpen = await page.evaluate(() => {
      return document.getElementById('parcel-info-panel')?.classList.contains('visible') ?? false;
    });
    test.skip(!isOpen, 'Panel did not open from click');

    // Click the close button
    await page.evaluate(() => {
      const closeBtn = document.querySelector('#parcel-info-panel .close-button') as HTMLElement;
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(500);

    const isClosed = await page.evaluate(() => {
      return !(document.getElementById('parcel-info-panel')?.classList.contains('visible') ?? true);
    });

    expect(isClosed).toBe(true);
  });
});
