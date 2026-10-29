import { test, expect } from '@playwright/test';
import path from 'node:path';

// Exercise the real WebGL depth/stencil buffer: material settings alone cannot establish that
// a large coplanar background stays out of a parcel at different zooms and viewing angles.
test('background paving never leaks through parcels while zooming and orbiting', async ({ page }, testInfo) => {
  await page.route('http://ground.test/three/**', route => route.fulfill({
    path: path.resolve(__dirname, '../../backend/node_modules/three/build', path.basename(new URL(route.request().url()).pathname)),
    contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }
  }));
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ type: 'module', content: "import * as THREE from 'http://ground.test/three/three.module.js'; window.THREE = THREE;" });
  // An inline module runs once its imports have loaded, after addScriptTag has returned.
  await page.waitForFunction(() => !!(window as any).THREE);
  for (const file of ['life/ground-geometry', 'three-ground']) {
    await page.addScriptTag({ path: path.resolve(__dirname, `../../frontend/js/${file}.js`) });
  }
  const result = await page.evaluate(() => {
    const w = window as any, T = w.THREE;
    const renderer = new T.WebGLRenderer({ antialias: false, stencil: true });
    const target = new T.WebGLRenderTarget(512, 512, { stencilBuffer: true });
    renderer.setRenderTarget(target);
    const scene = new T.Scene();
    scene.background = new T.Color(0xffffff);
    scene.add(new T.AmbientLight(0xffffff, 2));
    const k = 1 / Math.cos(38.904 * Math.PI / 180);
    const ground = w.__threeGround.create({ THREE: T, k });
    ground.setGeometry(w.__groundGeometry.buildGroundGeometry({
      bounds: [-200000, -200000, 200000, 200000],
      carriageways: [{ pts: [[-100, 40], [100, 40]], halfWidth: 3, drop: 0.15 }]
    }));
    scene.add(ground.group);
    const shape = new T.Shape([
      new T.Vector2(-50 * k, -50 * k), new T.Vector2(50 * k, -50 * k),
      new T.Vector2(50 * k, 50 * k), new T.Vector2(-50 * k, 50 * k)
    ]);
    const material = ground.parcelSurface(new T.MeshBasicMaterial({ color: 0xdd44bb }));
    const parcel = new T.Mesh(new T.ShapeGeometry(shape), material);
    scene.add(parcel);
    const pavement = ground.group.getObjectByName('ground-pavement');
    const camera = new T.PerspectiveCamera(45, 1, 1, 10000);
    camera.up.set(0, 0, 1);
    const pixels = () => {
      renderer.render(scene, camera);
      const data = new Uint8Array(512 * 512 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 512, 512, data);
      return data;
    };
    let leaks = 0, originalLeaks = 0, samples = 0;
    for (const distance of [120, 224.66, 350, 650, 1000]) {
      for (const angle of [0, 0.4, 1.2]) {
        camera.position.set(Math.sin(angle) * distance * 0.6, -Math.cos(angle) * distance * 0.6, distance * 0.8);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld(true);
        pavement.visible = false;
        const reference = pixels();
        pavement.visible = true;
        const actual = pixels();
        // Diagnostic control reproduces the former offset-only coverage on this GPU.
        const backgroundMaterial = pavement.material;
        material.stencilWriteMask = 0;
        backgroundMaterial.stencilFuncMask = w.__threeGround.STENCIL_BIT;
        backgroundMaterial.stencilRef = w.__threeGround.STENCIL_BIT;
        backgroundMaterial.stencilFunc = T.NotEqualStencilFunc;
        backgroundMaterial.polygonOffset = true;
        backgroundMaterial.polygonOffsetFactor = backgroundMaterial.polygonOffsetUnits = 3;
        pavement.renderOrder = 0;
        const original = pixels();
        material.stencilWriteMask = w.__threeGround.PARCEL_BIT;
        backgroundMaterial.stencilFuncMask = w.__threeGround.STENCIL_BIT | w.__threeGround.PARCEL_BIT;
        backgroundMaterial.stencilRef = 0;
        backgroundMaterial.stencilFunc = T.EqualStencilFunc;
        backgroundMaterial.polygonOffset = false;
        pavement.renderOrder = w.__threeGround.ORDER.pavement;
        for (let x = -30; x <= 30; x += 5) for (let y = -30; y <= 30; y += 5) {
          const point = new T.Vector3(x * k, y * k, 0).project(camera);
          const px = Math.floor((point.x + 1) * 256), py = Math.floor((point.y + 1) * 256);
          if (px < 0 || px >= 512 || py < 0 || py >= 512) continue;
          const offset = (py * 512 + px) * 4;
          const differs = data => [0, 1, 2].some(i => Math.abs(data[offset + i] - reference[offset + i]) > 2);
          leaks += Number(differs(actual));
          originalLeaks += Number(differs(original));
          samples++;
        }
      }
    }
    ground.dispose(); parcel.geometry.dispose(); material.dispose(); target.dispose(); renderer.dispose();
    return { leaks, originalLeaks, samples };
  });
  testInfo.annotations.push({ type: 'offset-only control', description: `${result.originalLeaks} paving leaks across ${result.samples} parcel samples` });
  expect(result.samples).toBeGreaterThan(2000);
  expect(result.leaks).toBe(0);
});
