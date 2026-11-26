// The model view's editor drag handles (frontend/js/model-edit-handles.js): a real pointer drag on
// the 3D canvas changes the editor's height slider, moves the building and turns it, while the camera
// stays where it was.
import { test, expect } from '../helpers/fixtures';
import type { Page } from '@playwright/test';
import { openCity, openParcel, openBlockEditor, answerBlockScope, stubBasemapTiles, closeParcel, showSelectionDesignTab } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';

test.use({ navigationTimeout: 60_000 });

async function enterModelView(page: Page) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#mode-3d-toggle')).not.toHaveClass(/mode-btn-loading/, { timeout: 20_000 });
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as any).isThreeModeActive?.()), { timeout: 20_000 }).toBe(true);
}

// The screen position of a scene point: a handle ('height' | 'rotate') or a point given in lat/lng/z.
function screenOf(page: Page, target: { handle?: string; lat?: number; lng?: number; z?: number }) {
  return page.evaluate(target => {
    const w = window as any;
    const three = w.getThreeModeInternals();
    let position;
    if (target.handle) {
      const group = three.scene.getObjectByName('model-edit-handles');
      let found: any = null;
      group.traverse((object: any) => { if (object.userData?.handle === target.handle && object.visible) found = object; });
      if (!found) return null;
      position = found.getWorldPosition(new w.THREE.Vector3());
    } else {
      const [x, y] = three.latLngToXY(target.lat, target.lng);
      position = new w.THREE.Vector3(x, y, target.z || 0);
    }
    const projected = position.project(three.camera);
    const rect = three.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + (projected.x + 1) * rect.width / 2, y: rect.top + (1 - projected.y) * rect.height / 2 };
  }, target);
}

async function drag(page: Page, from: { x: number; y: number }, points: Array<{ x: number; y: number }>) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const point of points) await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.up();
}

const camera = (page: Page) => page.evaluate(() => (window as any).getThree3DGeoView());
const freeformBuilding = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const feature = w.OnMapEditor.getPreview().draftPreview.features[0];
  return { center: w.SingleBuildingGeometry.geometryCenter(feature.geometry), height: feature.properties.height, rotation: feature.properties.rotation || 0 };
});

test('Freeform in model view: drag the arrow for height, the building to move it and the knob to turn it', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('.parcel-build-btn--single').click();
  await answerBlockScope(page);
  await enterModelView(page);
  await page.mouse.click(400, 300);
  await expect(page.locator('#single-building-editor')).not.toHaveAttribute('data-placing');
  await expect(page.locator('#single-building-editor .on-map-editor__hint')).toContainText('arrow above it');
  const slider = page.locator('#single-height-slider');
  const view = await camera(page);
  const start = await freeformBuilding(page);

  const arrow = await screenOf(page, { handle: 'height' });
  expect(arrow).not.toBeNull();
  await drag(page, arrow!, [{ x: arrow!.x, y: arrow!.y - 60 }, { x: arrow!.x, y: arrow!.y - 120 }]);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(start.height);
  const raised = await freeformBuilding(page);
  expect(raised.height).toBe(Number(await slider.inputValue()));
  expect(raised.center).toEqual(start.center);
  expect(await camera(page)).toEqual(view);

  // Grab the building half way up and drag that point 8 m east at the same height.
  const metresEast = 8 / (111320 * Math.cos(raised.center.lat * Math.PI / 180));
  const grab = await screenOf(page, { lat: raised.center.lat, lng: raised.center.lng, z: raised.height / 2 });
  const east = await screenOf(page, { lat: raised.center.lat, lng: raised.center.lng + metresEast, z: raised.height / 2 });
  await drag(page, grab!, [{ x: (grab!.x + east!.x) / 2, y: (grab!.y + east!.y) / 2 }, east!]);
  await expect.poll(async () => (await freeformBuilding(page)).center.lng).toBeGreaterThan(raised.center.lng + metresEast / 2);
  const moved = await freeformBuilding(page);
  expect(moved.center.lng).toBeLessThan(raised.center.lng + metresEast * 1.5);
  expect(moved.center.lat).toBeCloseTo(raised.center.lat, 6);
  expect(moved.height).toBe(raised.height);
  expect(await camera(page)).toEqual(view);

  // Take the knob a quarter of the way round its ring, counter-clockwise on the ground.
  const knob = await screenOf(page, { handle: 'rotate' });
  expect(knob).not.toBeNull();
  const ring = await page.evaluate(() => {
    const w = window as any;
    const three = w.getThreeModeInternals();
    let knob: any = null;
    three.scene.getObjectByName('model-edit-handles').traverse((object: any) => { if (object.userData?.handle === 'rotate') knob = object; });
    const { centre, radius } = knob.parent.children.find((object: any) => object.isLineLoop).userData;
    const at = (degrees: number) => {
      const angle = degrees * Math.PI / 180;
      const point = new w.THREE.Vector3(centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle), 0.5).project(three.camera);
      const rect = three.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2 };
    };
    return [at(-75), at(-60), at(-45), at(-30)];
  });
  await drag(page, knob!, ring);
  await expect.poll(async () => (await freeformBuilding(page)).rotation).toBe(60);
  expect((await freeformBuilding(page)).center.lng).toBeCloseTo(moved.center.lng, 9);
  expect(await camera(page)).toEqual(view);
});

test('Urban rule in model view: the arrow above the building sets Max storeys', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await openBlockEditor(page);
  await enterModelView(page);
  const slider = page.locator('#height-slider');
  const before = Number(await slider.inputValue());
  await expect.poll(() => screenOf(page, { handle: 'height' })).not.toBeNull();
  const arrow = await screenOf(page, { handle: 'height' });
  await drag(page, arrow!, [{ x: arrow!.x, y: arrow!.y + 40 }, { x: arrow!.x, y: arrow!.y + 80 }]);
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(before);
  // The arrow stands on the new top: the slider's storeys times the rule's storey height.
  const top = await page.evaluate(() => {
    let z = null;
    (window as any).getThreeModeInternals().scene.getObjectByName('model-edit-handles')
      .traverse((object: any) => { if (object.userData?.handle === 'height') z = object.position.z; });
    return z;
  });
  expect(top).toBeCloseTo(Number(await slider.inputValue()) * 3.5, 6);
});

test('Row houses in model view: the arrow sets storeys and the terrace drags east', async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  await mockBuildingScene(page);
  await openCity(page);
  const blockParcels = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];
  await page.evaluate(async ids => (window as any).CadastralParcelRepository.ensureIds(ids), blockParcels);
  await openParcel(page, 'proposals', blockParcels[0]);
  await page.locator('.multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await closeParcel(page);
  await showSelectionDesignTab(page);
  await page.locator('.parcel-build-btn--row').click();
  await expect(page.locator('#rowhouse .on-map-editor__panel')).toBeVisible();
  await enterModelView(page);
  const terrace = () => page.evaluate(() => {
    const w = window as any;
    return w.SingleBuildingGeometry.geometryCenter(w.OnMapEditor.getPreview().massing.geometry);
  });
  const slider = page.locator('#rowhouse-height-slider');
  const storeys = Number(await slider.inputValue());
  await expect.poll(() => screenOf(page, { handle: 'height' })).not.toBeNull();
  const arrow = await screenOf(page, { handle: 'height' });
  await drag(page, arrow!, [{ x: arrow!.x, y: arrow!.y - 30 }, { x: arrow!.x, y: arrow!.y - 60 }]);
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(storeys);

  const start = await terrace();
  const metresEast = 6 / (111320 * Math.cos(start.lat * Math.PI / 180));
  const grab = await screenOf(page, { lat: start.lat, lng: start.lng, z: 2 });
  const east = await screenOf(page, { lat: start.lat, lng: start.lng + metresEast, z: 2 });
  await drag(page, grab!, [{ x: (grab!.x + east!.x) / 2, y: (grab!.y + east!.y) / 2 }, east!]);
  await expect.poll(async () => (await terrace()).lng).toBeGreaterThan(start.lng + metresEast / 2);
  expect((await terrace()).lat).toBeCloseTo(start.lat, 6);
});
