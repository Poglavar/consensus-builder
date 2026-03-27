import { Page } from '@playwright/test';
import { sampleParcels } from './parcel-data';
import { sampleProposalsList, makeRoadProposal } from './proposal-data';

/**
 * Install mock route handlers for all backend API endpoints.
 * Call this before navigating to the page.
 */
export async function mockAllApiRoutes(page: Page): Promise<void> {
  await mockHealthRoute(page);
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

export async function mockParcelsRoute(page: Page): Promise<void> {
  await page.route('**/parcels**', (route) => {
    const url = route.request().url();
    // Return parcel data for any parcel request
    if (route.request().method() === 'GET') {
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
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sampleProposalsList),
      });
    } else if (route.request().method() === 'POST') {
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

export async function mockBuildingsRoute(page: Page): Promise<void> {
  await page.route('**/buildings**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
    });
  });
}

export async function mockPlannedRoadsRoute(page: Page): Promise<void> {
  await page.route('**/planned-roads**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
    });
  });
}

export async function mockStreetsRoute(page: Page): Promise<void> {
  await page.route('**/streets**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
    });
  });
}
