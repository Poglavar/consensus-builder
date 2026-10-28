// A park, square or lake takes an uploaded GLB through the building upload pipeline: model wording,
// a real footprint, and the structure record built from it at a point on the site.
import { readFileSync } from 'node:fs';
import { test, expect } from '../helpers/fixtures';

const index = readFileSync('../frontend/index.html', 'utf8');
const bootstrap = index.slice(index.indexOf('<script type="importmap">'), index.indexOf('// 2D-coupled files'));
const scripts = bootstrap.slice(0, bootstrap.lastIndexOf('<script>'));
const model = readFileSync('../test-assets/test-building.glb');

test('uploads a GLB for a park and builds its structure record from the model footprint', async ({ page }) => {
  let uploaded: any;
  await page.route('**/models', async route => {
    uploaded = route.request().postDataJSON();
    await route.fulfill({ json: { modelUrl: '/uploads/models/park.glb' } });
  });
  await page.route('**/upload-test', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/primitives.css"><link rel="stylesheet" href="/css/modals.css">${scripts}</head><body></body></html>` }));
  await page.goto('/upload-test');
  for (const url of ['/vendor/turf-6.5.0/turf.min.js', '/vendor/proj4-2.22.0/proj4.js', '/js/ui/busy-control.js', '/js/metric-frame.js',
    '/js/single-building-geometry.js', '/js/proposals/apply/structures.js',
    '/js/building-model-geometry.js', '/js/building-upload.js']) {
    await page.addScriptTag({ url });
  }
  await page.evaluate(async () => {
    const w = window as any;
    await w.whenThreeReady();
    w.getBackendBase = () => location.origin;
    // A site around Zagreb's centre; the model is placed at a point on it.
    const site = { type: 'MultiPolygon', coordinates: [[[[15.976, 45.812], [15.978, 45.812], [15.978, 45.813], [15.976, 45.813], [15.976, 45.812]]]] };
    w.BuildingUpload.open({ kind: 'park' }, {
      onUse: async (upload: any) => {
        const api = w.ProposalApplyStructures;
        const geometry = api.structureModelGeometry(upload.footprint, site,
          { turf: w.turf, placeModelFootprint: w.SingleBuildingGeometry.placeModelFootprint });
        w.createdStructure = api.structureFromModelUpload('park', geometry, upload);
        w.createdArea = w.turf.area(geometry);
        w.createdInside = w.turf.booleanPointInPolygon(w.turf.centroid(geometry), site);
        return !!w.createdStructure;
      }
    });
  });

  await expect(page.locator('#building-upload-title')).toHaveText('Upload a model');
  await expect(page.locator('#building-upload-confirm')).toHaveText('Use this model');
  await page.locator('#building-upload-file').setInputFiles('../test-assets/test-building.glb');
  await expect(page.locator('#building-upload-confirm')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#building-upload-confirm').click();
  await expect(page.locator('#building-upload-modal')).toHaveCount(0);

  expect(uploaded.fileName).toBe('test-building.glb');
  expect(Buffer.from(uploaded.modelData.split(',')[1], 'base64')).toEqual(model);
  const result = await page.evaluate(() => {
    const w = window as any;
    return { structure: w.createdStructure, area: w.createdArea, inside: w.createdInside };
  });
  expect(result.structure).toMatchObject({
    modelUrl: '/uploads/models/park.glb', modelName: 'test-building.glb', rotation: 0, source: 'upload',
    geometry: { type: 'Polygon' },
    decorationDesign: { trees: [], flowerbeds: [], ponds: [], paths: [], benches: [], version: 3 }
  });
  // test-building.glb is 16 m × 20 m on the ground.
  expect(result.area).toBeGreaterThan(300);
  expect(result.area).toBeLessThan(330);
  expect(result.inside).toBe(true);
});
