import { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sampleParcels } from './parcel-data';
import { surveyResponse } from './survey-data';
import { isApiDataRequest } from './api-routes';
import { ensurePageIndex } from './shared-server';

const backendRequire = createRequire(path.resolve(__dirname, '../../../backend/package.json'));
const turf = backendRequire('@turf/turf');

export const TEST_PARCEL_ID = 'HR-335754-1234';
const PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];
const line = {
  type: 'Feature', properties: { id: 701, name: 'Fixture street', highway: 'residential', highway_type: 'residential' },
  geometry: { type: 'LineString', coordinates: [[15.9820, 45.800225], [15.9824, 45.800225]] },
};
const roadArea = {
  type: 'Feature', properties: { OBJECTID: 801, SIFRA_VRSTE_UPORABE: '520', BROJ: '901', MATICNI_BROJ_KO: '335754' },
  geometry: { type: 'Polygon', coordinates: [[[15.9820,45.8001],[15.9824,45.8001],[15.9824,45.8004],[15.9820,45.8004],[15.9820,45.8001]]] },
};
const planArea = {
  type: 'Feature', properties: { plan_name: 'Fixture government road plan', plan_version: '1' },
  geometry: { type: 'Polygon', coordinates: [[[15.9820,45.80015],[15.98255,45.80015],[15.98255,45.80055],[15.9820,45.80055],[15.9820,45.80015]]] },
};

const existingBuildingFootprint = {
  type: 'Feature' as const,
  properties: { id: 'fixture-existing-building', height_m: 12, floors: 4 },
  // Inside the 387 m² 1237 fixture parcel so the real apply path can place the raised building
  // without crossing into the neighboring parcel or the road between fixture rows.
  geometry: { type: 'Polygon' as const, coordinates: [[[15.98207,45.80030],[15.98217,45.80030],[15.98217,45.80042],[15.98207,45.80042],[15.98207,45.80030]]] },
};

// The street parcel north of the block: the curated road classification names it, so it bounds the
// block instead of being one of its plots. It used to name 1234, the block's first plot, and Detect
// block from 1234 then depended on whether that classification had arrived yet.
export const FIXTURE_ROAD_PARCEL_ID = 'HR-335754-1239';
const roadParcel = {
  type: 'Feature' as const,
  properties: {
    parcelId: FIXTURE_ROAD_PARCEL_ID, parcel_number: '1239', parcel_id: FIXTURE_ROAD_PARCEL_ID, id: FIXTURE_ROAD_PARCEL_ID,
    cadastral_municipality: 'Trnje', maticni_broj_ko: '335754', area: 165,
    ownership_summary: { government: true, institution: false, company: false },
    owners: [{ name: 'REPUBLIKA HRVATSKA', share: '1/1' }],
    BROJ_CESTICE: '1239', ownershipList: [{ name: 'REPUBLIKA HRVATSKA', share: '1/1' }],
  },
  geometry: { type: 'Polygon' as const, coordinates: [[[15.98205,45.80055],[15.98235,45.80055],[15.98235,45.8006],[15.98205,45.8006],[15.98205,45.80055]]] },
};

export async function installLayerDatasets(page: Page): Promise<void> {
  const parcelFixtures = (requested?: Set<string>) => [...plotFixtures(requested), ...(!requested || requested.has(FIXTURE_ROAD_PARCEL_ID) ? [roadParcel] : [])];
  const plotFixtures = (requested?: Set<string>) => sampleParcels.features
    .filter(feature => !requested || requested.has(feature.properties.parcelId))
    .map(feature => {
      // Keep coordinates stable across the parcel-id batch request and later bbox refreshes.
      const fixtureIndex = Number(feature.properties.parcel_number) - 1234;
      const row = fixtureIndex < 3 ? 0 : 1;
      const column = row === 0 ? fixtureIndex : fixtureIndex - 3;
      // The first row consists of 43 m² plots and the second of 387 m² plots. Both rows form a
      // connected block around openCity's centre. A 100 m² min-plot rule therefore has real
      // excluded and buildable input parcels, while a crossing line still covers the narrow row.
      const width = row === 0 ? 0.0001 : 0.00015;
      const south = row === 0 ? 45.8002 : 45.80025;
      const height = row === 0 ? 0.00005 : 0.0003;
      const west = 15.98205 + column * width;
      const east = west + width, north = south + height;
    return {
      ...feature,
      properties: {
        ...feature.properties,
        BROJ_CESTICE: feature.properties.parcel_number,
        ownershipList: (() => {
          const ownersByNumber: Record<string, Array<{ name: string; share: string }>> = {
            '1234': [{ name: 'Fixture private owner A', share: '1/2' }, { name: 'Fixture private owner B', share: '1/2' }],
            '1235': [{ name: 'REPUBLIKA HRVATSKA', share: '1/1' }],
            '1236': [{ name: 'CRKVA SV. MARKA', share: '1/1' }],
            '1237': [{ name: 'Fixture d.o.o.', share: '1/1' }],
            '1238': [{ name: 'Fixture owner C', share: '1/1' }],
          };
          return ownersByNumber[feature.properties.parcel_number] || [];
        })(),
      },
      geometry: { type: 'Polygon' as const, coordinates: [[[west,south],[east,south],[east,north],[west,north],[west,south]]] },
    };
    });
  // Designs on this page bind against these fixture faces (POST /designs/binding and the index).
  (await ensurePageIndex(page)).cadastre = parcelFixtures();

  // Block detection expands the viewport through the same `/parcels?bbox=` API; return these
  // fixture faces there instead of mixing them with unrelated baseline polygons.
  await page.route('**/parcels**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/parcels/parcelIds')) return route.continue();
    if (url.pathname.endsWith('/parcels') && route.request().method() === 'GET') {
      return route.fulfill({ json: { type: 'FeatureCollection', features: parcelFixtures() } });
    }
    return route.continue();
  });
  await page.route('**/parcels/parcelIds**', async route => {
    const ids = new Set(new URL(route.request().url()).searchParams.get('ids')?.split(',') ?? []);
    await route.fulfill({ json: { type: 'FeatureCollection', features: parcelFixtures(ids) } });
  });

  await page.route('**/buildings**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    // This glob also matches the static /js/buildings*.js modules. Let scripts load normally;
    // Only serve fixtures for API data requests.
    if (!isApiDataRequest(request.url(), request.resourceType(), 'buildings')) return route.continue();
    const path = pathname;
    if (path.endsWith('/buildings/under') && request.method() === 'POST') {
      const body = request.postDataJSON() || {};
      const source = body.source || 'gdi';
      const footprints = [existingBuildingFootprint].map(feature => ({
        id: feature.properties.id,
        geometry: feature.geometry,
        height_m: feature.properties.height_m,
        floors: feature.properties.floors,
      }));
      const regions = Array.isArray(body.regions) ? body.regions : [];
      return route.fulfill({ json: {
        supported: true,
        source,
        truncated: false,
        regions: Object.fromEntries(regions.map((region: any) => [region.key,
          footprints.filter((footprint: any) => {
            if (!region?.geometry || !region.key) return false;
            return turf.booleanIntersects(turf.feature(region.geometry), turf.feature(footprint.geometry));
          })
        ])),
      } });
    }
    if (!/(?:^|\/)buildings(?:\/osm)?$/.test(pathname)) return route.continue();
    if (path.endsWith('/buildings/osm')) {
      return route.fulfill({ json: { type: 'FeatureCollection', source: 'osm', features: [{
        type: 'Feature', properties: { osm_id: 9003, building: 'yes' },
        geometry: { type: 'Polygon', coordinates: [[[15.98228,45.80008],[15.98242,45.80008],[15.98242,45.80022],[15.98228,45.80022],[15.98228,45.80008]]] },
      }] } });
    }
    const source = new URL(route.request().url()).searchParams.get('source');
    const properties = source === 'dgu'
      ? { zgrada_id: 9002, ZGRADA_ID: 9002, building_source: 'dgu' }
      : { object_id: 9001, height_m: 12, building_source: 'gdi' };
    await route.fulfill({ json: { source, ...surveyResponse([{
      type: 'Feature', properties,
      geometry: { type: 'Polygon', coordinates: [[[15.98208,45.80008],[15.98224,45.80008],[15.98224,45.80022],[15.98208,45.80022],[15.98208,45.80008]]] },
    }]) } });
  });
  await page.route('**/buildings/footprints', route => route.fulfill({ json: {
    supported: true,
    footprints: [{ ...existingBuildingFootprint, height_m: 12, floors: 4 }],
  } }));

  // Only the API: the glob also matches the app's own js/osm-roads-source.js.
  await page.route('**/osm-road**', route => {
    if (!isApiDataRequest(route.request().url(), route.request().resourceType(), 'osm-road')) return route.continue();
    return route.fulfill({ json: { type: 'FeatureCollection', features: [line] } });
  });
  await page.route('https://overpass-api.de/api/interpreter**', route => route.fulfill({ json: {
    version: 0.6,
    elements: [{ type: 'way', id: 702, tags: { highway: 'residential', name: 'Fixture street' }, geometry: [
      { lat: 45.800225, lon: 15.9820 }, { lat: 45.800225, lon: 15.9824 },
    ] }],
  } }));
  await page.route('https://services8.arcgis.com/**', route => route.fulfill({ json: { type: 'FeatureCollection', features: [line] } }));
  // Local development builds request the same GUP centreline data through the backend streets API.
  await page.route('**/streets**', route => route.fulfill({ json: { type: 'FeatureCollection', features: [line] } }));
  await page.route('https://oss.uredjenazemlja.hr/OssWebServices/wfs**', route => route.fulfill({ json: surveyResponse([roadArea]) }));
  // The development data source reads planned roads from the backend route, not the static plan
  // catalog. Both the planned-road API and survey APIs explicitly return EPSG:3765.
  await page.route('**/planned-road**', route => route.fulfill({ json: surveyResponse([planArea]) }));
  // Only the API: the glob also matches the app's own js/road-parcels.js.
  await page.route('**/road-parcels**', route => {
    if (!isApiDataRequest(route.request().url(), route.request().resourceType(), 'road-parcels')) return route.continue();
    return route.fulfill({ json: { ids: [FIXTURE_ROAD_PARCEL_ID], truncated: false } });
  });
  await page.route('**/js/plan.json', route => route.fulfill({ json: [{
    plan_name: 'E2E road plan', government_name: 'Fixture authority', plan_version: '1',
    'data source': '/e2e-road-plan.geojson',
    geometry: { type: 'Polygon', coordinates: [[[15.9819,45.7999],[15.9826,45.7999],[15.9826,45.8006],[15.9819,45.8006],[15.9819,45.7999]]] },
  }] }));
  await page.route('**/e2e-road-plan.geojson', route => route.fulfill({ json: { type: 'FeatureCollection', features: [planArea] } }));
  await page.route('**/ads?**', route => route.fulfill({ json: { items: [{
    parcel: {
      parcelId: TEST_PARCEL_ID, maticni_broj_ko: '335754', broj_cestice: '1234',
      geometry: sampleParcels.features[0].geometry,
    },
    ad: { url: 'https://example.invalid/fixture-ad' },
  }] } }));
}
