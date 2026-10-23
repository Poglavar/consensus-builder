// Exercise real glTF parsing and upload independently of the optional WebGL preview.
import { readFileSync } from 'node:fs';
import { test, expect } from '../helpers/fixtures';

const index = readFileSync('../frontend/index.html', 'utf8');
const bootstrap = index.slice(index.indexOf('<script type="importmap">'), index.indexOf('// 2D-coupled files'));
const scripts = bootstrap.slice(0, bootstrap.lastIndexOf('<script>'));
const building = readFileSync('../test-assets/test-building.glb');

async function openImporter(page: any, failure = 'none') {
  await page.route('**/upload-test', route => route.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><head><link rel="stylesheet" href="/css/primitives.css"><link rel="stylesheet" href="/css/modals.css">${scripts}</head><body></body></html>` }));
  await page.goto('/upload-test');
  await page.addScriptTag({ url: '/js/building-model-geometry.js' });
  await page.addScriptTag({ url: '/js/building-upload.js' });
  await page.evaluate(async (mode: string) => {
    const w = window as any;
    await w.whenThreeReady();
    if (mode === 'constructor') w.THREE.WebGLRenderer = class { constructor() { throw new Error('WebGL unavailable'); } };
    if (mode === 'render') {
      const Renderer = w.THREE.WebGLRenderer;
      w.THREE.WebGLRenderer = class extends Renderer {
        constructor(options: any) { super(options); this.render = () => { throw new Error('Draw failed'); }; }
      };
    }
    w.getBackendBase = () => location.origin;
    w.createSingleBuildingFromUpload = (data: any) => { w.importedBuilding = data; return true; };
    w.BuildingUpload.open({ blockName: 'Test block', parcelIds: ['test-parcel'] });
  }, failure);
}

for (const failure of ['none', 'constructor', 'render', 'context loss']) {
  test(`uploads a parsed GLB with preview: ${failure}`, async ({ page }) => {
    if (failure === 'constructor') await page.setViewportSize({ width: 375, height: 812 });
    let uploaded: any;
    await page.route('**/models', async route => {
      uploaded = route.request().postDataJSON();
      await route.fulfill({ json: { modelUrl: '/uploads/models/building.glb' } });
    });
    await openImporter(page, failure);
    await page.locator('#building-upload-file').setInputFiles('../test-assets/test-building.glb');
    await expect(page.locator('#building-upload-confirm')).toBeEnabled({ timeout: 20_000 });
    await expect(page.locator('#building-upload-status')).toContainText('Footprint 16m × 20m, height 16m');
    if (failure === 'context loss') {
      await page.locator('#building-upload-3d canvas').evaluate(canvas => canvas.dispatchEvent(new Event('webglcontextlost')));
    }
    if (failure !== 'none') {
      await expect(page.locator('#building-upload-3d')).toContainText('You can still use this building.');
      await expect(page.locator('#building-upload-3d canvas')).toHaveCount(0);
      const preview = await page.locator('#building-upload-3d').boundingBox();
      const dialog = await page.locator('#building-upload-container').boundingBox();
      expect(preview!.x + preview!.width).toBeLessThanOrEqual(dialog!.x + dialog!.width);
    } else {
      await expect(page.locator('#building-upload-3d canvas')).toBeVisible();
    }
    await page.locator('#building-upload-confirm').click();
    await expect(page.locator('#building-upload-modal')).toHaveCount(0);
    expect(uploaded.fileName).toBe('test-building.glb');
    expect(Buffer.from(uploaded.modelData.split(',')[1], 'base64')).toEqual(building);
    expect(await page.evaluate(() => (window as any).importedBuilding)).toMatchObject({
      width: 16, length: 20, height: 16, modelName: 'test-building.glb',
      modelUrl: '/uploads/models/building.glb', blockName: 'Test block', parcelIds: ['test-parcel']
    });
  });
}

test('invalid and empty models remain blocked without trying to create a preview', async ({ page }) => {
  await openImporter(page, 'constructor');
  await page.locator('#building-upload-file').setInputFiles({ name: 'invalid.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('invalid') });
  await expect(page.locator('#building-upload-status')).toContainText('Could not read this file');
  await expect(page.locator('#building-upload-confirm')).toBeDisabled();
  await page.locator('#building-upload-file').setInputFiles({ name: 'empty.gltf', mimeType: 'model/gltf+json',
    buffer: Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }] })) });
  await expect(page.locator('#building-upload-status')).toContainText('no visible geometry');
  await expect(page.locator('#building-upload-confirm')).toBeDisabled();
  await expect(page.locator('#building-upload-3d')).toBeEmpty();
});

test('late parse callbacks cannot replace a newer file or reopen a closed dialog', async ({ page }) => {
  await openImporter(page, 'constructor');
  await page.evaluate(() => {
    const w = window as any;
    const parse = w.THREE.GLTFLoader.prototype.parse;
    w.finishParsing = [];
    w.THREE.GLTFLoader.prototype.parse = function (data: any, path: any, onLoad: any, onError: any) {
      return parse.call(this, data, path, (model: any) => w.finishParsing.push(() => onLoad(model)), onError);
    };
  });
  const input = page.locator('#building-upload-file');
  await input.setInputFiles({ name: 'older.glb', mimeType: 'model/gltf-binary', buffer: building });
  await expect.poll(() => page.evaluate(() => (window as any).finishParsing.length)).toBe(1);
  await input.setInputFiles({ name: 'newer.glb', mimeType: 'model/gltf-binary', buffer: building });
  await expect.poll(() => page.evaluate(() => (window as any).finishParsing.length)).toBe(2);
  await page.evaluate(() => { const callbacks = (window as any).finishParsing; callbacks[1](); callbacks[0](); });
  await expect(page.locator('#building-upload-status')).toContainText('newer.glb');
  await expect(page.locator('#building-upload-confirm')).toBeEnabled();

  await input.setInputFiles({ name: 'closed.glb', mimeType: 'model/gltf-binary', buffer: building });
  await expect.poll(() => page.evaluate(() => (window as any).finishParsing.length)).toBe(3);
  await page.locator('#building-upload-close').click();
  await page.evaluate(() => (window as any).finishParsing[2]());
  await expect(page.locator('#building-upload-modal')).toHaveCount(0);
});
