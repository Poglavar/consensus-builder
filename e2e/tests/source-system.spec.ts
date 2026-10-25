import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';
import type { Page, Route } from '@playwright/test';

const contractModule = { exports: {} as any };
runInNewContext(readFileSync('../frontend/js/source-contracts.js', 'utf8'), { module: contractModule });
const SourceContracts = contractModule.exports;
const parcelsContract = SourceContracts.abstraction('parcels');
const parcelAdapters = {
  arcgis: SourceContracts.adapter('parcels', 'arcgis'),
  point: { ...SourceContracts.adapter('parcels', 'msda-point'), required: ['queryPoint'], methods: ['queryPoint'] },
};

function metadataFixture() {
  const adapters = [
    {
      ...parcelAdapters.arcgis,
      runtime: 'server',
      implementations: [{ runtime: 'server', required: parcelAdapters.arcgis.required, custom: true }],
      configSchema: { type: 'object', properties: { endpoint: { type: 'string' }, idField: { type: 'string' } } },
      example: { adapter: 'arcgis', endpoint: 'https://gis.example.test/FeatureServer/0', idField: 'PARCEL_ID' },
      contract: parcelAdapters.arcgis,
    },
    {
      ...parcelAdapters.point,
      runtime: 'server',
      implementations: [{ runtime: 'server', required: ['queryPoint'], custom: true }],
      configSchema: { type: 'object', properties: { endpoint: { type: 'string' }, queryMode: { const: 'point' } } },
      example: { adapter: 'msda-point', endpoint: 'https://registry.example.test/point', queryMode: 'point' },
      contract: parcelAdapters.point,
    },
  ];
  const sources = [
    { id: 'fixture-arcgis', abstraction: 'parcels', adapter: 'arcgis', kind: 'default', label: 'Fixture polygon parcels',
      config: { id: 'fixture-arcgis', endpoint: 'https://gis.example.test/FeatureServer/0', idField: 'PARCEL_ID' } },
    { id: 'fixture-point', abstraction: 'parcels', adapter: 'msda-point', kind: 'default', label: 'Fixture point parcels',
      config: { id: 'fixture-point', endpoint: 'https://registry.example.test/point', queryMode: 'point' } },
  ];
  sources.push({ ...sources[0], id: 'fixture-arcgis-other', label: 'Alternate polygon parcels', config: { ...sources[0].config, id: 'fixture-arcgis-other' } });
  const buildings = { id: 'buildings', registered: false, runtime: 'browser', contract: SourceContracts.abstraction('buildings'), adapters: [], sources: [] };
  const family = { id: 'parcels', registered: true, runtime: 'server', contract: parcelsContract, adapters, sources };
  return {
    catalogue: { schema: 'source-catalogue/v1', abstractions: [family, buildings] },
    contracts: { schema: 'source-contracts/v1', abstractions: [parcelsContract] },
  };
}

async function routeMetadata(page: Page, { failCatalogueOnce = false } = {}) {
  const fixture = metadataFixture();
  let catalogueRequests = 0;
  await page.route(url => url.pathname === '/source-system' || url.pathname === '/source-system/contracts', async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/source-system') {
      catalogueRequests += 1;
      if (failCatalogueOnce && catalogueRequests === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture unavailable' }) });
        return;
      }
      await route.fulfill({ json: fixture.catalogue });
      return;
    }
    await route.fulfill({ json: fixture.contracts });
  });
  return { fixture, catalogueRequests: () => catalogueRequests };
}

test.describe('Sources and adapters explorer @features', () => {
  test('Settings link carries the resolved backend into Sources & adapters', async ({ mockApi: page }) => {
    await routeMetadata(page);
    await openCity(page);
    const backend = await page.evaluate(() => (window as any).getBackendBase());
    await page.locator('#settings-button').click();
    const sourcesSection = page.locator('#settings-sheet details.accordion-section[data-section="sources"]');
    await sourcesSection.locator(':scope > summary').click();
    const link = page.locator('#source-system-link');
    await expect(link).toBeVisible();
    await Promise.all([
      page.waitForURL(url => url.pathname.endsWith('/sources.html')),
      link.click(),
    ]);
    expect(new URL(page.url()).searchParams.get('backend')).toBe(backend);
    await expect(page.locator('#source-api-base')).toHaveText(backend);
    await expect(page.locator('#source-status')).toContainText('2 abstractions · 3 registered sources');
  });

  test('loads source contracts, switches adapters and sources, and translates the static explorer labels', async ({ mockApi: page }) => {
    await routeMetadata(page);
    const backend = 'http://metadata.fixture.test:3000';
    await page.goto(`/sources.html?backend=${encodeURIComponent(backend)}&abstraction=parcels&adapter=arcgis&source=fixture-arcgis`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.locator('#source-status')).toContainText('2 abstractions · 3 registered sources');
    await expect(page.locator('#source-content')).toBeVisible();
    await expect(page.locator('#source-family')).toHaveValue('parcels');
    await expect(page.locator('#source-adapter')).toHaveValue('arcgis');
    await expect(page.locator('#source-config')).toHaveValue('fixture-arcgis');
    await expect(page.locator('#source-config-json')).toContainText('"kind": "default"');
    await expect(page.locator('#source-config-schema-json')).toContainText('"endpoint"');
    await expect(page.locator('#source-example-json')).toContainText('FeatureServer/0');
    await expect(page.locator('#source-operations article h3')).toContainText(['queryBounds', 'queryIds', 'queryGeometry']);

    await selectNativeOption(page.locator('#source-config'), 'fixture-arcgis-other');
    await expect(page.locator('#source-config-json')).toContainText('Alternate polygon parcels');
    await selectNativeOption(page.locator('#source-family'), 'buildings');
    await expect(page.locator('#source-adapter')).toBeDisabled();
    await selectNativeOption(page.locator('#source-family'), 'parcels');
    await expect(page.locator('#source-adapter')).toBeEnabled();
    await selectNativeOption(page.locator('#source-adapter'), 'msda-point');
    await expect(page.locator('#source-config')).toHaveValue('fixture-point');
    await expect(page.locator('#source-config-json')).toContainText('"id": "fixture-point"');
    await expect(page.locator('#source-example-json')).toContainText('"queryMode": "point"');
    await expect(page.locator('#source-operations article h3')).toHaveText(['queryPoint']);

    await selectNativeOption(page.locator('#source-language'), 'hr');
    await expect(page.locator('h1[data-i18n-key="sourceSystem.title"]')).toHaveText('Izvori i adapteri');
    await expect(page.locator('label[for="source-family"]')).toHaveText('Apstrakcija');
    await expect(page.locator('#source-config-title')).toHaveText('Konfiguracija registriranog izvora');
    const downloaded = page.waitForEvent('download');
    await page.locator('#source-download').click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('source-contracts.v1.json');
    expect(JSON.parse(readFileSync((await download.path())!, 'utf8'))).toEqual(metadataFixture().contracts);
  });

  test('keeps a failed metadata load visibly failed and Retry loads the configured sources', async ({ mockApi: page }) => {
    const { catalogueRequests } = await routeMetadata(page, { failCatalogueOnce: true });
    const backend = 'http://metadata.fixture.test:3000';
    await page.goto(`/sources.html?backend=${encodeURIComponent(backend)}`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#source-status')).toContainText('Source metadata is unavailable: HTTP 503');
    await expect(page.locator('#source-retry')).toBeVisible();
    await expect(page.locator('#source-content')).toBeHidden();
    await expect(page.locator('#source-download')).toBeDisabled();
    expect(catalogueRequests()).toBe(1);

    await page.locator('#source-retry').click();
    await expect(page.locator('#source-status')).toContainText('2 abstractions · 3 registered sources');
    await expect(page.locator('#source-content')).toBeVisible();
    await expect(page.locator('#source-retry')).toBeHidden();
    expect(catalogueRequests()).toBe(2);
  });
});
