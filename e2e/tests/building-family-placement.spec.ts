// Headed, user-gesture coverage for Block, Row and Detached massing: a rule builds on its own
// parcels, so a drag off them asks what to do (put it back, re-run the rule there, or convert to
// Freeform; MEMORY.md 2026-10-18), and Convert to freeform building (editor footers, details panel)
// freezes the rule's stored massing at its maximum height. Geometry is inspected read-only from the
// rendered Leaflet outline, the active design draft and the stored proposals.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal, proposalState, clickMapPoint, createBuilding } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import type { Page } from '@playwright/test';

const BLOCK_PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];
// Without the layer datasets the fixture parcels are separate plots of the same size side by side:
// a design dropped one plot to the east stands on the next one.
const FIRST_PLOT = 'HR-335754-1234';
const NEXT_PLOT = 'HR-335754-1235';
const THIRD_PLOT = 'HR-335754-1236';
const FOURTH_PLOT = 'HR-335754-1237';
const BLOCK_STROKE = 'rgb(0, 123, 255)';
const ROW_STROKE = 'rgb(13, 110, 253)';
const NOT_CONTIGUOUS = 'Its buildings do not touch each other, so they cannot become one Freeform building.';

type Point = { x: number; y: number };

async function primaryOutline(page: Page, stroke: string) {
  return page.evaluate((expectedStroke) => {
    const pane = (window as any).map?.getPane?.('onMapEditorPane');
    const paths = Array.from((pane?.querySelectorAll('path') || []) as NodeListOf<SVGPathElement>);
    const candidates = paths.map((path, index) => {
      const rect = path.getBoundingClientRect();
      return { path, index, rect, stroke: getComputedStyle(path).stroke };
    }).filter(item => item.stroke === expectedStroke && item.rect.width > 4 && item.rect.height > 4)
      .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    for (const hit of candidates) {
      const svg = hit.path.ownerSVGElement;
      const matrix = hit.path.getScreenCTM();
      const screen = svg?.createSVGPoint();
      if (!screen || !matrix || typeof hit.path.isPointInFill !== 'function') continue;
      // A point on the painted stroke can coincide with a vertex handle and turn a whole-shape
      // drag into a manual reshape. Find a point well inside the visible fill instead.
      for (const fraction of [0.28, 0.36, 0.44, 0.52, 0.60, 0.68, 0.76]) {
        for (const crossFraction of [0.28, 0.40, 0.52, 0.64, 0.76]) {
          const x = hit.rect.left + hit.rect.width * fraction;
          const y = hit.rect.top + hit.rect.height * crossFraction;
          screen.x = x;
          screen.y = y;
          const local = screen.matrixTransform(matrix.inverse());
          // The press must reach the map's shapes, not a button over them (the row's rotate buttons).
          const top = document.elementFromPoint(x, y);
          if (hit.path.isPointInFill(local) && !hit.path.isPointInStroke(local) && top instanceof SVGElement && top.ownerSVGElement === svg) {
            return { index: hit.index, x, y, width: hit.rect.width, height: hit.rect.height };
          }
        }
      }
    }
    return null;
  }, stroke);
}

async function outlineGrab(page: Page, stroke: string) {
  const outline = await primaryOutline(page, stroke);
  if (!outline) throw new Error(`No visible building outline with stroke ${stroke}`);
  return outline;
}

// A Detached design is grabbed by one of its houses (the one nearest the middle of the map, clear
// of the map controls); the whole design goes with it.
async function houseGrab(page: Page): Promise<Point> {
  return page.evaluate(() => {
    const w = window as any;
    const rect = document.getElementById('map')!.getBoundingClientRect();
    const middle = { x: rect.width / 2, y: rect.height / 2 };
    const points = w.getActiveProposalDesignDraft().editorPayload.context.buildings.map((house: any) => {
      const [lng, lat] = w.turf.pointOnFeature(house).geometry.coordinates;
      return w.map.latLngToContainerPoint([lat, lng]);
    }).sort((a: any, b: any) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y));
    return { x: points[0].x + rect.left, y: points[0].y + rect.top };
  });
}

// A drag of the whole design well clear of where it stands, towards the middle of the map.
async function dragHouseAway(page: Page): Promise<void> {
  const grab = await houseGrab(page);
  const width = page.viewportSize()?.width || 1280;
  await dragBy(page, grab, grab.x < width / 2 ? 220 : -220, 30);
}

async function dragBy(page: Page, from: Point, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
}

// Drags the outline well clear of its parcels, so the drop dialog has to answer.
async function dragLargestOutlineAway(page: Page, stroke: string): Promise<void> {
  const outline = await outlineGrab(page, stroke);
  await dragBy(page, outline, -Math.max(160, outline.width * 1.6), 24);
}

// The screen offset that carries a design from one fixture plot onto another.
async function lngLatOffset(page: Page, dLng: number, dLat: number): Promise<{ dx: number; dy: number }> {
  return page.evaluate(([lngDelta, latDelta]) => {
    const w = window as any;
    const centre = w.map.getCenter();
    const a = w.map.latLngToContainerPoint(centre);
    const b = w.map.latLngToContainerPoint([centre.lat + latDelta, centre.lng + lngDelta]);
    return { dx: b.x - a.x, dy: b.y - a.y };
  }, [dLng, dLat]);
}

async function plotOffset(page: Page, fromId: string, toId: string): Promise<{ dx: number; dy: number }> {
  return page.evaluate(([from, to]) => {
    const w = window as any;
    const centre = (id: string) => {
      const [lng, lat] = w.turf.centroid(w.LiveParcelFabric.get(id)).geometry.coordinates;
      return w.map.latLngToContainerPoint([lat, lng]);
    };
    const a = centre(from);
    const b = centre(to);
    return { dx: b.x - a.x, dy: b.y - a.y };
  }, [fromId, toId]);
}

function dropDialog(page: Page) {
  return page.locator('.cb-dialog-overlay--confirm').filter({ hasText: 'Moved off its parcels' });
}

function convertConfirm(page: Page) {
  return page.locator('.cb-dialog-overlay--confirm').filter({ hasText: 'Convert to freeform building' })
    .filter({ has: page.getByRole('button', { name: 'Keep the rule' }) });
}

async function previewGeometry(page: Page): Promise<string> {
  return page.evaluate(() => {
    const windowRef = window as any;
    const preview = windowRef.OnMapEditor?.getPreview()?.draftPreview?.features || [];
    const context = windowRef.getActiveProposalDesignDraft?.()?.editorPayload?.context || {};
    const canonical = context.buildingFeature || context.blockMassing || context.buildings?.[0] || null;
    return JSON.stringify({ preview, canonical: canonical?.geometry || null });
  });
}

async function allProposals(page: Page): Promise<any[]> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals())));
}

async function proposalIds(page: Page): Promise<string[]> {
  return (await allProposals(page)).map(proposal => proposal.proposalId);
}

async function draftParcelIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as any).getActiveProposalDesignDraft?.()?.editorPayload?.context?.parcelIds || [])].map(String).sort());
}

async function savedBuildingProposal(page: Page, typology: 'block' | 'row' | 'parcelBased'): Promise<any> {
  await expect.poll(() => page.evaluate(key => (window as any).proposalStorage.getAllProposals().some((proposal: any) =>
    proposal.applied === true && proposal.buildingProposal?.typologyType === key && proposal.geometry?.buildings?.length), typology)).toBe(true);
  return page.evaluate(key => {
    const proposal = (window as any).proposalStorage.getAllProposals().find((candidate: any) =>
      candidate.applied === true && candidate.buildingProposal?.typologyType === key && candidate.geometry?.buildings?.length);
    return JSON.parse(JSON.stringify(proposal));
  }, typology);
}

// New Freeform records (not among `before`), once every one of them is saved and applied.
async function newFreeforms(page: Page, before: string[], count: number): Promise<any[]> {
  const created = async () => (await allProposals(page)).filter(proposal => !before.includes(proposal.proposalId));
  await expect.poll(async () => (await created()).filter(proposal => proposal.applied === true).length, { timeout: 30_000 }).toBe(count);
  return created();
}

async function proceedIfAsked(page: Page): Promise<void> {
  const proceed = page.getByRole('button', { name: 'Proceed anyway' });
  if (await proceed.isVisible().catch(() => false)) await proceed.click();
}

// Geometry facts measured with the page's own turf: area ratio, centroid distance and whether the
// footprint's centre stands on a parcel.
async function footprintFacts(page: Page, footprint: any, reference: any, parcelId: string | null = null) {
  return page.evaluate(([after, before, id]) => {
    const turf = (window as any).turf;
    const a = before.type === 'Feature' ? before : { type: 'Feature', properties: {}, geometry: before };
    const b = after.type === 'Feature' ? after : { type: 'Feature', properties: {}, geometry: after };
    const parcel = id ? (window as any).LiveParcelFabric.get(id) : null;
    return {
      areaRatio: turf.area(b) / turf.area(a),
      movedM: turf.distance(turf.centroid(a), turf.centroid(b)) * 1000,
      onParcel: parcel ? turf.booleanPointInPolygon(turf.pointOnFeature(b), parcel) : null
    };
  }, [footprint, reference, parcelId]);
}

// Marks a saved local record published, as publishing it does (DesignSync.markPublished under the CID
// it hashes to): an edit of it is a counterproposal. Returns that CID.
async function markPublished(page: Page, proposalId: string): Promise<string> {
  const cid = await page.evaluate(id => {
    const w = window as any;
    const source = w.proposalStorage.getProposal(id);
    const cid = w.DesignRecord.cidOf(source);
    w.DesignSync.markPublished(source, { cid, publishedAt: new Date().toISOString(), apiBase: w.DesignSync.apiBase() });
    return cid;
  }, proposalId);
  expect(await publishedCidOf(page, proposalId)).toBe(cid);
  return cid;
}

// The CID a local record is published under here (null once it no longer hashes to it).
const publishedCidOf = (page: Page, proposalId: string) => page.evaluate(id => {
  const w = window as any;
  return w.DesignSync.publishedCid(w.proposalStorage.getProposal(id));
}, proposalId);

const EDITOR_DONE: Record<string, string> = { '#blockify-modal': '#btn-blockify-done', '#rowhouse': '#btn-rowhouse-done', '#parcelbased': '#btn-parcelbased-done' };

async function reopenGeometryEditor(page: Page, proposalId: string, editorRoot: string): Promise<void> {
  await openCity(page);
  await showProposal(page, proposalId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(page.locator(editorRoot).locator('.on-map-editor__panel')).toBeVisible({ timeout: 20_000 });
  // The design is regenerated on open; it can be dragged once Done is offered again.
  await expect(page.locator(EDITOR_DONE[editorRoot])).toBeEnabled({ timeout: 20_000 });
}

// Picks the given parcels by hand: the first from its Details panel, the rest by clicking them with
// Select multiple on, and opens the Build palette for the selection.
async function selectParcelsByHand(page: Page, ids: string[]): Promise<void> {
  await openParcel(page, 'info', ids[0]);
  await page.locator('#multiSelectCheckboxInfo').check();
  await page.locator('#parcel-info-panel .close-button').click();
  for (const id of ids.slice(1)) {
    const [lng, lat] = await page.evaluate(parcelId => (window as any).turf.centroid((window as any).LiveParcelFabric.get(parcelId)).geometry.coordinates, id);
    await clickMapPoint(page, lng, lat);
    await expect.poll(() => page.evaluate(parcelId => (window as any).multiParcelSelection.selectedParcels.has(parcelId), id)).toBe(true);
  }
  await expect.poll(() => page.evaluate(() => [...(window as any).multiParcelSelection.selectedParcels].sort())).toEqual([...ids].sort());
  await page.locator('#selection-tray [data-command="selection.propose"]').click();
}

// The fixture block (layer datasets: two rows of plots sharing their edges), selected by hand.
async function selectFixtureBlock(page: Page): Promise<void> {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
  await selectParcelsByHand(page, BLOCK_PARCEL_IDS);
}

async function openRowHouseEditor(page: Page): Promise<void> {
  await selectFixtureBlock(page);
  await page.locator('.parcel-build-btn--row').click();
  await expect(page.locator('#rowhouse').locator('.on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
}

// A rule editor on the first fixture plot, with the next plots loaded so a drop can land on them.
async function openRuleOnFirstPlot(page: Page, rule: 'buildings' | 'row' | 'parcelBased'): Promise<void> {
  await openCity(page);
  await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, [NEXT_PLOT, THIRD_PLOT]);
  await openParcel(page, 'proposals');
  await page.locator(`.parcel-build-btn--${rule}`).click();
  const done = rule === 'buildings' ? '#btn-blockify-done' : rule === 'row' ? '#btn-rowhouse-done' : '#btn-parcelbased-done';
  await expect(page.locator(done)).toBeEnabled({ timeout: 20_000 });
}

// A Detached design on the first two fixture plots, picked by hand (they are not one block).
async function openDetachedOnTwoPlots(page: Page): Promise<void> {
  await openCity(page);
  await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, [NEXT_PLOT, THIRD_PLOT]);
  await selectParcelsByHand(page, [FIRST_PLOT, NEXT_PLOT]);
  await page.locator('.parcel-build-btn--parcelBased').click();
  await expect(page.locator('#btn-parcelbased-done')).toBeEnabled({ timeout: 20_000 });
}

// The header close of an editor whose design is unchanged closes it without asking to discard.
async function closeUnchanged(page: Page, editorRoot: string): Promise<void> {
  await page.locator(`${editorRoot} .on-map-editor__header .close-circle-btn`).click();
  await expect(page.locator(editorRoot)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole('alertdialog').filter({ hasText: 'Discard this design?' })).toHaveCount(0);
}

// A saved record whose rule was re-run on other parcels and saved with Done: the same record (one's
// own local one is edited in place) now stands on those parcels.
async function expectSavedOn(page: Page, proposalId: string, recordsBefore: string[], parcelIds: string[]): Promise<any> {
  await expect.poll(async () => [...((await proposalState(page, proposalId))?.cadastreParcelIds || [])].sort(), { timeout: 30_000 }).toEqual([...parcelIds].sort());
  expect(await proposalIds(page)).toEqual(recordsBefore);
  const saved = await proposalState(page, proposalId);
  expect(saved.applied).toBe(true);
  for (const building of saved.geometry.buildings) {
    const onParcels = await page.evaluate(([feature, ids]) => {
      const w = window as any;
      const point = w.turf.pointOnFeature(feature);
      return (ids as string[]).some(id => w.turf.booleanPointInPolygon(point, w.LiveParcelFabric.get(id)));
    }, [building, parcelIds]);
    expect(onParcels).toBe(true);
  }
  return saved;
}

async function saveDetached(page: Page): Promise<any> {
  await page.locator('#btn-parcelbased-done').click();
  await proceedIfAsked(page);
  return savedBuildingProposal(page, 'parcelBased');
}

test.describe('Building-family placement @features', () => {
  test('a block dragged off its parcels can be put back; manual vertex edits disable footprint sliders and Undo restores the prior mode', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });

    const beforeMove = JSON.parse(await previewGeometry(page)).canonical;
    const recordsBefore = await proposalIds(page);
    await page.locator('#blockify-modal .on-map-editor__more-options > summary').click();
    // A rule is never placed freely: no rotate buttons, and a drop off the parcels asks.
    await expect(page.locator('#blockify-rotate-clockwise')).toHaveCount(0);
    await dragLargestOutlineAway(page, BLOCK_STROKE);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('button')).toContainText(['Convert to Freeform and keep it here', 'Apply the same rule to the parcels here', 'Put it back']);
    await dialog.getByRole('button', { name: 'Put it back' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => JSON.stringify(JSON.parse(await previewGeometry(page)).canonical)).toBe(JSON.stringify(beforeMove));
    // Putting it back saves nothing: the editor is still open on the same parcels.
    expect(await proposalIds(page)).toEqual(recordsBefore);
    await expect(page.locator('#blockify-modal .on-map-editor__panel')).toBeVisible();
    await expect(page.locator('#blockify-manual-toggle')).toHaveAttribute('aria-pressed', 'false');

    await page.locator('#blockify-manual-toggle').click();
    await expect(page.locator('#blockify-manual-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#width-slider')).toBeDisabled();
    await expect(page.locator('#height-slider')).toBeEnabled();
    const beforeVertex = await previewGeometry(page);
    const vertex = page.locator('.polygon-geometry-editor__vertex').first();
    await expect(vertex).toBeVisible();
    const vertexBox = await vertex.boundingBox();
    if (!vertexBox) throw new Error('The manual block vertex has no visible bounds');
    await page.mouse.move(vertexBox.x + vertexBox.width / 2, vertexBox.y + vertexBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(vertexBox.x + vertexBox.width / 2 + 18, vertexBox.y + vertexBox.height / 2 - 12, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeVertex);

    await page.getByRole('button', { name: /undo/i }).click();
    await expect.poll(() => previewGeometry(page)).toBe(beforeVertex);
    await page.getByRole('button', { name: /undo/i }).click();
    await expect(page.locator('#blockify-manual-toggle')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#width-slider')).toBeEnabled();

    await page.locator('#btn-blockify-done').click();
    await proceedIfAsked(page);
    const saved = await savedBuildingProposal(page, 'block');
    const savedGeometry = JSON.stringify(saved.geometry.buildings[0].geometry);
    expect(saved.buildingProposal.parameters.mode).not.toBe('manual');
    // Leaving generated mode must clear the manual override; `undefined` also means no stale ring.
    expect(saved.buildingProposal.parameters.manualOuterRing ?? null).toBeNull();
    await reopenGeometryEditor(page, saved.proposalId, '#blockify-modal');
    const reopened = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft()?.editorPayload?.context)));
    expect(JSON.stringify(reopened.buildings[0].geometry)).toBe(savedGeometry);
    expect(reopened.parameters.mode).not.toBe('manual');
  });

  test('a saved block dropped off its parcels converts in place: the same record becomes one Freeform building of its envelope at the rule\'s maximum height', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await createBuilding(page, 'range');
    const source = await proposalState(page, id);
    const maxHeight = source.buildingProposal.parameters.rule.maxHeightM;
    expect(maxHeight).toBeGreaterThan(source.buildingProposal.parameters.rule.minHeightM);
    const envelope = source.geometry.buildings[0];
    const recordsBefore = await proposalIds(page);

    await reopenGeometryEditor(page, id, '#blockify-modal');
    await dragLargestOutlineAway(page, BLOCK_STROKE);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Convert to Freeform and keep it here' }).click();
    await expect(page.locator('#blockify-modal .on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);

    await expect.poll(async () => (await proposalState(page, id))?.goal, { timeout: 30_000 }).toBe('single');
    const converted = await proposalState(page, id);
    // One's own local record converts in place: no new record, the same id.
    expect(await proposalIds(page)).toEqual(recordsBefore);
    expect(converted.applied).toBe(true);
    expect(converted.geometry.buildings).toHaveLength(1);
    const building = converted.geometry.buildings[0];
    // The stored massing (the envelope) at the greatest height the rule allows, never the example
    // build-out the map varies inside it; the rule's parameters are gone.
    expect(building.properties.height).toBe(maxHeight);
    expect(building.properties).not.toHaveProperty('urbanRule');
    expect(building.properties).not.toHaveProperty('variationSeed');
    expect(converted.buildingProposal.parameters).toMatchObject({ typology: 'single' });
    expect(converted.buildingProposal.parameters).not.toHaveProperty('rule');
    const shape = await footprintFacts(page, building, envelope);
    expect(shape.areaRatio).toBeGreaterThan(0.98);
    expect(shape.areaRatio).toBeLessThan(1.02);
    expect(shape.movedM).toBeGreaterThan(5);
    expect(converted.freePlacement).toBe(true);
  });

  test('a saved block dropped on other parcels applies the same rule there, and Done saves the record on them', async ({ mockApi: page }) => {
    await openRuleOnFirstPlot(page, 'buildings');
    await page.locator('#btn-blockify-done').click();
    await proceedIfAsked(page);
    const source = await savedBuildingProposal(page, 'block');
    expect(source.cadastreParcelIds).toEqual([FIRST_PLOT]);
    await reopenGeometryEditor(page, source.proposalId, '#blockify-modal');
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, [NEXT_PLOT]);
    const recordsBefore = await proposalIds(page);
    const offset = await plotOffset(page, FIRST_PLOT, NEXT_PLOT);
    await dragBy(page, await outlineGrab(page, BLOCK_STROKE), offset.dx, offset.dy);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Apply the same rule to the parcels here' }).click();
    await expect(dialog).toBeHidden();
    // The rule runs again on the parcels mostly inside the dropped outline; nothing is saved yet.
    await expect(page.locator('#blockify-modal .on-map-editor__panel')).toBeVisible();
    expect((await proposalState(page, source.proposalId)).cadastreParcelIds).toEqual([FIRST_PLOT]);

    await page.locator('#btn-blockify-done').click();
    await proceedIfAsked(page);
    await expect(page.locator('#blockify-modal')).toHaveCount(0, { timeout: 30_000 });
    await expectSavedOn(page, source.proposalId, recordsBefore, [NEXT_PLOT]);
    await expect(page.locator('#blockify-modal')).toHaveCount(0);
  });

  test('the Block editor\'s Convert to freeform building asks first: Keep the rule changes nothing, Convert saves one Freeform building', async ({ mockApi: page }) => {
    await openRuleOnFirstPlot(page, 'buildings');
    const recordsBefore = await proposalIds(page);
    const ruleBefore = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft().editorPayload.context.parameters)));
    await page.locator('#btn-blockify-freeform').click();
    const confirm = convertConfirm(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('at the greatest height the rule allows');
    await confirm.getByRole('button', { name: 'Keep the rule' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.locator('#blockify-modal .on-map-editor__panel')).toBeVisible();
    expect(await page.evaluate(() => (window as any).getActiveProposalDesignDraft().editorPayload.context.parameters)).toEqual(ruleBefore);
    expect(await proposalIds(page)).toEqual(recordsBefore);

    await page.locator('#btn-blockify-freeform').click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(page.locator('#blockify-modal .on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);
    const [freeform] = await newFreeforms(page, recordsBefore, 1);
    expect(freeform.goal).toBe('single');
    expect(freeform.geometry.buildings).toHaveLength(1);
    expect(freeform.geometry.buildings[0].properties.height).toBe(ruleBefore.rule?.maxHeightM ?? ruleBefore.height);
  });

  // The Row stays a rule on its parcels while it is shaped: Width regenerates the houses, Edit shape
  // manually locks the generated sliders (height stays), its undo asks before discarding, and Done
  // saves the hand-shaped Row on the block's parcels.
  test('row-house Width regenerates the row, and Edit shape manually is saved as a manual Row on its parcels', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    const width = page.locator('#rowhouse-width-slider');
    const widthLabel = page.locator('#rowhouse-width-value');
    const labelBefore = await widthLabel.textContent();
    const beforeWidth = JSON.parse(await previewGeometry(page)).canonical;
    await width.focus();
    await width.press('ArrowRight');
    await expect(widthLabel).not.toHaveText(labelBefore || '');
    await expect.poll(async () => JSON.stringify(JSON.parse(await previewGeometry(page)).canonical)).not.toBe(JSON.stringify(beforeWidth));

    const manual = page.locator('#rowhouse-manual-toggle');
    await manual.click();
    await expect(manual).toHaveAttribute('aria-pressed', 'true');
    for (const id of ['#rowhouse-width-slider', '#rowhouse-length-slider', '#rowhouse-chamfer-slider']) await expect(page.locator(id)).toBeDisabled();
    await expect(page.locator('#rowhouse-height-slider')).toBeEnabled();

    await manual.click();
    const discard = page.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true });
    await expect(discard).toBeVisible();
    await discard.click();
    await expect(manual).toHaveAttribute('aria-pressed', 'false');
    await expect(width).toBeEnabled();

    await manual.click();
    await expect(manual).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#btn-rowhouse-done').click();
    await proceedIfAsked(page);
    const saved = await savedBuildingProposal(page, 'row');
    expect(saved.buildingProposal.parameters.manualMode).toBe(true);
    expect(saved.freePlacement).not.toBe(true);
    expect(saved.cadastreParcelIds.length).toBeGreaterThan(0);
    for (const id of saved.cadastreParcelIds) expect(BLOCK_PARCEL_IDS).toContain(String(id));
  });

  // An L the bar cannot fit (two narrow plots and the long plot beside them): the editor draws the
  // bar overhanging, and by the same rule a move that keeps it on the L is an ordinary move. Only a
  // drop where it no longer stands on its parcels asks.
  test('a row the editor had to draw overhanging an L-shaped site moves on it without asking, and asks only when dropped off it', async ({ mockApi: page }) => {
    await installLayerDatasets(page);
    await openCity(page);
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
    await selectParcelsByHand(page, [FIRST_PLOT, NEXT_PLOT, FOURTH_PLOT]);
    await page.locator('.parcel-build-btn--row').click();
    await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
    const onSite = () => page.evaluate(ids => {
      const w = window as any;
      const bar = { type: 'Feature', properties: {}, geometry: w.getActiveProposalDesignDraft().editorPayload.context.buildingFeature.geometry };
      const site = ids.map((id: string) => w.LiveParcelFabric.get(id)).reduce((a: any, b: any) => w.turf.union(a, b));
      const inside = w.turf.area(bar) - (w.turf.difference(bar, site) ? w.turf.area(w.turf.difference(bar, site)) : 0);
      return { within: w.SingleBuildingGeometry.footprintWithinBoundary(bar, site, w.turf), insideM2: inside };
    }, [FIRST_PLOT, NEXT_PLOT, FOURTH_PLOT]);
    // Widened past the L's narrow arm, no bar of that size fits it anywhere, so the editor keeps the
    // wider bar overhanging (the placement rule) rather than snapping Width back.
    const width = page.locator('#rowhouse-width-slider');
    await width.focus();
    for (let step = 0; step < 40 && (await onSite()).within; step++) await width.press('ArrowRight');
    const before = await onSite();
    expect(before.within).toBe(false);
    expect(before.insideM2).toBeGreaterThan(1);

    const start = JSON.parse(await previewGeometry(page)).canonical;
    await dragBy(page, await outlineGrab(page, ROW_STROKE), 12, 8);
    await expect.poll(async () => JSON.stringify(JSON.parse(await previewGeometry(page)).canonical)).not.toBe(JSON.stringify(start));
    await expect(dropDialog(page)).toHaveCount(0);
    expect((await onSite()).insideM2).toBeGreaterThan(1);

    const kept = JSON.parse(await previewGeometry(page)).canonical;
    await dragLargestOutlineAway(page, ROW_STROKE);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Put it back' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => JSON.stringify(JSON.parse(await previewGeometry(page)).canonical)).toBe(JSON.stringify(kept));
  });

  test('row-house rotation stays generated, and a row dragged off its parcels converts to one Freeform building kept where it was dropped', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    await page.locator('#rowhouse .on-map-editor__more-options > summary').click();
    const beforeRotate = await previewGeometry(page);
    await page.locator('#rowhouse-rotate-clockwise').click();
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeRotate);
    await expect(page.locator('#rowhouse-manual-toggle')).toHaveAttribute('aria-pressed', 'false');

    const beforeMove = JSON.parse(await previewGeometry(page)).canonical;
    await dragLargestOutlineAway(page, ROW_STROKE);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Convert to Freeform and keep it here' }).click();
    await expect(page.locator('#rowhouse').locator('.on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);

    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.goal === 'single' && proposal.geometry?.buildings?.length === 1)), { timeout: 30_000 }).toBe(true);
    const saved = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.goal === 'single' && proposal.geometry?.buildings?.length === 1))));
    // One Freeform building of the row's footprint, standing where it was dropped; the rule's
    // parameters are gone.
    const shape = await footprintFacts(page, saved.geometry.buildings[0].geometry, beforeMove);
    expect(shape.areaRatio).toBeGreaterThan(0.98);
    expect(shape.areaRatio).toBeLessThan(1.02);
    expect(shape.movedM).toBeGreaterThan(5);
    expect(saved.buildingProposal.parameters).toMatchObject({ typology: 'single' });
    expect(saved.buildingProposal.parameters).not.toHaveProperty('manualMode');
    expect(saved.buildingProposal.parameters).not.toHaveProperty('width');
    expect(saved.freePlacement).toBe(true);
  });

  test('a saved row dropped off its parcels can be put back (closing then asks nothing), is refused where no parcel lies, and is re-run and saved on the parcels where it lands', async ({ mockApi: page }) => {
    // Two separate plots: the row stands on the larger part of its site, the first plot.
    await openCity(page);
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, [NEXT_PLOT, THIRD_PLOT, FOURTH_PLOT]);
    await selectParcelsByHand(page, [FIRST_PLOT, NEXT_PLOT]);
    await page.locator('.parcel-build-btn--row').click();
    await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#btn-rowhouse-done').click();
    await proceedIfAsked(page);
    const source = await savedBuildingProposal(page, 'row');
    await reopenGeometryEditor(page, source.proposalId, '#rowhouse');
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, [THIRD_PLOT, FOURTH_PLOT]);
    const recordsBefore = await proposalIds(page);
    const beforeMove = JSON.parse(await previewGeometry(page)).canonical;
    // 70 m south of the fixture plots there is no parcel to run the rule on.
    const south = await lngLatOffset(page, 0, -0.00063);
    await dragBy(page, await outlineGrab(page, ROW_STROKE), south.dx, south.dy);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('button')).toContainText(['Convert to Freeform and keep it here', 'Apply the same rule to the parcels here', 'Put it back']);
    // The rule is refused there: the dialog says why and stays open.
    await dialog.getByRole('button', { name: 'Apply the same rule to the parcels here' }).click();
    await expect(dialog).toContainText('No parcel lies mostly inside the dropped outline.');
    await dialog.getByRole('button', { name: 'Put it back' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => JSON.stringify(JSON.parse(await previewGeometry(page)).canonical)).toBe(JSON.stringify(beforeMove));
    expect(await proposalIds(page)).toEqual(recordsBefore);
    // Put back, nothing changed: closing does not ask to discard anything.
    await closeUnchanged(page, '#rowhouse');
    await reopenGeometryEditor(page, source.proposalId, '#rowhouse');

    // Two plots east the row has left its site, and the dropped outline covers the third and
    // fourth plots.
    const offset = await plotOffset(page, FIRST_PLOT, THIRD_PLOT);
    await dragBy(page, await outlineGrab(page, ROW_STROKE), offset.dx, offset.dy);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Apply the same rule to the parcels here' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => draftParcelIds(page)).toEqual([THIRD_PLOT, FOURTH_PLOT]);
    expect(await proposalIds(page)).toEqual(recordsBefore);
    await page.locator('#btn-rowhouse-done').click();
    await proceedIfAsked(page);
    await expect(page.locator('#rowhouse')).toHaveCount(0, { timeout: 30_000 });
    await expectSavedOn(page, source.proposalId, recordsBefore, [THIRD_PLOT, FOURTH_PLOT]);
    await expect(page.locator('#rowhouse')).toHaveCount(0);
  });

  test('the Row editor\'s Convert to freeform building saves one Freeform building at the rule\'s maximum height', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    const recordsBefore = await proposalIds(page);
    const parameters = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft().editorPayload.context.parameters)));
    await page.locator('#btn-rowhouse-freeform').click();
    const confirm = convertConfirm(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Row houses');
    await confirm.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(page.locator('#rowhouse .on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);
    const [freeform] = await newFreeforms(page, recordsBefore, 1);
    expect(freeform.goal).toBe('single');
    expect(freeform.geometry.buildings).toHaveLength(1);
    expect(freeform.geometry.buildings[0].properties.height).toBe(parameters.rule?.maxHeightM ?? parameters.height);
    expect(freeform.buildingProposal.parameters).not.toHaveProperty('width');
  });

  test('a Detached design dragged off its parcels moves as a whole and converts to one Freeform proposal per house', async ({ mockApi: page }) => {
    await selectFixtureBlock(page);
    await page.locator('.parcel-build-btn--parcelBased').click();
    await expect(page.locator('#btn-parcelbased-done')).toBeEnabled({ timeout: 20_000 });
    const houses = await page.evaluate(() => (window as any).getActiveProposalDesignDraft().editorPayload.context.buildings.length);
    expect(houses).toBeGreaterThan(1);
    // Several houses are not one building: the footer offers no conversion without a drag.
    await expect(page.locator('#btn-parcelbased-freeform')).toBeHidden();
    const before = await proposalIds(page);

    // Grab one house; the whole design goes with it.
    await dragHouseAway(page);

    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('button')).toContainText(['Convert to freeform buildings', 'Apply the same rule to the parcels here', 'Put it back']);
    await dialog.getByRole('button', { name: 'Convert to freeform buildings' }).click();
    await expect(page.locator('#parcelbased').locator('.on-map-editor__panel')).toBeHidden({ timeout: 20_000 });

    const created = await newFreeforms(page, before, houses);
    created.forEach(item => expect(item).toMatchObject({ goal: 'single', applied: true, geometry: { buildings: [expect.anything()] } }));
  });

  test('a saved Detached on two parcels: Put it back, the rule re-run where it lands, then one Freeform per house with the first keeping the record', async ({ mockApi: page }) => {
    await openDetachedOnTwoPlots(page);
    const source = await saveDetached(page);
    expect(source.geometry.buildings).toHaveLength(2);
    await reopenGeometryEditor(page, source.proposalId, '#parcelbased');
    await expect(page.locator('#btn-parcelbased-freeform')).toBeHidden();
    const recordsBefore = await proposalIds(page);
    const housesBefore = await page.evaluate(() => JSON.stringify((window as any).getActiveProposalDesignDraft().editorPayload.context.buildings.map((house: any) => house.geometry)));

    await dragHouseAway(page);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Put it back' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => JSON.stringify((window as any).getActiveProposalDesignDraft().editorPayload.context.buildings.map((house: any) => house.geometry)))).toBe(housesBefore);
    expect(await proposalIds(page)).toEqual(recordsBefore);

    // One plot east: the dropped outline covers the second and third plots.
    const offset = await plotOffset(page, FIRST_PLOT, NEXT_PLOT);
    await dragBy(page, await houseGrab(page), offset.dx, offset.dy);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Apply the same rule to the parcels here' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => draftParcelIds(page)).toEqual([NEXT_PLOT, THIRD_PLOT]);
    const houses = await page.evaluate(() => (window as any).getActiveProposalDesignDraft().editorPayload.context.buildings.length);
    expect(houses).toBe(2);

    await dragHouseAway(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Convert to freeform buildings' }).click();
    await expect(page.locator('#parcelbased .on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);
    const [extra] = await newFreeforms(page, recordsBefore, houses - 1);
    // One's own local record keeps its id for the first house; the other is a new proposal.
    await expect.poll(async () => (await proposalState(page, source.proposalId))?.goal, { timeout: 30_000 }).toBe('single');
    const first = await proposalState(page, source.proposalId);
    expect(first.geometry.buildings).toHaveLength(1);
    expect(extra).toMatchObject({ goal: 'single', applied: true });
    expect(extra.geometry.buildings).toHaveLength(1);
    expect(extra.sourceProposalId ?? null).toBeNull();
  });

  test('a published Detached dropped off its parcels gets one Freeform counterproposal per house and stays as it was', async ({ mockApi: page }) => {
    await openDetachedOnTwoPlots(page);
    const source = await saveDetached(page);
    const publishedCid = await markPublished(page, source.proposalId);
    const publishedBefore = await proposalState(page, source.proposalId);
    await reopenGeometryEditor(page, source.proposalId, '#parcelbased');
    const recordsBefore = await proposalIds(page);
    await dragHouseAway(page);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Convert to freeform buildings' }).click();
    await expect(page.locator('#parcelbased .on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);
    const counterproposals = await newFreeforms(page, recordsBefore, 2);
    counterproposals.forEach(item => {
      expect(item).toMatchObject({ goal: 'single', applied: true,
        proposalOrigin: { relation: 'revision', source: { kind: 'design', cid: publishedCid } } });
      expect(item.published).toBeUndefined();
      expect(item.geometry.buildings).toHaveLength(1);
    });
    const publishedAfter = await proposalState(page, source.proposalId);
    expect(publishedAfter.goal).toBe(publishedBefore.goal);
    expect(publishedAfter.geometry).toEqual(publishedBefore.geometry);
    expect(await publishedCidOf(page, source.proposalId)).toBe(publishedCid);
  });

  test('a saved Detached on one parcel: Put it back leaves nothing to discard, and the rule re-run on the next parcel saves there', async ({ mockApi: page }) => {
    await openRuleOnFirstPlot(page, 'parcelBased');
    const source = await saveDetached(page);
    await reopenGeometryEditor(page, source.proposalId, '#parcelbased');
    const recordsBefore = await proposalIds(page);
    await dragHouseAway(page);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // One house is one building: the single conversion is offered.
    await expect(dialog.getByRole('button')).toContainText(['Convert to Freeform and keep it here', 'Apply the same rule to the parcels here', 'Put it back']);
    await dialog.getByRole('button', { name: 'Put it back' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => draftParcelIds(page)).toEqual([FIRST_PLOT]);
    expect(await proposalIds(page)).toEqual(recordsBefore);
    await closeUnchanged(page, '#parcelbased');
    expect((await proposalState(page, source.proposalId)).geometry).toEqual(source.geometry);

    await reopenGeometryEditor(page, source.proposalId, '#parcelbased');
    await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, [NEXT_PLOT]);
    const offset = await plotOffset(page, FIRST_PLOT, NEXT_PLOT);
    await dragBy(page, await houseGrab(page), offset.dx, offset.dy);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Apply the same rule to the parcels here' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => draftParcelIds(page)).toEqual([NEXT_PLOT]);
    await page.locator('#btn-parcelbased-done').click();
    await proceedIfAsked(page);
    await expect(page.locator('#parcelbased')).toHaveCount(0, { timeout: 30_000 });
    await expectSavedOn(page, source.proposalId, recordsBefore, [NEXT_PLOT]);
    await expect(page.locator('#parcelbased')).toHaveCount(0);
  });

  test('a Detached on one parcel dropped off it converts to one Freeform building kept where it was dropped', async ({ mockApi: page }) => {
    await openRuleOnFirstPlot(page, 'parcelBased');
    const recordsBefore = await proposalIds(page);
    const house = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft().editorPayload.context.buildings[0])));
    await dragHouseAway(page);
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Convert to Freeform and keep it here' }).click();
    await expect(page.locator('#parcelbased .on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);
    const [freeform] = await newFreeforms(page, recordsBefore, 1);
    expect(freeform.goal).toBe('single');
    expect(freeform.geometry.buildings).toHaveLength(1);
    const shape = await footprintFacts(page, freeform.geometry.buildings[0], house);
    expect(shape.areaRatio).toBeGreaterThan(0.98);
    expect(shape.areaRatio).toBeLessThan(1.02);
    expect(shape.movedM).toBeGreaterThan(5);
  });

  test('the Detached editor on one parcel offers Convert to freeform building, which saves its house as one Freeform building', async ({ mockApi: page }) => {
    await openRuleOnFirstPlot(page, 'parcelBased');
    const recordsBefore = await proposalIds(page);
    const house = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft().editorPayload.context.buildings[0])));
    await expect(page.locator('#btn-parcelbased-freeform')).toBeVisible();
    await page.locator('#btn-parcelbased-freeform').click();
    const confirm = convertConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(page.locator('#parcelbased .on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    await proceedIfAsked(page);
    const [freeform] = await newFreeforms(page, recordsBefore, 1);
    expect(freeform.goal).toBe('single');
    expect(freeform.geometry.buildings[0].properties.height).toBe(house.properties.height);
    const shape = await footprintFacts(page, freeform.geometry.buildings[0], house);
    expect(shape.areaRatio).toBeGreaterThan(0.98);
    expect(shape.areaRatio).toBeLessThan(1.02);
    expect(shape.movedM).toBeLessThan(0.5);
  });

  test('details-panel Convert to freeform building asks first and converts a local block in place', async ({ mockApi: page }) => {
    await openCity(page);
    const localId = await createBuilding(page, 'range');
    const local = await proposalState(page, localId);
    const recordsBefore = await proposalIds(page);
    await showProposal(page, localId);
    const convert = page.locator('#proposal-details-footer .btn-convert-freeform');
    await convert.click();
    const confirm = convertConfirm(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep the rule' }).click();
    await expect(confirm).toBeHidden();
    expect((await proposalState(page, localId)).goal).toBe(local.goal);
    await convert.click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect.poll(async () => (await proposalState(page, localId))?.goal, { timeout: 30_000 }).toBe('single');
    expect(await proposalIds(page)).toEqual(recordsBefore);
    const converted = await proposalState(page, localId);
    expect(converted.geometry.buildings).toHaveLength(1);
    expect(converted.geometry.buildings[0].properties.height).toBe(local.buildingProposal.parameters.rule.maxHeightM);
    const inPlace = await footprintFacts(page, converted.geometry.buildings[0], local.geometry.buildings[0]);
    expect(inPlace.areaRatio).toBeGreaterThan(0.98);
    expect(inPlace.areaRatio).toBeLessThan(1.02);
    expect(inPlace.movedM).toBeLessThan(0.5);
  });

  test('details-panel Convert to freeform building on a published block makes a Freeform counterproposal and leaves the block as it was', async ({ mockApi: page }) => {
    await openCity(page);
    const publishedId = await createBuilding(page, 'range');
    const publishedCid = await markPublished(page, publishedId);
    const published = await proposalState(page, publishedId);
    const recordsBefore = await proposalIds(page);
    await showProposal(page, publishedId);
    await page.locator('#proposal-details-footer .btn-convert-freeform').click();
    const confirm = convertConfirm(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('is published');
    await confirm.getByRole('button', { name: 'Convert', exact: true }).click();
    const [counterproposal] = await newFreeforms(page, recordsBefore, 1);
    expect(counterproposal).toMatchObject({ goal: 'single', applied: true,
      proposalOrigin: { relation: 'revision', source: { kind: 'design', cid: publishedCid } } });
    expect(counterproposal.published).toBeUndefined();
    expect(counterproposal.geometry.buildings).toHaveLength(1);
    expect(counterproposal.geometry.buildings[0].properties.height).toBe(published.buildingProposal.parameters.rule.maxHeightM);
    const after = await proposalState(page, publishedId);
    expect(after.goal).toBe(published.goal);
    expect(after.geometry).toEqual(published.geometry);
    expect(await publishedCidOf(page, publishedId)).toBe(publishedCid);
  });

  // User decision 2026-10-18: a converted or moved design that lands on an applied proposal goes
  // through the same conflict step as any apply (proposals/claims.js appliedRivals): the applied
  // one comes off the map, and the user is told which.
  for (const saved of [false, true]) {
    test(`a ${saved ? 'saved' : 'new'} Detached converted on top of an applied block takes the block off the map, as an apply does`, async ({ mockApi: page }) => {
      await openCity(page);
      const blockId = await createBuilding(page);
      await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, [NEXT_PLOT]);
      await openParcel(page, 'proposals', NEXT_PLOT);
      await page.locator('.parcel-build-btn--parcelBased').click();
      await expect(page.locator('#btn-parcelbased-done')).toBeEnabled({ timeout: 20_000 });
      let detachedId: string | null = null;
      if (saved) {
        detachedId = (await saveDetached(page)).proposalId;
        await reopenGeometryEditor(page, detachedId!, '#parcelbased');
      }
      expect((await proposalState(page, blockId)).applied).toBe(true);
      const recordsBefore = await proposalIds(page);
      const offset = await plotOffset(page, NEXT_PLOT, FIRST_PLOT);
      await dragBy(page, await houseGrab(page), offset.dx, offset.dy);
      const dialog = dropDialog(page);
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Convert to Freeform and keep it here' }).click();
      await expect(page.locator('#parcelbased')).toHaveCount(0, { timeout: 30_000 });
      await proceedIfAsked(page);

      const freeformId = saved ? detachedId! : (await newFreeforms(page, recordsBefore, 1))[0].proposalId;
      await expect.poll(async () => (await proposalState(page, freeformId))?.goal, { timeout: 30_000 }).toBe('single');
      await expect.poll(async () => (await proposalState(page, blockId)).applied, { timeout: 30_000 }).toBe(false);
      expect((await proposalState(page, freeformId)).applied).toBe(true);
      const block = await proposalState(page, blockId);
      await expect(page.locator('.ephemeral-message').filter({ hasText: 'taken off the map' }))
        .toContainText(block.title || block.name || blockId);
    });
  }

  test('a block with gaps and a row whose houses do not touch are refused: Convert says why and changes nothing', async ({ mockApi: page }) => {
    await openCity(page);
    const box = (west: number, east: number, height = 12) => ({
      type: 'Feature', properties: { height, massing: true },
      geometry: { type: 'Polygon', coordinates: [[[west, 45.8001], [east, 45.8001], [east, 45.8003], [west, 45.8003], [west, 45.8001]]] }
    });
    const records = [
      // One block massing split by a gap (stored as a MultiPolygon).
      { title: 'Block with a gap', typologyType: 'block', buildings: [{
        type: 'Feature', properties: { height: 15, massing: true },
        geometry: { type: 'MultiPolygon', coordinates: [box(15.98195, 15.98205).geometry.coordinates, box(15.98225, 15.98240).geometry.coordinates] }
      }] },
      // Two party-wall houses and one standing apart.
      { title: 'Row with a gap', typologyType: 'row', buildings: [box(15.98195, 15.98205), box(15.98205, 15.98215), box(15.98230, 15.98240)] }
    ];
    for (const record of records) {
      const id = await page.evaluate(({ title, typologyType, buildings, parcelId }) => (window as any).proposalStorage.addProposal({
        title, goal: 'buildings', typologyType, lifecycleStatus: 'Active', applied: true, cadastreParcelIds: [parcelId],
        buildingProposal: { typologyType, parameters: { typology: typologyType } },
        geometry: { buildings }
      }), { ...record, parcelId: FIRST_PLOT });
      const before = await proposalState(page, id);
      const recordsBefore = await proposalIds(page);
      await showProposal(page, id);
      await page.locator('#proposal-details-footer .btn-convert-freeform').click();
      const refusal = page.getByRole('alertdialog').filter({ hasText: NOT_CONTIGUOUS });
      await expect(refusal).toBeVisible();
      await expect(convertConfirm(page)).toHaveCount(0);
      await refusal.getByRole('button', { name: 'OK' }).click();
      await expect(refusal).toBeHidden();
      expect(await proposalIds(page)).toEqual(recordsBefore);
      const after = await proposalState(page, id);
      expect({ goal: after.goal, typologyType: after.typologyType, geometry: after.geometry, buildingProposal: after.buildingProposal })
        .toEqual({ goal: before.goal, typologyType: before.typologyType, geometry: before.geometry, buildingProposal: before.buildingProposal });
    }
  });
});
