import { test, expect } from '../helpers/fixtures';

test.use({ seedCity: 'new_york' });

async function openEconomicSources(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#settings-button').click();
  const settings = page.locator('#settings-sheet');
  await expect(settings).toBeVisible();
  await settings.locator('details[data-section="economics"] > summary').click();
  await settings.locator('#economic-source-settings-button').click();
  await expect(page.locator('#economic-source-settings')).toBeVisible();
}

async function waitForApp(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).CityMoney && (window as any).CityConfigManager));
}

async function quietExternalMapSources(page: import('@playwright/test').Page): Promise<void> {
  for (const host of ['tile.openstreetmap.org', 'api.maptiler.com', 'overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee']) {
    await page.route(`https://${host}/**`, route => route.abort());
  }
}

async function reloadAfter(page: import('@playwright/test').Page, action: () => Promise<void>): Promise<void> {
  const loaded = page.waitForEvent('load');
  await action();
  await loaded;
  await waitForApp(page);
}

async function economicState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const w = window as any;
    const city = w.CityConfigManager.getCurrentCityConfig();
    const land = w.CityMoney.currentLandPriceOptions('land');
    const road = w.CityMoney.currentLandPriceOptions('road');
    const floor = w.CityMoney.currentFloorAreaPrices();
    return {
      cityId: city.id,
      currency: city.currency.code,
      land: land.areaPricePerSqm ?? null,
      landSource: land.economicSource,
      roadLand: road.areaPricePerSqm ?? null,
      sale: floor.sale.perSqm,
      construction: floor.construction.perSqm,
      saleSource: floor.sources.sale,
      constructionSource: floor.sources.construction,
      saved: localStorage.getItem('cb_economic_source:' + city.id)
    };
  });
}

test.describe('Valuation and costs sources @features', () => {
  test('opens from Settings and persists local rates with CityMoney provenance after reload', async ({ mockApi: page }) => {
    await quietExternalMapSources(page);
    await page.goto('/');
    await waitForApp(page);
    await openEconomicSources(page);

    const dialog = page.locator('#economic-source-settings');
    await expect(dialog.getByRole('heading', { name: 'Valuation & costs' })).toBeVisible();
    await dialog.locator('#economic-source-name').fill('Neighborhood scenario rates');
    await dialog.locator('#economic-rate-land').fill('321');
    await dialog.locator('#economic-rate-roadLand').fill('123');
    await dialog.locator('#economic-rate-sale').fill('6543');
    await dialog.locator('#economic-rate-construction').fill('2345');
    await reloadAfter(page, () => dialog.locator('button[form="economic-source-form"]').click());

    const state = await economicState(page);
    expect(state.cityId).toBe('new_york');
    expect(state.land).toBe(321);
    expect(state.roadLand).toBe(123);
    expect(state.sale).toBe(6543);
    expect(state.construction).toBe(2345);
    expect(state.landSource).toMatchObject({ sourceId: 'local-rates', sourceName: 'Neighborhood scenario rates', basis: 'assumption' });
    expect(state.saleSource).toMatchObject({ sourceId: 'local-rates', sourceName: 'Neighborhood scenario rates', basis: 'assumption' });
    expect(state.constructionSource).toMatchObject({ sourceId: 'local-rates', basis: 'assumption' });

    await openEconomicSources(page);
    await expect(page.locator('#economic-source-settings .economic-source-list')).toContainText('Neighborhood scenario rates');
    await expect(page.locator('#economic-source-settings .economic-source-list')).toContainText('Scenario assumption');
    await page.locator('#economic-source-settings .close-circle-btn').click();
    await expect(page.locator('#economic-source-settings')).toHaveCount(0);
  });

  test('keeps saved rates isolated to their city', async ({ mockApi: page }) => {
    await quietExternalMapSources(page);
    await page.goto('/');
    await waitForApp(page);
    await openEconomicSources(page);
    const dialog = page.locator('#economic-source-settings');
    await dialog.locator('#economic-source-name').fill('New York only');
    await dialog.locator('#economic-rate-land').fill('777');
    await reloadAfter(page, () => dialog.locator('button[form="economic-source-form"]').click());

    await page.evaluate(() => (window as any).CityConfigManager.setCurrentCityId('birmingham'));
    const birmingham = await economicState(page);
    expect(birmingham.cityId).toBe('birmingham');
    expect(birmingham.currency).toBe('GBP');
    expect(birmingham.land).not.toBe(777);
    expect(birmingham.landSource?.sourceId).not.toBe('local-rates');

    await page.evaluate(() => (window as any).CityConfigManager.setCurrentCityId('new_york'));
    expect((await economicState(page)).land).toBe(777);
  });

  test('reset removes the local source and restores configured rates', async ({ mockApi: page }) => {
    await quietExternalMapSources(page);
    await page.goto('/');
    await waitForApp(page);
    await openEconomicSources(page);
    let dialog = page.locator('#economic-source-settings');
    await dialog.locator('#economic-rate-land').fill('888');
    await reloadAfter(page, () => dialog.locator('button[form="economic-source-form"]').click());
    expect((await economicState(page)).land).toBe(888);

    await openEconomicSources(page);
    dialog = page.locator('#economic-source-settings');
    await reloadAfter(page, () => dialog.getByRole('button', { name: 'Use configured sources' }).click());
    const restored = await economicState(page);
    expect(restored.saved).toBeNull();
    expect(restored.land).toBeNull();
    expect(restored.sale).toBe(4000);
    expect(restored.construction).toBe(2000);
    expect(restored.saleSource).toMatchObject({ sourceId: 'scenario-assumptions', basis: 'assumption' });
  });

  test('imports dated market evidence and refuses a different currency without overwriting it', async ({ mockApi: page }) => {
    await quietExternalMapSources(page);
    await page.goto('/');
    await waitForApp(page);
    const currency = await page.evaluate(() => (window as any).CityMoney.currentCurrency());
    const marketSource = {
      version: 1, id: 'market-sales-sample', name: 'Sample market sales', adapter: 'rate-table',
      rates: [{ metric: 'sale', unit: 'm2-floor', amount: 7100, currency, basis: 'market', asOf: '2025-01-15' }],
    };
    await openEconomicSources(page);
    await reloadAfter(page, () => page.locator('#economic-source-file').setInputFiles({
      name: 'market-rates.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(marketSource)),
    }));
    const imported = await economicState(page);
    expect(imported.sale).toBe(7100);
    expect(imported.saleSource).toMatchObject({ sourceId: 'market-sales-sample', sourceName: 'Sample market sales', basis: 'market', asOf: '2025-01-15' });

    await openEconomicSources(page);
    const wrongCurrency = currency === 'USD' ? 'EUR' : 'USD';
    const invalidSource = {
      ...marketSource,
      id: 'wrong-currency',
      rates: [{ ...marketSource.rates[0], currency: wrongCurrency }],
    };
    await page.locator('#economic-source-file').setInputFiles({
      name: 'wrong-currency.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidSource)),
    });
    await expect(page.locator('#economic-source-settings [role="status"]')).toHaveText(/different currency/i);
    const retained = await economicState(page);
    expect(retained.saved).toContain('market-sales-sample');
    expect(retained.sale).toBe(7100);
    expect(retained.saleSource).toMatchObject({ basis: 'market', asOf: '2025-01-15' });
  });
});
