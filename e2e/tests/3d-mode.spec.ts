import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, createBuilding, proposalState } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { surveyResponse } from '../helpers/mocks/survey-data';
import { openLayerSection } from '../helpers/layers';
import { Page } from '@playwright/test';

async function enter3D(page: Page) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.())).toBe(true);
}
// The model's Built/Planned/facade/scenery controls live in the Layers sheet (fbe3758d).
async function openModelLayers(page: Page) {
  if (!(await page.locator('#model-layer-controls').isVisible())) await page.locator('#layers-button').click();
  await expect(page.locator('#model-layer-controls .three-mode-ui-panel')).toBeVisible();
}
async function openPlanningViews(page: Page) {
  if (!(await page.locator('#planning-views').isVisible())) await page.locator('#planning-views-button').click();
  await expect(page.locator('#planning-views')).toBeVisible();
}
async function closeSheets(page: Page) {
  for (const close of await page.locator('.map-sheet:visible [data-sheet-close]').all()) {
    // Phone sheets keep Close in keyboard navigation while pointer dismissal uses the handle.
    await close.focus();
    await close.press('Enter');
  }
  await expect(page.locator('.map-sheet:visible')).toHaveCount(0);
}
// Built-context rendering and its load radius are both discoverable in the 3D Layers sheet.
async function modelRadiusPreview(page: Page) {
  return page.evaluate(() => {
    const w = window as any;
    const internals = w.getThreeModeInternals();
    const scene = internals.scene;
    const preview = scene.getObjectByName('building-load-radius-preview');
    if (!preview) return null;
    let maxRadius = 0;
    preview.traverse((object: any) => {
      const position = object.geometry?.attributes?.position;
      if (!position) return;
      for (let i = 0; i < position.count; i++) {
        const point = new w.THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i));
        object.localToWorld(point);
        const ll = internals.xyToLatLng(point.x, point.y);
        const center = preview.userData?.center;
        if (ll && center && w.turf?.distance) {
          maxRadius = Math.max(maxRadius, w.turf.distance([center.lng, center.lat], [ll.lng, ll.lat], { units: 'meters' }));
        }
      }
    });
    let visible = true;
    for (let object = preview; object; object = object.parent) visible &&= object.visible !== false;
    return {
      visible,
      radiusMeters: preview.userData?.radiusMeters,
      longitude: preview.userData?.center?.lng,
      latitude: preview.userData?.center?.lat,
      ringRadius: maxRadius
    };
  });
}
// Display changes hide retained building groups instead of rebuilding them (51152a2e), so only
// meshes visible through their whole ancestor chain are actually drawn.
async function sceneBuildings(page: Page) {
  return page.evaluate(() => {
    const meshes: any[] = [];
    (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => {
      if (o.userData?.isNearbyBuilding3D) meshes.push({ vertices: o.geometry.attributes.position.count, opacity: o.material.userData?.cbBuildingOpacity ?? o.material.opacity, color: o.material.color.getHex() });
    });
    return meshes;
  });
}
// Project candidate points on the actual rendered surface and accept only points where the
// nearest visible, selectable 3D hit resolves to the requested parcel/proposal. This mirrors the
// renderer's priority rules so roofs and overlapping parcel fills cannot redirect the test click.
async function rayVerifiedPickPoint(page: Page, target: 'parcel' | 'proposal', id: string) {
  return page.evaluate(({ target, id }) => {
    const w = window as any;
    const { scene, camera, renderer } = w.getThreeModeInternals();
    const candidates: any[] = [];
    scene.traverse((object: any) => {
      if (!object.isMesh || !object.geometry?.attributes?.position?.count) return;
      if (target === 'parcel'
        ? object.userData?.isParcel === true && String(object.userData?.parcelId || '') === id
        : String(object.userData?.proposalId || '') === id) candidates.push(object);
    });
    if (!candidates.length) throw new Error(`No rendered ${target} pick surface for ${id}`);
    const selectionRoots = new Set<any>();
    scene.traverse((object: any) => {
      const data = object.userData || {};
      if (!(data.proposalId || data.parcelId || data.isParcel || data.planningRepresentationId
        || data.planningBuiltFeature || data.stationType)) return;
      let root = object;
      while (root.parent && root.parent !== scene) root = root.parent;
      selectionRoots.add(root);
    });
    const buildingRoot = scene.getObjectByName('Buildings');
    if (buildingRoot) selectionRoots.add(buildingRoot);
    // This is the same selectable scene inventory used by handleParcelClick: proposal surfaces,
    // existing/proposed buildings, cadastral parcels, planning representations and stations.
    const targets = [...selectionRoots];
    const rect = renderer.domElement.getBoundingClientRect();
    const raycaster = new w.THREE.Raycaster();
    const fractions = [0.12, 0.28, 0.5, 0.72, 0.88];
    for (const mesh of candidates) {
      mesh.geometry.computeBoundingBox();
      const bounds = mesh.geometry.boundingBox;
      const size = bounds.getSize(new w.THREE.Vector3());
      for (const fx of fractions) for (const fy of fractions) {
        const point = bounds.min.clone().add(size.clone().multiply(new w.THREE.Vector3(fx, fy, 0.5)));
        mesh.localToWorld(point);
        const ndc = point.clone().project(camera);
        if (ndc.z < -1 || ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
        raycaster.setFromCamera(new w.THREE.Vector2(ndc.x, ndc.y), camera);
        let picked: any = null;
        for (const hit of raycaster.intersectObjects(targets, true)) {
          let object = hit.object;
          let visible = true;
          let proposalId: string | null = null;
          let parcelId: string | null = null;
          let planningId = null;
          let builtFeature = null;
          while (object) {
            if (object.visible === false) visible = false;
            if (object.userData?.planningRepresentationId) planningId = object.userData.planningRepresentationId;
            if (object.userData?.planningBuiltFeature) builtFeature = object.userData.planningBuiltFeature;
            if (!proposalId && object.userData?.proposalId) proposalId = String(object.userData.proposalId);
            if (!parcelId && object.userData?.parcelId) parcelId = String(object.userData.parcelId);
            object = object.parent;
          }
          if (!visible) continue;
          if (planningId || (builtFeature && !proposalId)) { picked = { other: true }; break; }
          if (proposalId || parcelId) { picked = { proposalId, parcelId }; break; }
        }
        const matches = target === 'proposal'
          ? picked?.proposalId === id
          : picked?.proposalId == null && picked?.parcelId === id;
        if (matches) return { x: rect.left + (ndc.x + 1) * rect.width / 2, y: rect.top + (1 - ndc.y) * rect.height / 2 };
      }
    }
    throw new Error(`No ray-verified ${target} pick point for ${id}`);
  }, { target, id });
}

test.describe('3D rendering and controls @features', () => {
  test('repeated scene picks cycle into Design without moving the camera, including after refresh', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await page.evaluate(() => {
      const w = window as any;
      const id = 'HR-335754-1234';
      const geometry = w.LiveParcelFabric.get(id).geometry;
      w.proposalStorage.addProposal({ title: 'Garden option', goal: 'park', cadastreParcelIds: [id], geometry,
        structureProposal: { kind: 'park', geometry }, applied: false });
    });
    await enter3D(page);
    await openPlanningViews(page);
    await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'solid');
    await closeSheets(page);
    const point = await rayVerifiedPickPoint(page, 'parcel', 'HR-335754-1234');
    const camera = () => page.evaluate(() => {
      const { camera, controls } = (window as any).getThreeModeInternals();
      return { position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom };
    });
    const before = await camera();
    const expanded = () => page.evaluate(() => (window as any).ThreeClickStack.expanded());
    await page.mouse.click(point.x, point.y);
    await expect.poll(expanded).toBe('parcels');
    await page.mouse.click(point.x, point.y);
    await expect.poll(expanded).toBe('built');
    await page.mouse.click(point.x, point.y);
    await expect.poll(expanded).toBe('designs');
    expect(await camera()).toEqual(before);
    await page.evaluate(() => (window as any).ThreeClickStack.refresh());
    expect(await camera()).toEqual(before);
    const kinds = await page.locator('#three-click-stack .click-stack__section').evaluateAll(sections => sections.map(section => (section as HTMLElement).dataset.kind!));
    for (const kind of kinds.slice(kinds.indexOf('designs') + 1)) {
      await page.mouse.click(point.x, point.y);
      await expect.poll(expanded).toBe(kind);
      expect(await camera()).toEqual(before);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#three-click-stack')).toBeHidden();
    await page.mouse.click(point.x, point.y);
    await expect.poll(expanded).toBe('parcels');
  });

  for (const width of [1280, 390]) {
    test(`building display settings remain global across parcel selections at ${width}px`, async ({ mockApi: page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockBuildingScene(page);
      await openCity(page);
      await enter3D(page);
      await openPlanningViews(page);
      const panel = page.locator('#planning-views');
      const display = panel.locator('[data-planning-setting="existing"]');
      await selectNativeOption(display, 'solid');
      await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);

      for (const parcelId of ['HR-335754-1234', 'HR-335754-1235']) {
        await closeSheets(page);
        await page.evaluate(id => (window as any).showThreeModeParcel(id), parcelId);
        await expect(page.locator('#three-click-stack .click-stack__section[data-kind="parcels"].is-expanded')).toBeVisible();
        await openPlanningViews(page);
        await expect(display).toHaveValue('solid');
        await expect(panel).not.toContainText(parcelId);
        await expect(panel.locator('.planning-focus, .planning-parcel-evidence')).toHaveCount(0);
        await selectNativeOption(display, 'ghost');
        await expect.poll(async () => {
          const buildings = await sceneBuildings(page);
          return buildings.length === 2 && buildings.every(building => building.opacity < 1);
        }).toBe(true);
        await selectNativeOption(display, 'off');
        await expect.poll(async () => (await sceneBuildings(page)).length).toBe(0);
        await selectNativeOption(display, 'solid');
        await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
      }
      await closeSheets(page);
      await page.keyboard.press('Escape');
      await openPlanningViews(page);
      await expect(display).toHaveValue('solid');
      await expect(panel.locator('.planning-focus, .planning-parcel-evidence')).toHaveCount(0);
    });
  }

  test('mode buttons stay lower left and parcel clicks preserve the camera while dimming context', async ({ mockApi: page }) => {
    await mockBuildingScene(page); await openCity(page);
    // The strip sits in the same lower-left place in 2D and 3D; nothing moves when the view changes.
    // (The original-cadastre toggle moved into the 2D Layers sheet in fbe3758d.)
    const modeIds = ['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle'];
    const modeBoxes = () => Promise.all(modeIds.map(async id => await page.locator('#' + id).boundingBox()));
    const flat = await modeBoxes();
    await enter3D(page);
    await openModelLayers(page);
    await openPlanningViews(page);
    await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'solid');
    await closeSheets(page);
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
    const originalBuildings = await sceneBuildings(page);
    const perspective = await modeBoxes();
    perspective.forEach((box, i) => {
      expect(box!.x).toBeLessThan(30); expect(box!.y).toBeGreaterThan(page.viewportSize()!.height / 2);
      expect(box!.x).toBe(flat[i]!.x); expect(box!.y).toBe(flat[i]!.y);
    });
    const camera = () => page.evaluate(() => {
      const { camera, controls } = (window as any).getThreeModeInternals();
      return { position: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom };
    });
    const point = await rayVerifiedPickPoint(page, 'parcel', 'HR-335754-1234');
    const before = await camera();
    await page.mouse.click(point.x, point.y);
    // The parcel's figures open in the Parcel section of the 3D click stack.
    await expect(page.locator('#three-click-stack .click-stack__section[data-kind="parcels"].is-expanded')).toBeVisible();
    const parcelPanel = page.locator('#three-click-stack .three-mode-parcel-panel');
    await expect(parcelPanel).toBeVisible();
    // The sale price slider reprices the Built / Planned / Proposed comparison; the built value follows it.
    const priceSlider = parcelPanel.locator('[data-role="sale-slider"]');
    const valueReadout = parcelPanel.locator('[data-cell="value:built"]');
    const initialPrice = Number(await priceSlider.inputValue());
    const initialValueReadout = await valueReadout.textContent();
    await priceSlider.focus();
    await page.keyboard.press(initialPrice < Number(await priceSlider.getAttribute('max')) ? 'End' : 'Home');
    await expect.poll(async () => Number(await priceSlider.inputValue())).not.toBe(initialPrice);
    await expect.poll(async () => await valueReadout.textContent()).not.toBe(initialValueReadout);
    expect(await camera()).toEqual(before);
    // Repeating the scene pick cycles through the section order, keeping the camera steady.
    const stack = page.locator('#three-click-stack');
    const kinds = await stack.locator('.click-stack__section').evaluateAll(sections => sections.map(section => (section as HTMLElement).dataset.kind!));
    expect(kinds[0]).toBe('built');
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('.three-mode-isolation-banner')).toBeHidden();
    await expect(page.locator('#three-click-stack')).toBeVisible();
    await expect(stack.locator('.click-stack__section[data-kind="built"].is-expanded')).toBeVisible();
    await expect(parcelPanel).toBeHidden();
    expect(await camera()).toEqual(before);
    // The remaining headers stay discoverable beneath the short Built record.
    const builtCard = stack.locator('.click-stack__section[data-kind="built"]');
    expect((await builtCard.boundingBox())!.height).toBeLessThan(500);
    await expect(stack.locator('.click-stack__section[data-kind="parcels"] .click-stack__row')).toBeInViewport();
    for (const kind of kinds.slice(1)) {
      await page.mouse.click(point.x, point.y);
      await expect(stack.locator(`.click-stack__section[data-kind="${kind}"].is-expanded`)).toBeVisible();
      expect(await camera()).toEqual(before);
    }
    await expect(parcelPanel).toBeVisible();
    expect(await camera()).toEqual(before);
    const buildings = await sceneBuildings(page);
    expect(buildings).toHaveLength(2);
    expect(buildings.map(building => building.color)).toEqual(originalBuildings.map(building => building.color));
    expect(await page.evaluate(() => {
      let selected = false;
      (window as any).getThreeModeInternals().scene.traverse((o: any) => {
        if (o.isMesh && o.userData?.parcelId === 'HR-335754-1234' && o.material.color?.getHex() === 0x29c8ff) selected = true;
      });
      return selected;
    })).toBe(true);
    const visible = await page.evaluate(() => {
      let count = 0;
      (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.userData?.isNearbyBuilding3D && o.visible && o.parent.visible) count++; });
      return count;
    });
    expect(visible).toBe(2);
    // Escape clears the retained parcel view and closes its click stack.
    await page.keyboard.press('Escape');
    await expect(page.locator('.three-mode-isolation-banner')).toBeHidden();
    await expect(page.locator('#three-click-stack')).toBeHidden();
    expect(await camera()).toEqual(before);
    expect((await sceneBuildings(page)).map(building => building.color)).toEqual(originalBuildings.map(building => building.color));
    await page.screenshot({ path: '/private/tmp/colosseum-3d-parcel-emphasis.png' });
  });
  test('3D enters with real building meshes, orbit and zoom work, and 2D returns', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await enter3D(page);
    await openModelLayers(page);
    await openPlanningViews(page);
    await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'solid');
    await closeSheets(page);
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
    expect((await sceneBuildings(page))[0].vertices).toBeGreaterThan(12);
    const camera = () => page.evaluate(() => (window as any).getThreeModeInternals().camera.position.toArray());
    const before = await camera();
    const box = await page.locator('#three-container canvas').boundingBox();
    if (!box) throw new Error('No 3D canvas');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await expect.poll(camera).not.toEqual(before);
    const afterOrbit = await camera();
    await page.mouse.wheel(0, -200);
    await expect.poll(camera).not.toEqual(afterOrbit);
    await page.locator('#mode-2d-toggle').click();
    await expect(page.locator('#three-container')).toBeHidden();
    expect(await page.evaluate(() => (window as any).isThreeModeActive())).toBe(false);
    await expect(page.locator('#map')).toBeVisible();
  });

  test('every Built state renders its correct surviving and demolished building set', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await createSpace(page, 'park');
    await enter3D(page);
    const isolation = page.locator('.three-mode-isolation-banner');
    if (await isolation.isVisible()) await isolation.locator('.isolation-banner-close').click();
    await expect(isolation).toBeHidden();
    await openModelLayers(page);
    await openPlanningViews(page);
    const display = page.locator('[data-planning-setting="existing"]');
    const scope = page.locator('[data-planning-setting="existingScope"]');
    for (const [state, count] of [['solid', 2], ['ghost', 2], ['surviving', 1], ['removed', 1], ['off', 0]] as const) {
      if (state === 'surviving' || state === 'removed') await selectNativeOption(scope, state);
      else await selectNativeOption(display, state);
      await expect.poll(async () => (await sceneBuildings(page)).length, { message: state }).toBe(count);
      if (state === 'ghost') {
        const meshes = await sceneBuildings(page);
        expect(meshes.every(m => m.opacity < 1)).toBe(true);
      }
    }
    await selectNativeOption(scope, 'all');
    await selectNativeOption(display, 'solid');
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
  });

  test('radius preview follows hover, keyboard, and drag in Layers, then refetches on release', async ({ mockApi: page }) => {
    const requests = await mockBuildingScene(page);
    await openCity(page);
    await enter3D(page);
    await expect.poll(() => requests.length).toBe(1);
    const initial = requests[0];
    await openModelLayers(page);
    const slider = page.locator('#layers-sheet .three-mode-radius-slider');
    await expect(page.locator('#settings-sheet .three-mode-radius-slider')).toHaveCount(0);

    // Hovering previews the full circle at its actual ground-plane radius without fetching.
    const initialValue = Number(await slider.inputValue());
    const sliderBox = await slider.boundingBox();
    if (!sliderBox) throw new Error('No building-load-radius slider');
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.45, sliderBox.y + sliderBox.height / 2);
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible).toBe(true);
    const hovered = await modelRadiusPreview(page);
    expect(hovered?.radiusMeters).toBe(initialValue);
    expect(hovered?.longitude).toEqual(expect.any(Number));
    expect(hovered?.latitude).toEqual(expect.any(Number));
    expect(hovered!.ringRadius).toBeGreaterThan(0);
    expect(hovered!.ringRadius).toBeCloseTo(initialValue, -1);
    expect(requests).toHaveLength(1);
    await page.screenshot({ path: '/private/tmp/colosseum-3d-building-radius-preview.png' });

    // Focus and keyboard input update both the control and ring; blur removes the preview.
    await page.mouse.move(sliderBox.x + sliderBox.width + 30, sliderBox.y + sliderBox.height / 2);
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible ?? false).toBe(false);
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    const keyboardValue = Number(await slider.inputValue());
    expect(keyboardValue).toBeGreaterThan(initialValue);
    await expect.poll(async () => (await modelRadiusPreview(page))?.radiusMeters).toBe(keyboardValue);
    await expect.poll(async () => (await modelRadiusPreview(page))?.ringRadius).toBeCloseTo(keyboardValue, -1);
    await page.locator('#three-mode-facades').focus();
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible ?? false).toBe(false);
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.locator('.three-mode-radius-value')).toContainText(String(keyboardValue));

    // A pointer drag previews continuously but defers its expensive buildings request to release.
    const box = await slider.boundingBox();
    if (!box) throw new Error('No building-load-radius slider');
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.98, box.y + box.height / 2, { steps: 8 });
    const draggedValue = Number(await slider.inputValue());
    expect(draggedValue).toBeGreaterThan(keyboardValue);
    await expect.poll(async () => (await modelRadiusPreview(page))?.radiusMeters).toBe(draggedValue);
    await expect.poll(async () => (await modelRadiusPreview(page))?.ringRadius).toBeCloseTo(draggedValue, -1);
    expect(requests).toHaveLength(2);
    await page.mouse.up();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].buffer_meters).toBeGreaterThan(requests[1].buffer_meters);
    expect(requests[2].geometry).toEqual(initial.geometry);
    const saved = await slider.inputValue();
    await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
    await page.locator('#three-mode-facades').focus();
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible ?? false).toBe(false);
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible).toBe(true);
    await closeSheets(page);
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible ?? false).toBe(false);
    await page.locator('#mode-2d-toggle').click();
    await expect.poll(async () => page.evaluate(() => !(window as any).isThreeModeActive?.())).toBe(true);
    await enter3D(page);
    await openModelLayers(page);
    await expect(slider).toHaveValue(saved);
    await expect(page.locator('.three-mode-radius-value')).toContainText(saved);
    const reopenedBox = await slider.boundingBox();
    if (!reopenedBox) throw new Error('No building-load-radius slider after re-entry');
    await page.mouse.move(reopenedBox.x + reopenedBox.width * 0.45, reopenedBox.y + reopenedBox.height / 2);
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible).toBe(true);
    await page.locator('#mode-2d-toggle').click();
    await expect.poll(async () => page.evaluate(() => !(window as any).isThreeModeActive?.())).toBe(true);
  });

  test('Planned modes, massing/build-out, reroll and every facade style affect the actual scene', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    const id = await createBuilding(page, 'max');
    const source = await proposalState(page, id);
    await enter3D(page);
    await openPlanningViews(page);
    await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'off');
    const geometry = () => page.evaluate(() => {
      const meshes: any[] = [];
      (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => {
        if (!o.isMesh || o.userData?.isNearbyBuilding3D || !o.userData?.cbFacadeOwned) return;
        const positions = o.geometry.attributes.position.array;
        let hash = 0;
        for (let i = 0; i < positions.length; i++) hash += Math.round(positions[i] * 100) * (i + 1);
        meshes.push({ count: positions.length, hash, opacity: o.material.userData.cbBuildingOpacity ?? o.material.opacity });
      });
      return meshes;
    });
    await selectNativeOption(page.locator('[data-planning-setting="proposed"]'), 'solid');
    await expect.poll(async () => (await geometry()).length).toBeGreaterThan(0);
    expect((await geometry()).every(m => m.opacity === 1)).toBe(true);
    await selectNativeOption(page.locator('[data-planning-setting="proposed"]'), 'ghost');
    await expect.poll(async () => (await geometry()).every(m => m.opacity < 1)).toBe(true);
    await selectNativeOption(page.locator('[data-planning-setting="proposed"]'), 'off');
    await expect.poll(async () => (await geometry()).length).toBe(0);
    await selectNativeOption(page.locator('[data-planning-setting="proposed"]'), 'solid');

    const allMeshes = () => page.evaluate(() => {
      let count = 0;
      (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => { if (o.isMesh && o.geometry?.attributes?.position?.count) count++; });
      return count;
    });
    await selectNativeOption(page.locator('[data-planning-setting="proposedForm"]'), 'massing');
    const massingCount = await allMeshes();
    await selectNativeOption(page.locator('[data-planning-setting="proposedForm"]'), 'buildout');
    await expect.poll(async () => (await geometry()).length).toBeGreaterThan(0);
    const buildoutCount = await allMeshes();
    const beforeReroll = await geometry();
    const permittedBeforeRoll = await page.evaluate(() => (window as any).PlanningViews.getState().permittedVariation);
    // A valid realization can repeat; exercise up to five fresh samples of the height range.
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.locator('#planning-reroll').click();
      await expect(page.locator('#planning-reroll')).toBeEnabled();
      if (JSON.stringify(await geometry()) !== JSON.stringify(beforeReroll)) break;
    }
    expect(await geometry()).not.toEqual(beforeReroll);
    expect(await page.evaluate(() => (window as any).PlanningViews.getState().permittedVariation)).toBe(permittedBeforeRoll);
    await selectNativeOption(page.locator('[data-planning-setting="proposedForm"]'), 'both');
    await expect.poll(allMeshes).toBeGreaterThan(Math.max(massingCount, buildoutCount));
    expect(await proposalState(page, id)).toEqual(source);

    // The facade controls belong to the Layers sheet; switch back from Planning Views before
    // querying or changing them. The two control sheets are mutually exclusive.
    await openModelLayers(page);
    const uniforms = () => page.evaluate(() => {
      return (window as any).getThreeModeInternals().renderer.info.programs.map((program: any) => {
        const map = program.getUniforms().map;
        return { enabled: map.cbFacadeEnabled?.cache?.[0], style: map.cbFacadeStyleOverride?.cache?.[0] };
      }).filter((p: any) => p.enabled !== undefined);
    });
    await page.locator('#three-mode-facades').check();
    await expect.poll(async () => (await uniforms()).some((p: any) => p.enabled === 1)).toBe(true);
    const styles = await page.locator('#three-mode-facade-style option').evaluateAll(options => options.map((o: any) => o.value));
    for (let index = 0; index < styles.length; index++) {
      await selectNativeOption(page.locator('#three-mode-facade-style'), styles[index]);
      await expect.poll(async () => (await uniforms()).some((p: any) => p.style === index - 1)).toBe(true);
    }
    await page.locator('#three-mode-facades').uncheck();
    await expect.poll(async () => (await uniforms()).every((p: any) => p.enabled === 0)).toBe(true);
    await expect(page.locator('#three-mode-facade-style')).toBeDisabled();
  });
});

test('X-ray and Suggested layouts buttons render and remove real generated floor plans', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await createBuilding(page);
  await enter3D(page);
  await openModelLayers(page);
  const xray = page.locator('#three-mode-xray');
  const suggested = page.locator('#three-mode-suggested-layouts');
  const floorPlans = () => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans')?.children.length || 0);
  await expect(xray).toHaveAttribute('aria-pressed', 'false');
  await expect(suggested).toBeHidden();
  await xray.click();
  await expect(xray).toHaveAttribute('aria-pressed', 'true');
  await expect(suggested).toBeVisible();
  await expect(page.locator('#three-mode-xray-note')).toBeVisible();
  await suggested.click();
  await expect(suggested).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(floorPlans, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator('#three-mode-xray-note')).toContainText('Suggested layouts');
  await suggested.click();
  await expect(suggested).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(floorPlans).toBe(0);
  await xray.click();
  await expect(suggested).toBeHidden();
  await expect(page.locator('#three-mode-xray-note')).toBeHidden();
});

test('3D suggested-existing toggle and floor cutaway change rendered floor plans', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await page.route('**/buildings?*', route => route.fulfill({ json: {
    source: 'gdi',
    ...surveyResponse([{
      type: 'Feature',
      properties: { object_id: 91001, height_m: 18, floors: 5, building: 'yes' },
      geometry: { type: 'Polygon', coordinates: [[[15.98270,45.80029],[15.98284,45.80029],[15.98284,45.80043],[15.98270,45.80043],[15.98270,45.80029]]] },
    }]),
  } }));
  await openCity(page);
  await openLayerSection(page, 'buildings');
  await page.locator('#showBuildings').check();
  await expect.poll(() => page.evaluate(() => (window as any).buildingFeaturePool
    ?.some((feature: any) => feature.properties?.object_id === 91001) ?? false)).toBe(true);
  await closeSheets(page);
  await enter3D(page);
  await openModelLayers(page);

  const xray = page.locator('#three-mode-xray');
  const suggested = page.locator('#three-mode-suggested-layouts');
  await xray.click();
  await suggested.click();
  const existingToggle = page.locator('#three-mode-suggested-existing');
  await expect(existingToggle).toBeVisible();
  await expect(existingToggle).not.toBeChecked();
  const existingFloorPlans = () => page.evaluate(() => {
    const floors = (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans');
    return floors?.children.filter((group: any) => group.userData?.suggested
      && group.userData?.proposalId == null && group.userData?.parcelId == null).length || 0;
  });
  await existingToggle.check();
  await expect.poll(existingFloorPlans).toBeGreaterThan(0);
  await expect(page.locator('#three-mode-xray-note')).toContainText(/Existing: [1-9]/);

  const floorCutaway = page.locator('#three-mode-floor-cutaway');
  await expect(floorCutaway).toBeEnabled();
  const visibleFloorCount = () => page.evaluate(() => {
    const plans = (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans');
    return plans?.children.reduce((count: number, group: any) => count
      + group.children.filter((floor: any) => floor.userData?.cbFloorPlanFloor && floor.visible !== false).length, 0) || 0;
  });
  const allFloors = await visibleFloorCount();
  expect(allFloors).toBeGreaterThan(1);
  const levels = await floorCutaway.locator('option').evaluateAll(options => options.map((option: any) => option.value).filter((value: string) => value !== 'all'));
  expect(levels.length).toBeGreaterThan(0);
  await selectNativeOption(floorCutaway, levels[Math.floor(levels.length / 2)]);
  await expect.poll(visibleFloorCount).toBeLessThan(allFloors);
  await selectNativeOption(floorCutaway, 'all');
  await expect.poll(visibleFloorCount).toBe(allFloors);
});

test('3D trees use real instanced geometry, toggle off and restore their saved preference', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  const layerUrls: string[] = [], treeBodies: any[] = [];
  await page.route('**/decor/layers**', route => { layerUrls.push(route.request().url()); return route.fulfill({ json: { layers: ['trees'] } }); });
  await page.route('**/decor/near', route => { treeBodies.push(route.request().postDataJSON()); return route.fulfill({ json: { trees: [[15.9822, 45.8002], [15.9827, 45.8003]] } }); });
  await openCity(page);
  await enter3D(page);
  await openModelLayers(page);
  // Scenery is asked for by place (location-first.md): the box in view and the scene's geometry, no city.
  const layersQuery = new URL(layerUrls.at(-1)!).searchParams;
  expect(layersQuery.get('bbox')).toMatch(/^-?\d+\.\d+(,-?\d+\.\d+){3}$/);
  expect(layersQuery.has('city')).toBe(false);
  await expect.poll(() => treeBodies.length).toBeGreaterThan(0);
  expect(treeBodies[0].geometry).toBeTruthy();
  expect(treeBodies[0].city).toBeUndefined();
  const trees = page.locator('.three-mode-trees-toggle').filter({ hasText: 'Trees' }).locator('input');
  const instances = () => page.evaluate(() => {
    const counts: number[] = [];
    (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.isInstancedMesh && o.visible && o.parent.visible && ['5c3d1e', '3a6b35'].includes(o.material.color.getHexString())) counts.push(o.count); });
    return counts;
  });
  await expect(trees).toBeChecked();
  await expect.poll(instances).toEqual([2, 2]);
  await trees.uncheck();
  await expect.poll(instances).toEqual([]);
  await closeSheets(page);
  await page.locator('#mode-2d-toggle').click();
  await enter3D(page);
  await openModelLayers(page);
  await expect(trees).not.toBeChecked();
  await expect.poll(instances).toEqual([]);
  await trees.check();
  await expect.poll(instances).toEqual([2, 2]);
});

test('3D selection isolates a proposal and Show all restores the surrounding scene', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await openLayerSection(page, 'buildings');
  await page.locator('#showBuildings').check();
  await closeSheets(page);
  const proposalId = await createSpace(page, 'park');
  await enter3D(page);
  // Aim the real canvas click at this proposal's rendered pick surface. A canvas-center click can
  // land on an unrelated observed building, which selects that source instead of the authored park.
  const point = await rayVerifiedPickPoint(page, 'proposal', proposalId);
  await page.mouse.click(point.x, point.y);
  // Isolation is announced by a banner whose close button restores the scene (Show-all button removed in fbe3758d).
  const banner = page.locator('.three-mode-isolation-banner');
  const reset = banner.locator('.isolation-banner-close');
  await expect(banner).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.())).toBe(proposalId);
  await expect(banner.locator('.isolation-banner-label')).toHaveText('Design view');
  const visibleBuildings = () => page.evaluate(() => {
    let count = 0;
    (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.userData?.isNearbyBuilding3D && o.visible) count++; });
    return count;
  });
  const isolated = await visibleBuildings();
  await reset.click();
  await expect(banner).toBeHidden();
  await expect.poll(visibleBuildings).toBeGreaterThan(isolated);
});
