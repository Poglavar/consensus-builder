import { test, expect } from '@playwright/test';
import path from 'node:path';

// The model view's ground cover in a real WebGL context (frontend/js/three-ground-cover.js): the
// shader compiles, the open ground is grass and shrubs before any cover arrives, then takes each
// cell's look in its colour (sand west, paving east), and a dirt track shows across it.
test('the ground shows its cover: default grass, then sand and paving per cell, with a track across', async ({ page }) => {
  await page.route('http://ground.test/three/**', route => route.fulfill({
    path: path.resolve(__dirname, '../../backend/node_modules/three/build', path.basename(new URL(route.request().url()).pathname)),
    contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }
  }));
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ type: 'module', content: "import * as THREE from 'http://ground.test/three/three.module.js'; window.THREE = THREE;" });
  await page.waitForFunction(() => !!(window as any).THREE);
  for (const file of ['life/ground-geometry', 'three-ground', 'three-ground-cover']) {
    await page.addScriptTag({ path: path.resolve(__dirname, `../../frontend/js/${file}.js`) });
  }
  const result = await page.evaluate(() => {
    const w = window as any, T = w.THREE;
    const renderer = new T.WebGLRenderer({ antialias: false, stencil: true });
    const target = new T.WebGLRenderTarget(256, 256, { stencilBuffer: true });
    renderer.setRenderTarget(target);
    const errors: string[] = [];
    renderer.debug.onShaderError = (gl: any, program: any) => { errors.push(String(gl.getProgramInfoLog(program))); };
    const scene = new T.Scene();
    scene.background = new T.Color(0x000000);
    scene.add(new T.AmbientLight(0xffffff, 3));
    const ground = w.__threeGround.create({ THREE: T, k: 1 });
    const cover = w.__threeGroundCover.create({ THREE: T });
    cover.apply(ground.planeMaterial, 1);
    ground.setGeometry(w.__groundGeometry.buildGroundGeometry({
      bounds: [-500, -500, 500, 500], carriageways: [],
      paths: [{ pts: [[-200, 50], [200, 50]], drawnHalfWidth: 4, look: 'dirt' }]
    }));
    scene.add(ground.group);
    const camera = new T.OrthographicCamera(-200, 200, 200, -200, 1, 1000);
    camera.position.set(0, 0, 500);
    camera.lookAt(0, 0, 0);
    const pixels = () => {
      renderer.render(scene, camera);
      const data = new Uint8Array(256 * 256 * 4);
      renderer.readRenderTargetPixels(target, 0, 0, 256, 256, data);
      return data;
    };
    // The mean colour of a 9 × 9 pixel patch around world (x, y).
    const at = (data: Uint8Array, x: number, y: number) => {
      const px = Math.round((x + 200) / 400 * 255), py = Math.round((y + 200) / 400 * 255);
      const sum = [0, 0, 0];
      for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) {
        const o = ((py + dy) * 256 + px + dx) * 4;
        for (let i = 0; i < 3; i++) sum[i] += data[o + i];
      }
      return sum.map(v => Math.round(v / 81));
    };
    const before = pixels();
    const LOOKS = ['none', 'grass', 'shrub', 'crop', 'bare', 'sand', 'rock', 'built', 'forest', 'wetland', 'snow'];
    const ids: number[] = [];
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) ids.push(col < 2 ? 5 : 7);
    const payload = {
      bbox: [-400, -400, 400, 400], cols: 4, rows: 4, lookNames: LOOKS,
      looks: btoa(String.fromCharCode(...ids)),
      palette: { sand: { rgb: [205, 160, 105], ndvi: 0.1, samples: 100 } },
      attribution: '© ESA WorldCover project 2021'
    };
    const shown = cover.setCover(payload, (lng: number, lat: number) => [lng, lat]);
    const after = pixels();
    // The ground rebuilt in the same place: the same payload keeps its textures.
    const textures = cover.uniforms.uCoverMix.value;
    cover.setCover(payload, (lng: number, lat: number) => [lng, lat]);
    return {
      errors, shown: !!shown, credit: shown?.attribution, reused: cover.uniforms.uCoverMix.value === textures,
      defaultGround: at(before, -100, -100),
      west: at(after, -150, -100), east: at(after, 150, -100),
      track: at(after, -150, 50), besideTrack: at(after, -150, 30)
    };
  });
  expect(result.errors).toEqual([]);
  expect(result.shown).toBe(true);
  expect(result.credit).toBe('© ESA WorldCover project 2021');
  expect(result.reused).toBe(true);
  // Grass and shrubs: green before the cover is known.
  expect(result.defaultGround[1]).toBeGreaterThan(result.defaultGround[0] + 10);
  expect(result.defaultGround[1]).toBeGreaterThan(result.defaultGround[2] + 20);
  // Sand west: warm, red over blue; paving east: near grey.
  expect(result.west[0]).toBeGreaterThan(result.west[2] + 40);
  expect(Math.abs(result.east[0] - result.east[2])).toBeLessThan(15);
  expect(result.east[0]).toBeGreaterThan(120);
  // The track is its own colour, not the sand around it.
  expect(result.track.some((v, i) => Math.abs(v - result.besideTrack[i]) > 12)).toBe(true);
});
