import { Page } from '@playwright/test';
import { sampleParcels } from './parcel-data';
import { sampleProposalsList, makeRoadProposal } from './proposal-data';

const isApiDataRequest = (pageUrl: string, resourceType: string, endpoint: string): boolean => {
  if (resourceType !== 'fetch' && resourceType !== 'xhr') {
    return false;
  }

  const pathname = new URL(pageUrl).pathname;
  if (pathname.startsWith('/js/') || pathname.startsWith('/css/') || pathname.startsWith('/i18n/')) {
    return false;
  }

  return pathname === `/${endpoint}`
    || pathname.endsWith(`/${endpoint}`)
    || pathname.includes(`/${endpoint}/`);
};

const sampleAreaMonitorDetail = {
  monitor: {
    id: 1,
    name: 'Zapadni Jarunski Most',
    cityId: 'zagreb',
    eojnUrl: 'https://example.com/eojn/jarun',
    skyscraperCityUrl: 'https://example.com/forum/jarun',
    createdAt: '2026-03-27T00:10:40.993Z',
    updatedAt: '2026-03-27T00:10:40.993Z',
  },
  parcels: [
    { parcelId: 'HR-339318-7396', ownershipType: 'government' },
    { parcelId: 'HR-339318-7398', ownershipType: null },
    { parcelId: 'HR-339318-7400', ownershipType: 'private individual' },
  ],
  summary: {
    total: 3,
    governmentOwned: 1,
    remaining: 2,
  },
};

const sampleAreaMonitorsList = {
  monitors: [
    {
      id: 1,
      name: 'Zapadni Jarunski Most',
      parcelCount: 3,
      createdAt: '2026-03-27T00:10:40.993Z',
      updatedAt: '2026-03-27T00:10:40.993Z',
    },
    {
      id: 2,
      name: 'Vukovarska Corridor',
      parcelCount: 5,
      createdAt: '2026-03-28T08:15:00.000Z',
      updatedAt: '2026-03-28T09:45:00.000Z',
    },
  ],
};

/**
 * Install mock route handlers for all backend API endpoints.
 * Call this before navigating to the page.
 */
export async function mockAllApiRoutes(page: Page): Promise<void> {
  await mockHealthRoute(page);
  await mockAreaMonitorsRoute(page);
  await mockParcelsRoute(page);
  await mockProposalsRoute(page);
  await mockBuildingsRoute(page);
  await mockPlannedRoadsRoute(page);
  await mockStreetsRoute(page);
}

export async function mockHealthRoute(page: Page): Promise<void> {
  await page.route('**/health', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    });
  });
}

export async function mockAreaMonitorsRoute(page: Page): Promise<void> {
  await page.route('**/area-monitors**', (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());

    if (!isApiDataRequest(request.url(), request.resourceType(), 'area-monitors')) {
      route.continue();
      return;
    }

    if (method === 'GET' && /\/area-monitors\/1$/.test(url.pathname)) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleAreaMonitorDetail),
      });
      return;
    }

    if (method === 'GET' && /\/area-monitors$/.test(url.pathname)) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleAreaMonitorsList),
      });
      return;
    }

    if (method === 'HEAD' && /\/area-monitors\/1$/.test(url.pathname)) {
      route.fulfill({ status: 200, body: '' });
      return;
    }

    route.continue();
  });
}

export async function mockParcelsRoute(page: Page): Promise<void> {
  await page.route('**/parcels**', (route) => {
    const request = route.request();
    if (!isApiDataRequest(request.url(), request.resourceType(), 'parcels')) {
      route.continue();
      return;
    }

    // Return parcel data for any parcel request
    if (request.method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleParcels),
      });
    } else {
      route.continue();
    }
  });
}

export async function mockProposalsRoute(page: Page): Promise<void> {
  await page.route('**/proposals**', (route) => {
    const request = route.request();
    if (!isApiDataRequest(request.url(), request.resourceType(), 'proposals')) {
      route.continue();
      return;
    }

    if (request.method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleProposalsList),
      });
    } else if (request.method() === 'POST') {
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(makeRoadProposal()),
      });
    } else {
      route.continue();
    }
  });
}

// Covers both surveys: ?source=gdi (the working set, object_id) and ?source=dgu (the cadastre
// reference layer). `truncated: false` says the bbox is fully covered.
export async function mockBuildingsRoute(page: Page): Promise<void> {
  await page.route('**/buildings**', (route) => {
    const request = route.request();
    if (!isApiDataRequest(request.url(), request.resourceType(), 'buildings')) {
      route.continue();
      return;
    }

    const source = new URL(request.url()).searchParams.get('source') || 'gdi';
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [], source, truncated: false }),
    });
  });
}

export async function mockPlannedRoadsRoute(page: Page): Promise<void> {
  await page.route('**/planned-road**', (route) => {
    const request = route.request();
    if (!isApiDataRequest(request.url(), request.resourceType(), 'planned-road')) {
      route.continue();
      return;
    }

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
    });
  });
}

export async function mockStreetsRoute(page: Page): Promise<void> {
  await page.route('**/streets**', (route) => {
    const request = route.request();
    if (!isApiDataRequest(request.url(), request.resourceType(), 'streets')) {
      route.continue();
      return;
    }

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
    });
  });
}
