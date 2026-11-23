import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

async function loadGroundRenderer(page: Page) {
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
}

// Exercise the real WebGL depth/stencil buffer: material settings alone cannot establish that
// a large coplanar background stays out of a parcel at different zooms and viewing angles.
test('background paving never leaks through parcels while zooming and orbiting', async ({ page }, testInfo) => {
  await loadGroundRenderer(page);
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

test('background paving keeps the zoning tint visible as the camera tilts', async ({ page }) => {
  await loadGroundRenderer(page);
  const result = await page.evaluate(() => {
    const w = window as any, T = w.THREE;
    const width = 1265, height = 902;
    const renderer = new T.WebGLRenderer({ antialias: true, stencil: true });
    renderer.setSize(width, height, false);
    const scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 2));
    const k = 1 / Math.cos(43.755 * Math.PI / 180);
    const ground = w.__threeGround.create({ THREE: T, k });
    const reach = 3_000_310.25;
    ground.setGeometry(w.__groundGeometry.buildGroundGeometry({ bounds: [-reach, -reach, reach, reach] }));
    scene.add(ground.group);
    const shape = new T.Shape([new T.Vector2(-850, -900), new T.Vector2(900, -850),
      new T.Vector2(780, 950), new T.Vector2(-920, 820)]);
    const material = new T.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.45, depthWrite: false });
    const overlay = new T.Mesh(new T.ShapeGeometry(shape), material);
    overlay.position.z = 0.01;
    scene.add(overlay);
    const camera = new T.PerspectiveCamera(45, width / height, 1.64775, 16477.5);
    camera.up.set(0, 0, 1);
    const gl = renderer.getContext();
    const read = () => {
      renderer.render(scene, camera);
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    let worst = 0, leastTinted = Infinity;
    for (const heading of [-0.064, 0.24, 0.95]) {
      for (const pitch of [0.735, 0.755, 0.775, 0.795, 0.815, 0.835]) {
        const distance = 1647.75, horizontal = Math.cos(pitch) * distance;
        camera.position.set(-Math.sin(heading) * horizontal, -Math.cos(heading) * horizontal, Math.sin(pitch) * distance);
        camera.lookAt(0, 0, 0);
        const actual = read();
        material.depthTest = false;
        const reference = read();
        material.depthTest = true;
        let different = 0, tinted = 0;
        for (let i = 0; i < actual.length; i += 4) {
          if (Math.abs(actual[i + 2] - reference[i + 2]) > 8) different++;
          if (reference[i] - reference[i + 2] > 35) tinted++;
        }
        worst = Math.max(worst, different);
        leastTinted = Math.min(leastTinted, tinted);
      }
    }
    ground.dispose(); overlay.geometry.dispose(); material.dispose(); renderer.dispose();
    return { worst, leastTinted };
  });
  expect(result.leastTinted).toBeGreaterThan(20_000);
  expect(result.worst).toBeLessThan(100);
});
