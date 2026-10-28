// Confirmed replacement from a named plan must frame every incoming member, even when its URL
// carries a stale off-site camera position.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { stubBasemapTiles, PARCEL_GEOMETRY } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';
import { fileDesign, filePlan, pageIndex } from '../helpers/mocks/shared-server';

const records = require('../../frontend/js/design-record.js');
const plans = require('../../frontend/js/plan-record.js');

test('confirmed named-plan replacement frames all incoming designs instead of the stale URL view', async ({ mockApi: page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 844 });
  await stubBasemapTiles(page);

  const index = pageIndex(page), ring = PARCEL_GEOMETRY.coordinates[0];
  const west = Math.min(...ring.map(point => point[0])), east = Math.max(...ring.map(point => point[0]));
  const south = Math.min(...ring.map(point => point[1])), north = Math.max(...ring.map(point => point[1]));
  const box = (w: number, s: number, e: number, n: number) => ({
    type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
  });
  const put = (record: any) => fileDesign(index, records.published({ city: 'zg', ...record }));
  const road = box(west + (east - west) * 0.44, south, west + (east - west) * 0.56, north);
  const oldRoad = put({ title: 'Standing campus road', goal: 'road-track', site: road,
    roadProposal: { definition: { polygon: road } }, createdAt: '2026-10-23T10:00:00Z' });
  const unrelatedParkGeometry = sampleParcels.features[1].geometry;
  const unrelatedPark = put({ title: 'Unrelated standing park', goal: 'park', site: unrelatedParkGeometry,
    structureProposal: { kind: 'park', geometry: unrelatedParkGeometry }, createdAt: '2026-10-23T11:00:00Z' });

  const buildingGeometry = box(west + (east - west) * 0.24, south + (north - south) * 0.1,
    west + (east - west) * 0.55, south + (north - south) * 0.48);
  const building = put({ title: 'Incoming campus building', goal: 'single', site: buildingGeometry,
    geometry: { buildings: [{ type: 'Feature', geometry: buildingGeometry,
      properties: { floors: 5, height: 15, type: 'proposedBuilding' } }] },
    buildingProposal: { typologyType: 'single', parameters: { floors: 5, height: 15 } }, createdAt: '2026-10-24T10:00:00Z' });
  const incomingParkGeometry = sampleParcels.features[2].geometry;
  const incomingPark = put({ title: 'Incoming separate garden', goal: 'park', site: incomingParkGeometry,
    structureProposal: { kind: 'park', geometry: incomingParkGeometry }, createdAt: '2026-10-24T11:00:00Z' });

  const planContent = plans.create('Campus replacement', [building, incomingPark], {
    at: '45.80025,15.9828,18', mode: '2d', city: 'zagreb', language: 'en'
  });
  const planCid = filePlan(index, planContent);
  const staleAt = [45.83, 16.15, 18];
  const applied = () => page.evaluate(() => {
    const w = window as any;
    return w.proposalStorage.getAllProposals().filter((proposal: any) => w.isApplied(proposal))
      .map((proposal: any) => w.DesignSync.publishedCid(proposal)).sort();
  });
  const original = [oldRoad, unrelatedPark].sort();
  const replacement = [building, incomingPark, unrelatedPark].sort();
  await page.goto(`/designs/${original.join(',')}?city=zg&lang=en&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(applied, { timeout: 30_000 }).toEqual(original);
  await page.goto(`/plans/${planCid}?city=zg&at=${staleAt.join(',')}&lang=en&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await expect.poll(applied, { timeout: 30_000 }).toEqual(original);

  const warning = page.getByRole('alertdialog', { name: 'Plan conflicts' });
  await expect(warning).toBeVisible({ timeout: 30_000 });
  await expect(warning).toContainText('Standing campus road');
  await expect(warning).not.toContainText('Unrelated standing park');
  await warning.getByRole('button', { name: 'Unapply existing & continue', exact: true }).click();
  await expect.poll(applied, { timeout: 30_000 }).toEqual(replacement);

  const framed = await page.evaluate(geometries => {
    const w = window as any, bounds = w.map.getBounds();
    const vertices: number[][] = [];
    const collect = (value: any): void => {
      if (Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every(Number.isFinite)) {
        vertices.push(value);
      } else if (Array.isArray(value)) value.forEach(collect);
    };
    geometries.forEach((geometry: any) => collect(geometry.coordinates));
    return {
      allIncomingVerticesVisible: vertices.length > 0 && vertices.every(([lng, lat]) => bounds.contains([lat, lng])),
      staleUrlViewVisible: bounds.contains([45.83, 16.15])
    };
  }, [buildingGeometry, incomingParkGeometry]);
  expect(framed.allIncomingVerticesVisible).toBe(true);
  expect(framed.staleUrlViewVisible).toBe(false);
});
