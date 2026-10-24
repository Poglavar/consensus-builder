// Purpose: cover whole-site movement, proposal placement persistence, and narrow-screen editor access
// through the visible map and shared editor controls.
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal } from '../helpers/runtime';
import type { Page } from '@playwright/test';

const SITE = {
  type: 'Polygon',
  coordinates: [[[15.9819, 45.8000], [15.9825, 45.8000], [15.9825, 45.8005], [15.9819, 45.8005], [15.9819, 45.8000]]]
};

async function addEditableStructure(page: Page, kind: 'park' | 'square' | 'lake', suffix: string): Promise<{ proposalId: string; draftId: string }> {
  await page.waitForFunction(() => !!(window as any).proposalStorage && !!(window as any).CadastralParcelRepository);
  const id = `placement-e2e-${kind}-${suffix}`;
  await page.evaluate(async ({ id, kind, geometry }) => {
    const w = window as any;
    await w.CadastralParcelRepository.ensureIds(['HR-335754-1234']);
    const decorations = kind === 'park' ? {
      version: 3,
      trees: [[15.98208, 45.80015]],
      flowerbeds: [[[15.98212, 45.80016], [15.98216, 45.80016], [15.98216, 45.80019], [15.98212, 45.80019], [15.98212, 45.80016]]],
      ponds: [[[15.98222, 45.80016], [15.98227, 45.80016], [15.98227, 45.80020], [15.98222, 45.80020], [15.98222, 45.80016]]],
      paths: [[[15.98205, 45.80030], [15.98235, 45.80030]]],
      benches: [{ coordinate: [15.98230, 45.80015], bearing: 35 }]
    } : {
      version: 2,
      trees: [[15.98208, 45.80015]],
      fountains: [[15.98222, 45.80020]],
      benches: [{ coordinate: [15.98230, 45.80015], bearing: 35 }]
    };
    w.proposalStorage.addProposal({
      proposalId: id,
      title: `Placement fixture ${kind}`,
      description: 'E2E geometry movement fixture.',
      offer: 100,
      offerCurrency: 'EUR',
      city: 'zg',
      goal: kind,
      lifecycleStatus: 'Active',
      applied: true,
      cadastreParcelIds: ['HR-335754-1234'],
      structureProposal: { kind, geometry, decorations }
    });
  }, { id, kind, geometry: SITE });
  await showProposal(page, id);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(page.locator('#structure-geometry-editor').locator('.on-map-editor__panel')).toBeVisible();
  const draftId = await page.evaluate(() => (window as any).getActiveProposalDesignDraft?.()?.id || null);
  if (!draftId) throw new Error('Geometry editor did not create an active proposal draft');
  return { proposalId: id, draftId };
}

async function screenPoint(page: Page, lng: number, lat: number) {
  return page.evaluate(({ lng, lat }) => {
    const w = window as any;
    const p = w.map.latLngToContainerPoint([lat, lng]);
    const box = w.map.getContainer().getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  }, { lng, lat });
}

async function dragMapPoint(page: Page, from: [number, number], to: [number, number]) {
  const start = await screenPoint(page, from[0], from[1]);
  const end = await screenPoint(page, to[0], to[1]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

// Read the live, rendered Leaflet geometry. The structure editor intentionally keeps its draft
// payload unchanged until Done, so draft storage is not the source of truth during a gesture.
async function readRenderedStructure(page: Page) {
  return page.evaluate(() => {
    const map = (window as any).map;
    const layers: any[] = [];
    const visit = (layer: any) => {
      if (!layer || layers.includes(layer)) return;
      layers.push(layer);
      if (typeof layer.eachLayer === 'function') layer.eachLayer(visit);
    };
    Object.values(map?._layers || {}).forEach(visit);
    const design: any = { geometry: null, decorations: { trees: [], benches: [] } };
    const appendMarker = (layer: any, key: string) => {
      design.decorations[key] ||= [];
      const point = layer.getLatLng?.();
      if (point) design.decorations[key].push([point.lng, point.lat]);
    };
    for (const layer of layers) {
      const path = layer?._path;
      if (path?.classList?.contains('structure-geometry-boundary')) {
        design.geometry = layer.feature?.geometry || layer.toGeoJSON?.().geometry || null;
      }
      const icon = layer?._icon;
      if (icon?.classList?.contains('is-tree')) appendMarker(layer, 'trees');
      else if (icon?.classList?.contains('is-bench')) appendMarker(layer, 'benches');
      else if (icon?.classList?.contains('is-fountain')) {
        design.decorations.fountains ||= [];
        appendMarker(layer, 'fountains');
      }
      if (!path?.classList?.contains('structure-geometry-draggable')) continue;
      const color = String(path.getAttribute('stroke') || '').toLowerCase();
      const geometry = layer.toGeoJSON?.().geometry;
      if (!geometry) continue;
      if (color === '#f7edc8') (design.decorations.paths ||= []).push(geometry.coordinates);
      else if (color === '#1d4ed8') (design.decorations.ponds ||= []).push(geometry.coordinates?.[0] || []);
      else if (color === '#be185d') (design.decorations.flowerbeds ||= []).push(geometry.coordinates?.[0] || []);
    }
    return JSON.parse(JSON.stringify(design));
  });
}

function expectTranslatedCoordinates(before: any, after: any, delta: [number, number]): void {
  const visit = (left: any, right: any, at: string) => {
    if (Array.isArray(left) && Array.isArray(right)) {
      expect(right).toHaveLength(left.length);
      if (left.length === 2 && left.every(Number.isFinite) && right.every(Number.isFinite)) {
        expect(right[0] - left[0], `${at} longitude`).toBeCloseTo(delta[0], 6);
        expect(right[1] - left[1], `${at} latitude`).toBeCloseTo(delta[1], 6);
        return;
      }
      left.forEach((value, index) => visit(value, right[index], `${at}[${index}]`));
      return;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      expect(Object.keys(right).sort()).toEqual(Object.keys(left).sort());
      Object.keys(left).forEach(key => visit(left[key], right[key], `${at}.${key}`));
      return;
    }
    expect(right, at).toEqual(left);
  };
  visit(before, after, 'structure');
}

function coordinateBounds(value: any): [number, number, number, number] {
  const pairs: number[][] = [];
  const visit = (node: any) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && Number.isFinite(node[0]) && Number.isFinite(node[1])) {
      pairs.push(node);
      return;
    }
    node.forEach(visit);
  };
  visit(value?.coordinates || value);
  if (!pairs.length) throw new Error('Geometry has no coordinate pairs');
  return [
    Math.min(...pairs.map(point => point[0])), Math.min(...pairs.map(point => point[1])),
    Math.max(...pairs.map(point => point[0])), Math.max(...pairs.map(point => point[1]))
  ];
}

function savedStructureForTranslation(structure: any, kind: 'park' | 'square'): any {
  const decorations = structure.decorationDesign || structure.decorations || {};
  return {
    geometry: structure.geometry,
    decorations: kind === 'park'
      ? {
        trees: (decorations.trees || []).map((tree: any) => tree.coordinate || tree),
        benches: (decorations.benches || []).map((bench: any) => bench.coordinate || bench),
        flowerbeds: decorations.flowerbeds || [],
        ponds: decorations.ponds || [],
        paths: decorations.paths || []
      }
      : {
        trees: (decorations.trees || []).map((tree: any) => tree.coordinate || tree),
        benches: (decorations.benches || []).map((bench: any) => bench.coordinate || bench),
        fountains: decorations.fountains || []
      }
  };
}

test.describe('Whole-site placement editing @features', () => {
  test('tree clicks resize the 2D glyph with the stored height and keep the size after saving', async ({ mockApi: page }) => {
    await openCity(page);
    const { proposalId } = await addEditableStructure(page, 'park', 'tree-size');
    const editor = page.locator('#structure-geometry-editor');
    await editor.locator('[data-tool="tree"]').click();
    // Drive the real reroll with deterministic random draws: tallest then shortest columnar tree.
    await page.evaluate(() => {
      const planting = (window as any).__parkPlanting;
      const reroll = planting.rerollTree;
      let clicks = 0;
      planting.rerollTree = (tree: any) => {
        const values = [0.6, clicks++ === 0 ? 1 : 0];
        let index = 0;
        return reroll(tree, () => values[index++ % values.length]);
      };
    });
    const tree = page.locator('.structure-geometry-icon.is-tree').first();
    await tree.click();
    await expect(tree.locator('.park-tree-glyph')).toHaveCSS('font-size', '38px');
    await expect(tree).toHaveCSS('width', '38px');
    await tree.click();
    await expect(tree.locator('.park-tree-glyph')).toHaveCSS('font-size', '23px');
    await expect(tree).toHaveCSS('width', '23px');
    await editor.locator('[data-action="save"]').click();
    await expect(editor).toHaveCount(0);
    const saved = await page.evaluate(id => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.proposalId === id)?.structureProposal.decorationDesign.trees[0], proposalId);
    expect(saved.heightM).toBe(9);
    await showProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    await expect(tree.locator('.park-tree-glyph')).toHaveCSS('font-size', '23px');
    await editor.locator('.on-map-editor__header .close-circle-btn').click();
  });

  test('park and square Move includes decorations, Undo restores the gesture, and individual decoration dragging remains available', async ({ mockApi: page }) => {
    await openCity(page);
    for (const kind of ['park', 'square'] as const) {
      const source = await addEditableStructure(page, kind, 'whole-move');
      const id = source.proposalId;
      const draftId = source.draftId;
      const editor = page.locator('#structure-geometry-editor');
      const before = await readRenderedStructure(page);
      await editor.locator('[data-tool="move"]').click();
      // Start on a visible decoration: Move mode must let the boundary receive the gesture.
      const from: [number, number] = [15.98208, 45.80015];
      const to: [number, number] = [15.98219, 45.80022];
      await dragMapPoint(page, from, to);
      const moved = await readRenderedStructure(page);
      expect(moved).toBeTruthy();
      const originalTree = before.decorations.trees[0];
      const movedTreeBeforeUndo = moved.decorations.trees[0];
      const translation = [movedTreeBeforeUndo[0] - originalTree[0], movedTreeBeforeUndo[1] - originalTree[1]];
      expect(Math.abs(translation[0]) + Math.abs(translation[1])).toBeGreaterThan(0.00001);
      expect(movedTreeBeforeUndo[0]).toBeGreaterThan(originalTree[0]);
      expectTranslatedCoordinates(before, moved, translation as [number, number]);
      const undo = editor.locator('[data-action="undo"]');
      await expect(undo).toBeEnabled();
      await undo.click();
      await expect.poll(async () => readRenderedStructure(page)).toEqual(before);

      // With Move deselected the same seeded tree remains individually draggable.
      await editor.locator('[data-tool="tree"]').click();
      await dragMapPoint(page, [15.98208, 45.80015], [15.98210, 45.80017]);
      await expect.poll(async () => (await readRenderedStructure(page)).decorations.trees[0][0]).toBeGreaterThan(before.decorations.trees[0][0]);
      await undo.click();

      await editor.locator('[data-tool="move"]').click();
      await dragMapPoint(page, from, to);
      await editor.locator('[data-action="save"]').click();
      await expect(editor).toHaveCount(0);
      // The unpublished record is saved in place (c7ef3630): its own tree moves.
      await expect.poll(() => page.evaluate(id => (window as any).proposalStorage.getProposal(id)
        ?.structureProposal?.decorationDesign?.trees?.[0]?.coordinate?.[0] ?? null, id)).toBeGreaterThan(before.decorations.trees[0][0]);
      const fork = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal, id);
      expect(fork).toBeTruthy();
      // A saved tree is a record: its point, kind and height (park-planting.js).
      const movedTree = fork.decorationDesign.trees[0].coordinate;
      expect(movedTree[0]).toBeGreaterThan(before.decorations.trees[0][0]);
      expect(movedTree[1]).toBeGreaterThan(before.decorations.trees[0][1]);
      const delta = [movedTree[0] - before.decorations.trees[0][0], movedTree[1] - before.decorations.trees[0][1]];
      // Done persists the full structure payload; compare every coordinate, including all
      // boundary vertices and furniture, rather than one representative marker.
      expectTranslatedCoordinates(before, savedStructureForTranslation(fork, kind), delta as [number, number]);
      expect(fork.kind).toBe(kind);
      expect(fork.decorationDesign.benches[0].bearing).toBe(35);
    }
  });

  test('lake Move permits free relocation, vertex editing, and saves the relocated outline', async ({ mockApi: page }) => {
    await openCity(page);
    const source = await addEditableStructure(page, 'lake', 'lake-free');
    const id = source.proposalId;
    const originalGeometry = await page.evaluate(id => (window as any).proposalStorage.getProposal(id).structureProposal.geometry, id);
    const originalBounds = coordinateBounds(originalGeometry);
    const editor = page.locator('#structure-geometry-editor');
    await editor.locator('[data-tool="move"]').click();
    await dragMapPoint(page, [15.9822, 45.80025], [15.98272, 45.80062]);
    await expect(page.locator('.on-map-editor__placement-warning')).toBeVisible();
    // Turn Move off to expose the regular lake boundary handles, then drag one vertex farther out.
    await editor.locator('[data-tool="move"]').click();
    const vertex = page.locator('.polygon-geometry-editor__vertex').first();
    await expect(vertex).toBeVisible();
    const box = await vertex.boundingBox();
    if (!box) throw new Error('Lake vertex handle is not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 - 18, { steps: 6 });
    await page.mouse.up();
    await expect(editor.locator('[data-action="save"]')).toBeEnabled();
    await editor.locator('[data-action="save"]').click();
    await expect(editor).toHaveCount(0);
    const savedLake = (id: string) => page.evaluate(id => {
      // The unpublished lake is saved in place (c7ef3630).
      return (window as any).proposalStorage.getProposal(id)?.structureProposal?.geometry || null;
    }, id);
    await expect.poll(async () => {
      const geometry = await savedLake(id);
      if (!geometry) return false;
      const [minLng, minLat, maxLng, maxLat] = coordinateBounds(geometry);
      return minLng > originalBounds[0] + 0.0001
        && minLat > originalBounds[1] + 0.0001
        && maxLng > originalBounds[2] + 0.0001
        && maxLat > originalBounds[3] + 0.0001;
    }).toBe(true);
    const savedGeometry = await savedLake(id);
    expect(savedGeometry).toBeTruthy();
    // Reload the persisted proposal without requiring the original cadastral parcel to remain
    // in the live fabric: applying the lake can legitimately replace that parcel.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).proposalStorage);
    await expect.poll(async () => {
      const geometry = await savedLake(id);
      if (!geometry) return false;
      const [minLng, minLat, maxLng, maxLat] = coordinateBounds(geometry);
      return minLng > originalBounds[0] + 0.0001
        && minLat > originalBounds[1] + 0.0001
        && maxLng > originalBounds[2] + 0.0001
        && maxLat > originalBounds[3] + 0.0001;
    }).toBe(true);
    expect(await savedLake(id)).toEqual(savedGeometry);
  });

  test('station body and centre marker move while preserving type, bearing, and height, including release over the panel', async ({ mockApi: page }) => {
    await openCity(page);
    const id = 'placement-e2e-station-drag';
    const center: [number, number] = [15.9822, 45.80025];
    await page.evaluate(async ({ id, center }) => {
      const w = window as any;
      await w.CadastralParcelRepository.ensureIds(['HR-335754-1234']);
      const [lng, lat] = center;
      const geometry = { type: 'Polygon', coordinates: [[[lng - 0.00008, lat - 0.00004], [lng + 0.00008, lat - 0.00004], [lng + 0.00008, lat + 0.00004], [lng - 0.00008, lat + 0.00004], [lng - 0.00008, lat - 0.00004]]] };
      w.proposalStorage.addProposal({
        proposalId: id, title: 'Elevated station movement fixture', description: 'E2E station fixture.',
        offer: 100, offerCurrency: 'EUR', city: 'zg', goal: 'station', lifecycleStatus: 'Active',
        applied: false, cadastreParcelIds: ['HR-335754-1234'],
        structureProposal: {
          kind: 'station', stationType: 'elevated', center, bearing: 37, platformHeightM: 12,
          geometry, modelVersion: w.TransitStationModels?.MODEL_VERSION || 1
        }
      });
    }, { id, center });
    await showProposal(page, id);
    await page.locator('#proposal-details-footer .btn-edit-geometry').click();
    const editor = page.locator('#station-geometry-editor');
    await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
    const draftId = await page.evaluate(() => (window as any).getActiveProposalDesignDraft?.()?.id || null);
    if (!draftId) throw new Error('Station editor did not create an active proposal draft');
    const bearing = editor.locator('[data-station-editor-bearing]');
    const height = editor.locator('[data-station-editor-height]');
    await expect(bearing).toHaveValue('37');
    await expect(height).toHaveValue('12');

    await editor.locator('[data-placement="snap"]').uncheck();
    const footprint = page.locator('.station-editor-footprint');
    await expect(footprint).toBeVisible();
    const body = await footprint.evaluate(element => {
      const path = element as SVGPathElement;
      const box = path.getBoundingClientRect();
      const point = path.ownerSVGElement!.createSVGPoint();
      const inverse = path.getScreenCTM()!.inverse();
      for (const fx of [0.2, 0.35, 0.65, 0.8]) for (const fy of [0.2, 0.35, 0.65, 0.8]) {
        point.x = box.left + box.width * fx;
        point.y = box.top + box.height * fy;
        if (path.isPointInFill(point.matrixTransform(inverse)) && document.elementFromPoint(point.x, point.y) === path) {
          return { x: point.x, y: point.y };
        }
      }
      return null;
    });
    const panel = await editor.locator('.on-map-editor__panel').boundingBox();
    if (!body || !panel) throw new Error('Station editor map or panel bounds are unavailable');
    await page.mouse.move(body.x, body.y);
    await page.mouse.down();
    await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(draftId => {
      const draft = (window as any).proposalDraftStore.getDraft(draftId);
      return draft?.editorPayload?.structureProposal?.center?.[0];
    }, draftId)).not.toBe(center[0]);
    expect(await page.evaluate(() => (window as any).map.dragging.enabled())).toBe(true);
    await expect(bearing).toHaveValue('37');
    await expect(height).toHaveValue('12');

    await editor.locator('[data-station-editor-action="undo"]').click();
    await expect.poll(() => page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).editorPayload.structureProposal.center, draftId)).toEqual(center);
    const marker = page.locator('.transit-station-marker--preview[title="Drag to move the station"]');
    await expect(marker).toBeVisible();
    const markerBox = await marker.boundingBox();
    if (!markerBox) throw new Error('Station centre marker has no visible bounds');
    await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(markerBox.x + markerBox.width / 2 + 22, markerBox.y + markerBox.height / 2 + 12, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(id => {
      const structure = (window as any).proposalDraftStore.getDraft(id).editorPayload.structureProposal;
      return [structure.stationType, structure.bearing, structure.platformHeightM];
    }, draftId)).toEqual(['elevated', 37, 12]);
    const movedCenter = await page.evaluate(id => (window as any).proposalDraftStore.getDraft(id).editorPayload.structureProposal.center, draftId);
    expect(movedCenter).not.toEqual(center);
    await expect(bearing).toHaveValue('37');
    await expect(height).toHaveValue('12');
    await editor.locator('[data-station-editor-action="save"]').click();
    await expect(editor).toHaveCount(0);
    // A local station is saved in place (same id).
    const savedStation = () => page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.structureProposal || null, id);
    await expect.poll(savedStation).toMatchObject({ stationType: 'elevated', center: movedCenter, bearing: 37, platformHeightM: 12 });
    const saved = await savedStation();
    await openCity(page);
    expect(await savedStation()).toEqual(saved);
  });

  test('320px shared editor sheet resizes while keeping Done reachable above the layers sheet', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await openCity(page);
    await addEditableStructure(page, 'park', 'mobile');
    const editor = page.locator('#structure-geometry-editor');
    const panel = editor.locator('.on-map-editor__panel');
    const handle = panel.locator(':scope > .mobile-dock-sheet-handle');
    await expect(handle).toBeVisible();
    const handleBounds = await handle.boundingBox();
    expect(handleBounds!.height).toBeGreaterThanOrEqual(44);
    const done = editor.locator('[data-action="save"]');
    const previewBeforeResize = await readRenderedStructure(page);
    expect(previewBeforeResize.geometry).not.toBeNull();
    const initialHeight = (await panel.boundingBox())!.height;
    await handle.focus();
    await page.keyboard.press('Home');
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThan(initialHeight - 100);
    await expect(done).toBeVisible();
    const compactDoneBounds = await done.boundingBox();
    expect(compactDoneBounds && compactDoneBounds.x + compactDoneBounds.width).toBeLessThanOrEqual(320);
    expect(compactDoneBounds && compactDoneBounds.y + compactDoneBounds.height).toBeLessThanOrEqual(780);

    await page.keyboard.press('End');
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeGreaterThan(initialHeight + 100);
    await expect(done).toBeVisible();
    const expandedDoneBounds = await done.boundingBox();
    expect(expandedDoneBounds && expandedDoneBounds.x + expandedDoneBounds.width).toBeLessThanOrEqual(320);
    expect(expandedDoneBounds && expandedDoneBounds.y + expandedDoneBounds.height).toBeLessThanOrEqual(780);
    expect(await readRenderedStructure(page)).toEqual(previewBeforeResize);

    // Reduce the full-height editor before reaching the main map controls behind it.
    await handle.focus();
    await page.keyboard.press('Home');
    await page.locator('#layers-button').click();
    const layers = page.locator('#layers-sheet');
    await expect(layers).toBeVisible();
    const sheetBox = await layers.boundingBox();
    expect(sheetBox).not.toBeNull();
    await page.keyboard.press('Escape');
    await expect(layers).toBeHidden();
    await expect(done).toBeVisible();
    expect(await readRenderedStructure(page)).toEqual(previewBeforeResize);
    // Settings starts another task, so it is greyed out (not hidden) until the edit is done.
    const settingsButton = page.locator('#settings-button');
    await expect(settingsButton).toBeVisible();
    await expect(settingsButton).toBeDisabled();
    await expect(settingsButton).toHaveClass(/is-edit-locked/);
    await done.click();
    await expect(editor).toHaveCount(0);
    await expect(settingsButton).toBeEnabled();
  });
});
