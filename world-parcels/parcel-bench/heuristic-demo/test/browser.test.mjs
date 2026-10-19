// Purpose: exercise the prepared parcel demo in a real headless browser, including worker export and phone-sized controls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createDemoServer } from '../server.mjs';

const require = createRequire(new URL('../../../../e2e/package.json', import.meta.url));
const { chromium } = require('playwright');

const EXAMPLES = [
  { id: 'magoanine-c-west-houses', title: 'Magoanine C west houses', lon: [32.4, 32.8], lat: [-26.1, -25.6] },
  { id: 'baniyataar-houses-and-fields', title: 'Baniyataar houses and fields', lon: [85.1, 85.6], lat: [27.5, 28.0] },
  { id: 'zadar-tile-2582-31827', title: 'Zadar', lon: [14.8, 15.8], lat: [43.5, 44.5] },
];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

async function waitReady(page, title) {
  await page.waitForFunction(expected => {
    const status = document.querySelector('#status');
    return status?.dataset.tone === 'error' || (document.querySelector('#place')?.textContent === expected
      && document.querySelector('#export')?.disabled === false
      && status?.textContent.startsWith('Ready.'));
  }, title, { timeout: 30_000 });
  const state = await page.locator('#status').evaluate(element => ({ tone: element.dataset.tone, text: element.textContent }));
  assert.notEqual(state.tone, 'error', `demo processing failed: ${state.text}`);
}

async function exportCollection(page, sampleId) {
  const pending = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('#export').click();
  const download = await pending;
  assert.equal(await download.failure(), null, 'worker export should complete');
  const file = await download.path();
  assert(file, 'GeoJSON download should have a local file');
  const collection = JSON.parse(await readFile(file, 'utf8'));
  const reviewDir = '/tmp/heuristic-demo-exports';
  await mkdir(reviewDir, { recursive: true });
  await copyFile(file, `${reviewDir}/${sampleId}.geojson`);
  return collection;
}

function assertGeoJson(collection, example) {
  assert.equal(collection.type, 'FeatureCollection');
  assert(collection.features.length > 0, 'export contains plot polygons');
  assert.equal(collection.demo.schema, 'illustrative-plots-v1');
  const positions = collection.features.flatMap(feature => feature.geometry.coordinates.flat(2));
  assert(positions.length > 0, 'export contains polygon coordinates');
  for (const [lon, lat] of positions) {
    assert(Number.isFinite(lon) && Number.isFinite(lat), 'projected export coordinate is finite');
    assert(lon >= example.lon[0] && lon <= example.lon[1], `longitude ${lon} is within ${example.title}`);
    assert(lat >= example.lat[0] && lat <= example.lat[1], `latitude ${lat} is within ${example.title}`);
  }
}

async function tapImagePoint(page, x, y) {
  const viewer = page.locator('#viewer');
  const box = await viewer.boundingBox();
  const viewBox = (await viewer.getAttribute('viewBox')).split(/\s+/).map(Number);
  const [vx, vy, vw, vh] = viewBox;
  await viewer.click({ position: { x: (x - vx) / vw * box.width, y: (y - vy) / vh * box.height } });
}

function insideRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToLine(point, points) {
  let distance = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1], [bx, by] = points[i], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    distance = Math.min(distance, Math.hypot(point[0] - ax - t * dx, point[1] - ay - t * dy));
  }
  return distance;
}

function chooseOpenPoint(sample, avoid) {
  const blockedByPolygon = point => ['buildings', 'water'].some(kind => sample.features[kind].some(feature => {
    const [outer, ...holes] = feature.rings;
    return insideRing(point, outer) && !holes.some(hole => insideRing(point, hole));
  }));
  const blockedByLine = point => ['roads', 'waterways'].some(kind => sample.features[kind].some(line =>
    distanceToLine(point, line.points) < Math.max(4, (line.width_m || 0) * sample.width / (sample.bbox[2] - sample.bbox[0]) / 2 + 2)));
  for (let y = 32; y < sample.height - 32; y += 32) for (let x = 32; x < sample.width - 32; x += 32) {
    if (Math.hypot(x - avoid[0], y - avoid[1]) < 80) continue;
    if (!blockedByPolygon([x, y]) && !blockedByLine([x, y])) return [x, y];
  }
  throw new Error(`No candidate open-ground point found for ${sample.id}`);
}

test('prepared locations load, export projected polygons, and remain editable on narrow screens', async () => {
  const server = createDemoServer();
  const baseUrl = await listen(server);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [], externalRequests = [], exportedStats = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const allowedOrigin = new URL(baseUrl).origin;
    page.on('request', request => {
      const url = request.url();
      if (url.startsWith('blob:') || url.startsWith('data:')) return;
      if (new URL(url).origin !== allowedOrigin) externalRequests.push(url);
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    for (const example of EXAMPLES) {
      await page.locator('#location').selectOption(example.id);
      await waitReady(page, example.title);
      assert.equal(await page.locator('#status').getAttribute('data-tone'), 'ready');
      assert.equal(await page.locator('#add-seed').isEnabled(), true);
      assert.equal(await page.locator('#export').isEnabled(), true);
      const collection = await exportCollection(page, example.id);
      assertGeoJson(collection, example);
      exportedStats.push({ id: example.id, plots: collection.demo.stats.plots, buildings: collection.demo.stats.buildingSeeds,
        generatedSeeds: collection.demo.stats.generatedSeeds, features: collection.features.length });
    }

    // Change a real worker control, then persist a manual seed across a reload and undo a later edit.
    const sensitivity = page.locator('#sensitivity');
    await sensitivity.evaluate(element => {
      element.value = '88';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitReady(page, 'Zadar');
    const changedSettings = await exportCollection(page, 'zadar-slider-88');
    assert.equal(changedSettings.demo.settings.sensitivity, 88, 'the slider value reaches worker output');

    await page.locator('#location').selectOption('magoanine-c-west-houses');
    await waitReady(page, 'Magoanine C west houses');
    const bundle = JSON.parse(await readFile(new URL('../../output/heuristic-demo-v1/bundle.json', import.meta.url), 'utf8'));
    const mozambique = bundle.samples.find(sample => sample.id === 'magoanine-c-west-houses');
    await page.locator('#add-seed').click();
    await tapImagePoint(page, 300, 300);
    await waitReady(page, 'Magoanine C west houses');
    const saved = await page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith('browser-heuristic-v1:'))
      .map(([key, value]) => ({ key, value: JSON.parse(value) })));
    const savedEntry = saved.find(entry => entry.value.edits.seeds.length === 1);
    assert(savedEntry, 'one manual seed is stored in this browser');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitReady(page, 'Magoanine C west houses');
    assert.equal(await page.locator('#viewer .manual-point').count(), 1, 'the saved correction is restored in the overlay');
    assert.equal(await page.locator('#undo').isEnabled(), false, 'undo history starts fresh after reload');
    await page.locator('#add-seed').click();
    const secondPoint = chooseOpenPoint(mozambique, savedEntry.value.edits.seeds[0]);
    await tapImagePoint(page, ...secondPoint);
    await waitReady(page, 'Magoanine C west houses');
    await page.locator('#undo').click();
    await waitReady(page, 'Magoanine C west houses');
    assert.equal(await page.locator('#viewer .manual-point').count(), 1, 'undo removes the second correction and retains the restored one');

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
      assert(dimensions.document <= dimensions.viewport, `${width}px viewport has no horizontal page overflow (${dimensions.document}px)`);
      for (const selector of ['#add-seed', '#divide', '#undo', '#export']) {
        const control = page.locator(selector);
        assert(await control.isVisible(), `${selector} remains visible at ${width}px`);
        if (selector !== '#undo' || await control.isEnabled()) assert(await control.isEnabled(), `${selector} remains actionable at ${width}px`);
      }
    }

    assert.deepEqual(pageErrors, [], `no unhandled browser errors: ${pageErrors.join('; ')}`);
    assert.deepEqual(externalRequests, [], `the demo should use only its own test origin: ${externalRequests.join(', ')}`);
    console.log(`GeoJSON exports saved to /tmp/heuristic-demo-exports: ${JSON.stringify(exportedStats)}`);
    await context.close();
  } finally {
    await browser?.close();
    await close(server);
  }
});
