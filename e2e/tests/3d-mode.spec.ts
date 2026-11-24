import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, createBuilding, proposalState } from '../helpers/runtime';
import { buildings3D, mockBuildingScene, mockFootprintCells } from '../helpers/mocks/building-data';
import { mockPhotoTiles } from '../helpers/mocks/photo-data';
import { openLayerSection, openPlanningSection } from '../helpers/layers';
import { Page } from '@playwright/test';

async function enter3D(page: Page) {
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.())).toBe(true);
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
// Measure the ring drawn by the model's Building appearance radius control.
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
// meshes visible through their whole ancestor chain are actually drawn. `lng` is the footprint
// centre's longitude, which tells the fixture's two buildings apart (101 on parcel 1234, 102 on 1235).
async function sceneBuildings(page: Page) {
  return page.evaluate(() => {
    const meshes: any[] = [];
    (window as any).getThreeModeInternals().scene.traverseVisible((o: any) => {
      if (o.userData?.isNearbyBuilding3D) meshes.push({ vertices: o.geometry.attributes.position.count, opacity: o.material.userData?.cbBuildingOpacity ?? o.material.opacity, color: o.material.color.getHex(),
        lng: +Number(o.userData.footprintLatLng?.[0]).toFixed(5) });
    });
    return meshes;
  });
}
// The fixture parcels' longitude spans (parcel-data.ts): the parcel view (d1c8c3c53) keeps only
// the buildings whose footprint centre lies on the opened parcel.
const PARCEL_LNG: Record<string, [number, number]> = { 'HR-335754-1234': [15.9819, 15.9825], 'HR-335754-1235': [15.9826, 15.9832] };
const standsOn = (building: { lng: number }, parcelId: string) => building.lng > PARCEL_LNG[parcelId][0] && building.lng < PARCEL_LNG[parcelId][1];
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
  for (const width of [1280, 390]) {
    test(`first design pick preserves camera and outlines its volume at ${width}px`, async ({ mockApi: page }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 844 });
      await mockBuildingScene(page);
      await openCity(page);
      const id = await createBuilding(page);
      await enter3D(page);
      await closeSheets(page);
      await page.keyboard.press('Escape');
      const camera = () => page.evaluate(() => {
        const { camera, controls } = (window as any).getThreeModeInternals();
        return { position: camera.position.toArray().map((n: number) => +n.toFixed(6)), target: controls.target.toArray().map((n: number) => +n.toFixed(6)), zoom: camera.zoom };
      });
      const before = await camera();
      const point = await rayVerifiedPickPoint(page, 'proposal', id);
      await page.mouse.click(point.x, point.y);
      const design = page.locator('#three-click-stack .click-stack__section[data-kind="designs"]');
      await expect(design).toHaveClass(/is-expanded/);
      const focus = () => page.evaluate(() => {
        const group = (window as any).getThreeModeInternals().scene.getObjectByName('click-stack-focus');
        if (!group) return null;
        const geometry = group.children[1].geometry;
        const start = geometry.attributes.instanceStart;
        const end = geometry.attributes.instanceEnd;
        const z = [...Array(start.count)].flatMap((_, i) => [start.getZ(i), end.getZ(i)]);
        return { ...group.userData, height: Math.max(...z) - Math.min(...z),
          color: group.children[1].material.color.getHex(), width: group.children[1].material.linewidth };
      });
      await expect.poll(focus).toMatchObject({ kind: 'designs', id, representation: 'volume', pattern: 'outline', color: 0xffdd00, width: 4 });
      expect((await focus())!.height).toBeGreaterThan(3);
      expect(await camera()).toEqual(before);
      await expect(page.locator('.three-mode-isolation-banner')).toBeHidden();
      // Collapse, reopen and refresh all retain the same selection and view.
      await design.locator('.click-stack__row').click();
      await expect(design).toHaveClass(/is-selected/);
      await expect(design.locator('.click-stack__body')).toHaveCount(0);
      expect(await camera()).toEqual(before);
      await expect.poll(focus).toMatchObject({ representation: 'volume', id });
      await design.locator('.click-stack__row').click();
      await page.evaluate(() => (window as any).ThreeClickStack.refresh());
      expect(await camera()).toEqual(before);
      await page.screenshot({ path: `/private/tmp/selection-volume-${width}.png` });
    });
  }

  test('mobile park design hatches its surface while the coincident parcel stays unfilled', async ({ mockApi: page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBuildingScene(page);
    await openCity(page);
    const id = await createSpace(page, 'park');
    await enter3D(page);
    await closeSheets(page);
    await page.evaluate(id => (window as any).showThreeModeDesign(id), id);
    const selection = () => page.evaluate(() => {
      const group = (window as any).getThreeModeInternals().scene.getObjectByName('click-stack-focus');
      return group ? { ...group.userData, hatches: group.children.filter((o: any) => o.userData.selectionHatch).length } : null;
    });
    await expect.poll(selection).toMatchObject({ kind: 'designs', representation: 'ground', pattern: 'hatch', hatches: 1 });
    const stack = page.locator('#three-click-stack');
    await page.screenshot({ path: '/private/tmp/selection-ground-design-390.png' });
    // An applied park forms the ground it stands on, so the coincident parcel is the Formed section (fa52dcba8).
    await stack.locator('.click-stack__object-tab[data-kind="formed"]').click();
    await expect.poll(selection).toMatchObject({ kind: 'formed', representation: 'ground', pattern: 'outline', hatches: 0 });
    await page.screenshot({ path: '/private/tmp/selection-ground-parcel-390.png' });
    await page.keyboard.press('Escape');
    await expect.poll(selection).toBeNull();
  });

  test('a repeated scene pick keeps the stack and camera and re-opens its own section, including after refresh', async ({ mockApi: page }) => {
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
      return { position: camera.position.toArray().map((n: number) => +n.toFixed(6)), target: controls.target.toArray().map((n: number) => +n.toFixed(6)), zoom: camera.zoom };
    });
    const before = await camera();
    const stack = page.locator('#three-click-stack');
    const expanded = () => page.evaluate(() => (window as any).ThreeClickStack.expanded());
    await page.mouse.click(point.x, point.y);
    await expect.poll(expanded).toBe('parcels');
    // The parcel's own references put the design on it into the stack.
    expect(await page.evaluate(() => (window as any).ThreeClickStack.current().sections.map((section: any) => section.kind))).toContain('designs');
    // A collapsed stack: the same parcel picked again re-opens the parcel's own section, never the next one.
    const parcelRow = stack.locator('.click-stack__section[data-kind="parcels"] [data-action="row"]');
    for (let repeat = 0; repeat < 2; repeat++) {
      await parcelRow.click();
      await expect.poll(expanded).toBe(null);
      await page.mouse.click(point.x, point.y);
      await expect.poll(expanded).toBe('parcels');
      await expect(stack).toBeVisible();
      expect(await camera()).toEqual(before);
    }
    await page.evaluate(() => (window as any).ThreeClickStack.refresh());
    expect(await camera()).toEqual(before);
    // Opening the Design row selects the unapplied design, whose preview is then drawn over the
    // parcel: the same point now hits that design, the topmost object there, and keeps it.
    await stack.locator('.click-stack__section[data-kind="designs"] [data-action="row"]').click();
    await expect.poll(expanded).toBe('designs');
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.mouse.click(point.x, point.y);
      await expect.poll(expanded).toBe('designs');
      await expect(stack).toBeVisible();
      expect(await camera()).toEqual(before);
    }
    await page.keyboard.press('Escape');
    await expect(stack).toBeHidden();
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
        // The open Parcel section is the parcel view: only the one building standing on it is drawn,
        // and the global display setting governs it.
        const onParcel = async () => {
          const buildings = await sceneBuildings(page);
          return buildings.length === 1 && standsOn(buildings[0], parcelId) ? buildings[0] : null;
        };
        await expect.poll(async () => !!(await onParcel())).toBe(true);
        await selectNativeOption(display, 'ghost');
        await expect.poll(async () => ((await onParcel())?.opacity ?? 1) < 1).toBe(true);
        await selectNativeOption(display, 'off');
        await expect.poll(async () => (await sceneBuildings(page)).length).toBe(0);
        await selectNativeOption(display, 'solid');
        await expect.poll(async () => (await onParcel())?.opacity).toBe(1);
      }
      await closeSheets(page);
      await page.keyboard.press('Escape');
      // Leaving the parcel view shows the whole city again.
      await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
      await openPlanningViews(page);
      await expect(display).toHaveValue('solid');
      await expect(panel.locator('.planning-focus, .planning-parcel-evidence')).toHaveCount(0);
    });
  }

  test('mode buttons stay lower left and parcel clicks preserve camera and materials with a yellow boundary', async ({ mockApi: page }) => {
    await mockBuildingScene(page); await openCity(page);
    // The strip stays lower-left; 3D releases the space formerly reserved for bottom navigation.
    // (The original-cadastre toggle moved into the 2D Layers sheet in fbe3758d.)
    const modeIds = ['mode-2d-toggle', 'mode-3d-toggle', 'mode-realistic-toggle'];
    const modeBoxes = () => Promise.all(modeIds.map(async id => await page.locator('#' + id).boundingBox()));
    const flat = await modeBoxes();
    await enter3D(page);
    await openPlanningSection(page, 'building-appearance');
    await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'solid');
    await closeSheets(page);
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(2);
    const originalBuildings = await sceneBuildings(page);
    const perspective = await modeBoxes();
    perspective.forEach((box, i) => {
      expect(box!.x).toBeLessThan(30); expect(box!.y).toBeGreaterThan(page.viewportSize()!.height / 2);
      expect(box!.x).toBe(flat[i]!.x);
      expect(box!.y).toBeGreaterThanOrEqual(flat[i]!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    });
    const camera = () => page.evaluate(() => {
      const { camera, controls } = (window as any).getThreeModeInternals();
      return { position: camera.position.toArray().map((n: number) => +n.toFixed(6)), target: controls.target.toArray().map((n: number) => +n.toFixed(6)), zoom: camera.zoom };
    });
    const point = await rayVerifiedPickPoint(page, 'parcel', 'HR-335754-1234');
    const before = await camera();
    await page.mouse.click(point.x, point.y);
    // The parcel's figures open in the Parcel section of the 3D click stack.
    await expect(page.locator('#three-click-stack .click-stack__section[data-kind="parcels"].is-expanded')).toBeVisible();
    const parcelPanel = page.locator('#three-click-stack .three-mode-parcel-panel');
    await expect(page.locator('#three-click-stack [data-page="actions"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('#three-click-stack [data-page="stats"]').click();
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
    // Built is opened through its row; a repeat pick of the parcel then opens the parcel's own
    // section again, keeping the camera steady.
    const stack = page.locator('#three-click-stack');
    const kinds = await stack.locator('.click-stack__section').evaluateAll(sections => sections.map(section => (section as HTMLElement).dataset.kind!));
    expect(kinds[0]).toBe('built');
    await stack.locator('.click-stack__section[data-kind="built"] [data-action="row"]').click();
    await expect(page.locator('.three-mode-isolation-banner')).toBeHidden();
    await expect(page.locator('#three-click-stack')).toBeVisible();
    await expect(stack.locator('.click-stack__section[data-kind="built"].is-expanded')).toBeVisible();
    await expect(parcelPanel).toBeHidden();
    expect(await camera()).toEqual(before);
    // The remaining headers stay discoverable beneath the short Built record.
    const builtCard = stack.locator('.click-stack__section[data-kind="built"]');
    await expect(builtCard.locator('#planning-inspector.is-hosted')).toBeVisible();
    await expect(page.locator('#planning-inspector')).toHaveCount(1);
    expect((await builtCard.boundingBox())!.height).toBeLessThan(500);
    await expect(stack.locator('.click-stack__section[data-kind="parcels"] .click-stack__row')).toBeInViewport();
    await page.mouse.click(point.x, point.y);
    await expect(stack.locator('.click-stack__section[data-kind="parcels"].is-expanded')).toBeVisible();
    await expect(stack.locator('.click-stack__section[data-kind="built"].is-expanded')).toHaveCount(0);
    expect(await camera()).toEqual(before);
    await expect(parcelPanel).toBeVisible();
    expect(await camera()).toEqual(before);
    // The open Parcel section is the parcel view (d1c8c3c53): the building standing on the parcel
    // stays, in its own material; the other is hidden, not rebuilt.
    const buildings = await sceneBuildings(page);
    expect(buildings).toEqual(originalBuildings.filter(building => standsOn(building, 'HR-335754-1234')));
    expect(buildings).toHaveLength(1);
    expect(await page.evaluate(() => {
      let selected = false;
      (window as any).getThreeModeInternals().scene.traverse((o: any) => {
        if (o.isMesh && o.userData?.parcelId === 'HR-335754-1234' && o.material.color?.getHex() === 0xffdd00) selected = true;
      });
      return selected;
    })).toBe(false);
    const selection = await page.evaluate(() => {
      const group = (window as any).getThreeModeInternals().scene.getObjectByName('click-stack-focus');
      return { ...group.userData, strokes: group.children.map((o: any) => ({ color: o.material.color.getHex(), width: o.material.linewidth })) };
    });
    expect(selection).toMatchObject({ kind: 'parcels', representation: 'ground', strokes: [{ color: 0x292000, width: 7 }, { color: 0xffdd00, width: 4 }] });
    const visible = await page.evaluate(() => {
      let count = 0;
      (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.userData?.isNearbyBuilding3D && o.visible && o.parent.visible) count++; });
      return count;
    });
    expect(visible).toBe(1);
    // Escape clears the retained parcel view and closes its click stack.
    await page.keyboard.press('Escape');
    await expect(page.locator('.three-mode-isolation-banner')).toBeHidden();
    await expect(page.locator('#three-click-stack')).toBeHidden();
    expect(await camera()).toEqual(before);
    // Leaving the parcel view shows exactly what it hid.
    expect(await sceneBuildings(page)).toEqual(originalBuildings);
    await page.screenshot({ path: '/private/tmp/colosseum-3d-parcel-emphasis.png' });
  });
  test('3D enters with real building meshes, orbit and zoom work, and 2D returns', async ({ mockApi: page }) => {
    await mockBuildingScene(page);
    await openCity(page);
    await enter3D(page);
    await openPlanningSection(page, 'building-appearance');
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
    await openPlanningSection(page, 'building-appearance');
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

  test('Built Off flattens a mapped building and leaves its courtyard open after reload on mobile', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockBuildingScene(page);
    const building = structuredClone(buildings3D[0]);
    const hole = [
      [15.98213, 45.80013, 14], [15.98213, 45.80019, 14], [15.98219, 45.80019, 14],
      [15.98219, 45.80013, 14], [15.98213, 45.80013, 14]
    ];
    building.faces[0].coordinates.push(hole);
    const cellRequests: unknown[] = [];
    await page.route('**/buildings/cell', async route => {
      const body = route.request().postDataJSON();
      if (body.kind !== 'near') return route.fallback();
      cellRequests.push(body);
      await route.fulfill({ json: { supported: true, kind: body.kind, bbox: body.bbox, complete: true, items: [building] } });
    });
    await openCity(page);
    await enter3D(page);
    await page.locator('#planning-views-button').press('Enter');
    await expect(page.locator('#planning-views')).toBeVisible();
    const display = page.locator('[data-planning-setting="existing"]');
    await selectNativeOption(display, 'solid');
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(1);
    await page.waitForFunction(() => !(window as any).PlanningLoading.state().existing);
    const requestCount = cellRequests.length;
    const ground = () => page.evaluate(() => {
      const { scene, latLngToXY } = (window as any).getThreeModeInternals?.() || {};
      if (!scene) return null;
      const batch = scene.getObjectByName('ExistingBuildingFootprints');
      if (!batch?.visible) return null;
      const { Vector3, Raycaster, Mesh } = (window as any).THREE;
      const hits = (lat: number, lng: number) => {
        const [x, y] = latLngToXY(lat, lng);
        const ray = new Raycaster(new Vector3(x, y, 50), new Vector3(0, 0, -1));
        const intersections: { point: { z: number } }[] = [];
        Mesh.prototype.raycast.call(batch, ray, intersections);
        return intersections[0]?.point.z ?? null;
      };
      return { roof: hits(45.80011, 15.98211), courtyard: hits(45.80016, 15.98216) };
    });
    await selectNativeOption(display, 'off');
    await expect(display).toHaveValue('off');
    await expect.poll(ground).toEqual({ roof: 0, courtyard: null });
    expect(await sceneBuildings(page)).toHaveLength(0);
    expect(cellRequests).toHaveLength(requestCount);

    await page.reload();
    await expect.poll(ground).toEqual({ roof: 0, courtyard: null });
    await openPlanningViews(page);
    await selectNativeOption(display, 'solid');
    await expect.poll(ground).toBeNull();
    await expect.poll(async () => (await sceneBuildings(page)).length).toBe(1);
  });

  test('radius preview follows hover, keyboard, and drag in Building appearance, then refetches on release', async ({ mockApi: page }) => {
    const requests = await mockBuildingScene(page);
    // A load asks for the building cells it has not seen yet; wait until a load has asked for all of them.
    const settled = async () => {
      let seen = -1;
      await expect.poll(() => { const now = requests.length; const same = now > 0 && now === seen; seen = now; return same; }, { intervals: [750] }).toBe(true);
      return seen;
    };
    // Each finished load says its radius ('[3D] Loaded … (camera+300m)'); cached cells are not asked again.
    const loads: string[] = [];
    page.on('console', message => { const m = message.text().match(/\[3D\] Loaded \d+ nearby 3D buildings .*\+(\d+)m/); if (m) loads.push(m[1]); });
    await openCity(page);
    await enter3D(page);
    const initialCells = await settled();
    await openPlanningSection(page, 'building-appearance');
    const slider = page.locator('#planning-building-appearance .three-mode-radius-slider');
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
    expect(requests).toHaveLength(initialCells);
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
    await expect.poll(() => loads).toContain(String(keyboardValue));
    const keyboardCells = await settled();
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
    expect(requests).toHaveLength(keyboardCells);
    expect(loads).not.toContain(String(draggedValue));
    await page.mouse.up();
    await expect.poll(() => loads).toContain(String(draggedValue));
    expect(requests.length).toBeGreaterThan(initialCells);
    // Every load is around the same anchor: a wider radius asks only for cells not loaded before.
    expect(requests.every(request => request.kind === 'near')).toBe(true);
    expect(new Set(requests.map(request => request.bbox.join())).size).toBe(requests.length);
    const saved = await slider.inputValue();
    await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
    await page.locator('#three-mode-facades').focus();
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible ?? false).toBe(false);
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible).toBe(true);
    await page.locator('#planning-views [data-sheet-close]').click();
    await expect.poll(async () => (await modelRadiusPreview(page))?.visible ?? false).toBe(false);
    await page.locator('#mode-2d-toggle').click();
    await expect.poll(async () => page.evaluate(() => !(window as any).isThreeModeActive?.())).toBe(true);
    await enter3D(page);
    await openPlanningSection(page, 'building-appearance');
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

    // Facade controls belong to the Buildings and massing appearance section.
    await openPlanningSection(page, 'building-appearance');
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

test('X-ray toolbar scopes proposed layouts and closes by keyboard', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await createBuilding(page);
  await enter3D(page);
  await openPlanningSection(page, 'floor-plans');
  const xray = page.locator('#three-mode-xray');
  const floorPlans = () => page.evaluate(() => (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans')?.children.length || 0);
  await expect(xray).toHaveAttribute('aria-pressed', 'false');
  await xray.click();
  await expect(page.locator('#three-xray-toolbar')).toHaveAttribute('aria-label', 'X-ray');
  const proposed = page.locator('#three-xray-proposed');
  const built = page.locator('#three-xray-built');
  await proposed.click();
  await expect(proposed).toHaveAttribute('aria-pressed', 'true');
  await expect(built).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/xray=proposed/);
  await expect.poll(floorPlans, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.locator('#three-xray-close').focus();
  await page.locator('#three-xray-close').press('Enter');
  await expect(page.locator('#three-xray-toolbar')).toBeHidden();
  await expect(page).not.toHaveURL(/xray=/);
});

test('X-ray toolbar stays in Photo for Proposed and opens the model for Built', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  await mockBuildingScene(page);
  const tiles = await mockPhotoTiles(page);
  await openCity(page);
  await page.locator('#mode-realistic-toggle').click();
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/, { timeout: 15_000 });
  await expect.poll(tiles.requests, { timeout: 20_000 }).toBeGreaterThan(0);
  await openPlanningSection(page, 'floor-plans');
  await page.locator('#three-mode-xray').click();
  await expect(page.locator('#three-xray-toolbar')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/realistic-mode-active/);
  await expect(page.locator('.map-sheet:visible')).toHaveCount(0);
  await expect(page.locator('#three-xray-proposed')).toBeFocused();
  await page.locator('#three-xray-built').press('Enter');
  await expect(page.locator('body')).not.toHaveClass(/realistic-mode-active/);
  await expect(page.locator('#three-xray-built')).toHaveAttribute('aria-pressed', 'true');
});

test('X-ray built scope reveals an initially hidden existing layer and restores it on close', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await mockFootprintCells(page, () => [{ id: 91001, height_m: 18, floors: 5, building: 'yes',
    geometry: { type: 'Polygon', coordinates: [[[15.98270,45.80029],[15.98284,45.80029],[15.98284,45.80043],[15.98270,45.80043],[15.98270,45.80029]]] } }]);
  await openCity(page);
  await openPlanningSection(page, 'building-appearance');
  await expect(page.locator('[data-planning-setting="existing"]')).toHaveValue('off');
  await closeSheets(page);
  await enter3D(page);
  // Suggested existing layouts are built only for visible buildings close to the camera.
  expect(await page.evaluate(() => (window as any).applyThree3DGeoView({
    targetLat: 45.80036, targetLng: 15.98277, pitchRad: -Math.PI / 4, range: 75,
  }))).toBe(true);
  await openPlanningSection(page, 'floor-plans');

  const xray = page.locator('#three-mode-xray');
  await page.setViewportSize({ width: 390, height: 844 });
  await xray.click();
  const built = page.locator('#three-xray-built');
  await built.click();
  await expect(built).toBeFocused();
  await expect(built).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#three-xray-proposed')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => (window as any).buildingFeaturePool
    ?.some((feature: any) => feature.properties?.id === 91001) ?? false)).toBe(true);
  const buildingVisibility = () => page.evaluate(() => {
    const scene = (window as any).getThreeModeInternals().scene;
    return {
      existing: scene.getObjectByName('ExistingBuildings')?.visible === true,
      proposed: scene.getObjectByName('ProposedBuildings')?.visible === true,
    };
  });
  await expect.poll(buildingVisibility).toMatchObject({ existing: true, proposed: false });
  const toolbarBox = await page.locator('#three-xray-toolbar').boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.x).toBeGreaterThanOrEqual(0);
  expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(390);
  const existingFloorPlans = () => page.evaluate(() => {
    const floors = (window as any).getThreeModeInternals().scene.getObjectByName('FloorPlans');
    return floors?.children.filter((group: any) => group.userData?.suggested
      && group.userData?.proposalId == null && group.userData?.parcelId == null).length || 0;
  });
  await expect.poll(existingFloorPlans).toBeGreaterThan(0);
  await expect(page.locator('[data-planning-setting="existing"]')).toHaveValue('off');

  await openPlanningSection(page, 'floor-plans');
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
  await closeSheets(page);
  await page.locator('#three-xray-close').click();
  await expect(page.locator('#three-xray-toolbar')).toBeHidden();
  await openPlanningSection(page, 'building-appearance');
  await expect(page.locator('[data-planning-setting="existing"]')).toHaveValue('off');
  await expect.poll(buildingVisibility).toMatchObject({ existing: false });
});

test('3D trees use real instanced geometry, toggle off and restore their saved preference', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  const layerUrls: string[] = [], treeQueries: URLSearchParams[] = [];
  await page.route('**/decor/layers**', route => { layerUrls.push(route.request().url()); return route.fulfill({ json: { layers: ['trees'] } }); });
  await page.route(/\/decor\/near\?/, route => {
    expect(route.request().method()).toBe('GET');
    treeQueries.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { trees: [[15.9822, 45.8002], [15.9827, 45.8003]] } });
  });
  await openCity(page);
  await enter3D(page);
  await openLayerSection(page, 'scenery');
  // Scenery is asked for by place (location-first.md): the box in view and the scene's geometry, no city.
  const layersQuery = new URL(layerUrls.at(-1)!).searchParams;
  expect(layersQuery.get('bbox')).toMatch(/^-?\d+\.\d+(,-?\d+\.\d+){3}$/);
  expect(layersQuery.has('city')).toBe(false);
  await expect.poll(() => treeQueries.length).toBeGreaterThan(0);
  expect(treeQueries[0].get('bbox')).toMatch(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/);
  expect(treeQueries[0].has('city')).toBe(false);
  const trees = page.locator('.three-mode-trees-toggle').filter({ hasText: 'Trees' }).locator('input');
  const instances = () => page.evaluate(() => {
    const counts: number[] = [];
    (window as any).getThreeModeInternals().scene.traverse((o: any) => { if (o.isInstancedMesh && o.visible && o.parent.visible && o.userData.treeShadowStandIn) counts.push(o.count); });
    return counts;
  });
  await expect(trees).toBeChecked();
  await expect.poll(instances).toEqual([2, 2]);
  await trees.uncheck();
  await expect.poll(instances).toEqual([]);
  await closeSheets(page);
  await page.locator('#mode-2d-toggle').click();
  await enter3D(page);
  await openLayerSection(page, 'scenery');
  await expect(trees).not.toBeChecked();
  await expect.poll(instances).toEqual([]);
  await trees.check();
  await expect.poll(instances).toEqual([2, 2]);
});

test('3D selection and deselection retain the surrounding scene', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  await openPlanningSection(page, 'building-appearance');
  await selectNativeOption(page.locator('[data-planning-setting="existing"]'), 'solid');
  await closeSheets(page);
  const proposalId = await createSpace(page, 'park');
  await enter3D(page);
  // Aim the real canvas click at this proposal's rendered pick surface. A canvas-center click can
  // land on an unrelated observed building, which selects that source instead of the authored park.
  const before = await sceneBuildings(page);
  expect(before.length).toBeGreaterThan(0);
  const point = await rayVerifiedPickPoint(page, 'proposal', proposalId);
  await page.mouse.click(point.x, point.y);
  // Selection highlights the authored park while retaining its surrounding building context.
  await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.())).toBe(proposalId);
  await expect(page.locator('#three-click-stack .click-stack__section[data-kind="designs"]')).toHaveClass(/is-selected/);
  await expect(page.locator('.three-mode-isolation-banner')).toBeHidden();
  expect(await sceneBuildings(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('#three-click-stack')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).ProposalSelection?.getKey?.() ?? null)).toBeNull();
  expect(await sceneBuildings(page)).toEqual(before);
});
