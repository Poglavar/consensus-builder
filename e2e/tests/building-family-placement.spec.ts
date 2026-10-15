// Headed, user-gesture coverage for movable block and row-house massing. Geometry is inspected
// read-only from the rendered Leaflet outline and the public proposal context after Done.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal } from '../helpers/runtime';
import { installLayerDatasets } from '../helpers/mocks/layer-datasets';
import type { Page } from '@playwright/test';

const BLOCK_PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236', 'HR-335754-1237', 'HR-335754-1238'];

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
          if (hit.path.isPointInFill(local) && !hit.path.isPointInStroke(local)) {
            return { index: hit.index, x, y, width: hit.rect.width, height: hit.rect.height };
          }
        }
      }
    }
    return null;
  }, stroke);
}

async function dragLargestOutline(page: Page, stroke: string): Promise<void> {
  const outline = await primaryOutline(page, stroke);
  if (!outline) throw new Error(`No visible building outline with stroke ${stroke}`);
  await page.mouse.move(outline.x, outline.y);
  await page.mouse.down();
  await page.mouse.move(outline.x + 34, outline.y - 21, { steps: 8 });
  await page.mouse.up();
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

function expectSameTranslation(before: any, after: any): void {
  expect(before?.type).toBe(after?.type);
  const collect = (value: any, pairs: number[][]) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      pairs.push(value);
      return;
    }
    value.forEach((child: any) => collect(child, pairs));
  };
  const left: number[][] = [];
  const right: number[][] = [];
  collect(before.coordinates, left);
  collect(after.coordinates, right);
  expect(right).toHaveLength(left.length);
  expect(left.length).toBeGreaterThan(3);
  const delta: [number, number] = [right[0][0] - left[0][0], right[0][1] - left[0][1]];
  expect(Math.abs(delta[0]) + Math.abs(delta[1])).toBeGreaterThan(0.000001);
  left.forEach((point, index) => {
    expect(right[index][0] - point[0]).toBeCloseTo(delta[0], 7);
    expect(right[index][1] - point[1]).toBeCloseTo(delta[1], 7);
  });
}

async function savedBuildingProposal(page: Page, typology: 'block' | 'row'): Promise<any> {
  await expect.poll(() => page.evaluate(key => (window as any).proposalStorage.getAllProposals().some((proposal: any) =>
    proposal.applied === true && proposal.buildingProposal?.typologyType === key && proposal.geometry?.buildings?.length), typology)).toBe(true);
  return page.evaluate(key => {
    const proposal = (window as any).proposalStorage.getAllProposals().find((candidate: any) =>
      candidate.applied === true && candidate.buildingProposal?.typologyType === key && candidate.geometry?.buildings?.length);
    return JSON.parse(JSON.stringify(proposal));
  }, typology);
}

async function reopenGeometryEditor(page: Page, proposalId: string, editorRoot: string): Promise<void> {
  await openCity(page);
  await showProposal(page, proposalId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  await expect(page.locator(editorRoot)).toBeVisible({ timeout: 20_000 });
}

async function boundsCenter(page: Page, feature: any): Promise<[number, number]> {
  if (!feature?.geometry) throw new Error('Building geometry is missing');
  return page.evaluate(value => (window as any).turf.center(value).geometry.coordinates, feature);
}

async function openRowHouseEditor(page: Page): Promise<void> {
  await installLayerDatasets(page);
  await openCity(page);
  await page.evaluate(async ids => { await (window as any).CadastralParcelRepository.ensureIds(ids); }, BLOCK_PARCEL_IDS);
  await openParcel(page, 'info', BLOCK_PARCEL_IDS[0]);
  await page.locator('.multi-select-detect-btn').click();
  await expect.poll(() => page.evaluate(() => (window as any).multiParcelSelection.selectedParcels.size)).toBeGreaterThan(1);
  await page.locator('#parcel-info-panel .close-button').click();
  await page.locator('#selection-tray [data-command="selection.propose"]').click();
  await page.locator('.parcel-build-btn--row').click();
  await expect(page.locator('#rowhouse')).toBeVisible();
  await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
}

test.describe('Building-family placement @features', () => {
  test('block translation and rotation keep generated mode; manual vertex edits disable footprint sliders and Undo restores the prior mode', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });

    const beforeMove = await previewGeometry(page);
    await page.locator('#blockify-modal .on-map-editor__more-options > summary').click();
    const beforeMoveOutline = await primaryOutline(page, 'rgb(0, 123, 255)');
    expect(beforeMoveOutline).toBeTruthy();
    await dragLargestOutline(page, 'rgb(0, 123, 255)');
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeMove);
    expectSameTranslation(JSON.parse(beforeMove).canonical, JSON.parse(await previewGeometry(page)).canonical);
    await expect(page.locator('#blockify-manual-toggle')).toHaveAttribute('aria-pressed', 'false');

    const beforeRotate = await previewGeometry(page);
    await page.locator('#blockify-rotate-clockwise').click();
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeRotate);
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
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();
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

  test('row-house translation and rotation remain generated, and Done keeps one complete movable footprint', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    const beforeMove = await previewGeometry(page);
    await page.locator('#rowhouse .on-map-editor__more-options > summary').click();
    expect(await primaryOutline(page, 'rgb(13, 110, 253)')).toBeTruthy();
    await dragLargestOutline(page, 'rgb(13, 110, 253)');
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeMove);
    expectSameTranslation(JSON.parse(beforeMove).canonical, JSON.parse(await previewGeometry(page)).canonical);
    await expect(page.locator('#rowhouse-manual-toggle')).toHaveAttribute('aria-pressed', 'false');

    const beforeRotate = await previewGeometry(page);
    await page.locator('#rowhouse-rotate-clockwise').click();
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeRotate);
    await expect(page.locator('#rowhouse-manual-toggle')).toHaveAttribute('aria-pressed', 'false');

    await page.locator('#rowhouse-manual-toggle').click();
    await expect(page.locator('#rowhouse-width-slider')).toBeDisabled();
    await expect(page.locator('#rowhouse-length-slider')).toBeDisabled();
    await expect(page.locator('#rowhouse-height-slider')).toBeEnabled();
    await page.locator('#btn-rowhouse-done').click();
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();

    const saved = await savedBuildingProposal(page, 'row');
    expect(saved.buildingProposal.parameters.manualMode).toBe(true);
    expect(saved.geometry.buildings).toHaveLength(1);
    expect(saved.freePlacement).toBe(true);
    expect(['Polygon', 'MultiPolygon']).toContain(saved.site.type);
    const placementArea = await page.evaluate(geometry => (window as any).turf.area({ type: 'Feature', properties: {}, geometry }), saved.site);
    const buildingArea = await page.evaluate(feature => (window as any).turf.area(feature), saved.geometry.buildings[0]);
    expect(placementArea).toBeCloseTo(buildingArea, 4);
    const savedGeometry = JSON.stringify(saved.geometry.buildings[0].geometry);
    await reopenGeometryEditor(page, saved.proposalId, '#rowhouse');
    const reopened = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft()?.editorPayload?.context)));
    expect(JSON.stringify(reopened.buildingFeature.geometry)).toBe(savedGeometry);
    expect(reopened.parameters.manualMode).toBe(true);
  });

  test('a saved free row with no cadastral IDs opens from its site; changing width preserves its center after reload', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    const beforeMove = await previewGeometry(page);
    await page.locator('#rowhouse .on-map-editor__more-options > summary').click();
    await dragLargestOutline(page, 'rgb(13, 110, 253)');
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeMove);
    await page.locator('#btn-rowhouse-done').click();
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();
    const saved = await savedBuildingProposal(page, 'row');
    const fixture = await page.evaluate(proposalId => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(proposalId);
      const geometry = proposal.geometry.buildings[0].geometry;
      const site = geometry.type === 'Polygon'
        ? { type: 'MultiPolygon', coordinates: [geometry.coordinates] }
        : geometry;
      // Keep the real generated/moved row and its parameters, but model its new authoritative
      // binding as an empty site. This is fixture setup only; editor opening remains a real click.
      proposal.freePlacement = true;
      proposal.site = site;
      proposal.cadastreParcelIds = [];
      proposal.binding = { source: 'server:e2e-fixture-cadastre', coverage: 'none', parcels: [], openGround: site };
      w.proposalStorage._indexProposal(proposal);
      w.proposalStorage.save();
      return { geometry: JSON.parse(JSON.stringify(geometry)), site };
    }, saved.proposalId);
    await reopenGeometryEditor(page, saved.proposalId, '#rowhouse');
    const draft = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft())));
    expect(draft.editorPayload.context.parcelIds).toEqual([]);
    expect(draft.editorPayload.context.buildingFeature.geometry).toEqual(fixture.geometry);
    const beforeCenter = await boundsCenter(page, draft.editorPayload.context.buildingFeature);
    const width = page.locator('#rowhouse-width-slider');
    await expect(width).toBeEnabled();
    await width.focus();
    await width.press('ArrowRight');
    await expect.poll(async () => page.evaluate(() => {
      const geometry = (window as any).getActiveProposalDesignDraft()?.editorPayload?.context?.buildingFeature?.geometry;
      return geometry ? JSON.stringify(geometry) : null;
    })).not.toBe(JSON.stringify(fixture.geometry));
    const afterGeometry = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).getActiveProposalDesignDraft()?.editorPayload?.context?.buildingFeature?.geometry)));
    const afterCenter = await boundsCenter(page, { type: 'Feature', properties: {}, geometry: afterGeometry });
    expect(Math.abs(afterCenter[0] - beforeCenter[0])).toBeLessThan(1e-8);
    expect(Math.abs(afterCenter[1] - beforeCenter[1])).toBeLessThan(1e-8);
  });
});
