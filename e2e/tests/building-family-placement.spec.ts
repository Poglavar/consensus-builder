// Headed, user-gesture coverage for Block and Row massing: a rule builds on its own parcels, so a
// drag off them asks what to do (put it back, re-run the rule there, or convert to Freeform;
// MEMORY.md 2026-10-18). Geometry is inspected read-only from the rendered Leaflet outline and the
// public proposal context after Done.
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

// Drags the outline well clear of its parcels, so the drop dialog has to answer.
async function dragLargestOutlineAway(page: Page, stroke: string): Promise<void> {
  const outline = await primaryOutline(page, stroke);
  if (!outline) throw new Error(`No visible building outline with stroke ${stroke}`);
  const dx = Math.max(160, outline.width * 1.6);
  await page.mouse.move(outline.x, outline.y);
  await page.mouse.down();
  await page.mouse.move(outline.x - dx, outline.y + 24, { steps: 12 });
  await page.mouse.up();
}

function dropDialog(page: Page) {
  return page.locator('.cb-dialog-overlay--confirm').filter({ hasText: 'Moved off its parcels' });
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
  await expect(page.locator(editorRoot).locator('.on-map-editor__panel')).toBeVisible({ timeout: 20_000 });
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
  await expect(page.locator('#rowhouse').locator('.on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#btn-rowhouse-done')).toBeEnabled({ timeout: 20_000 });
}

test.describe('Building-family placement @features', () => {
  test('a block dragged off its parcels can be put back; manual vertex edits disable footprint sliders and Undo restores the prior mode', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-build-btn--buildings').click();
    await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });

    const beforeMove = JSON.parse(await previewGeometry(page)).canonical;
    await page.locator('#blockify-modal .on-map-editor__more-options > summary').click();
    // A rule is never placed freely: no rotate buttons, and a drop off the parcels asks.
    await expect(page.locator('#blockify-rotate-clockwise')).toHaveCount(0);
    await dragLargestOutlineAway(page, 'rgb(0, 123, 255)');
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByRole('button')).toContainText(['Convert to Freeform and keep it here', 'Apply the same rule to the parcels here', 'Put it back']);
    await dialog.getByRole('button', { name: 'Put it back' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => JSON.stringify(JSON.parse(await previewGeometry(page)).canonical)).toBe(JSON.stringify(beforeMove));
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

  test('row-house rotation stays generated, and a row dragged off its parcels converts to one Freeform building kept where it was dropped', async ({ mockApi: page }) => {
    await openRowHouseEditor(page);
    await page.locator('#rowhouse .on-map-editor__more-options > summary').click();
    const beforeRotate = await previewGeometry(page);
    await page.locator('#rowhouse-rotate-clockwise').click();
    await expect.poll(() => previewGeometry(page)).not.toBe(beforeRotate);
    await expect(page.locator('#rowhouse-manual-toggle')).toHaveAttribute('aria-pressed', 'false');

    const beforeMove = JSON.parse(await previewGeometry(page)).canonical;
    await dragLargestOutlineAway(page, 'rgb(13, 110, 253)');
    const dialog = dropDialog(page);
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Convert to Freeform and keep it here' }).click();
    await expect(page.locator('#rowhouse').locator('.on-map-editor__panel')).toBeHidden({ timeout: 20_000 });
    const proceed = page.getByRole('button', { name: 'Proceed anyway' });
    if (await proceed.isVisible().catch(() => false)) await proceed.click();

    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .some((proposal: any) => proposal.goal === 'single' && proposal.geometry?.buildings?.length === 1)), { timeout: 30_000 }).toBe(true);
    const saved = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).proposalStorage.getAllProposals()
      .find((proposal: any) => proposal.goal === 'single' && proposal.geometry?.buildings?.length === 1))));
    // One Freeform building of the row's footprint, standing where it was dropped; the rule's
    // parameters are gone.
    const shape = await page.evaluate(([before, after]) => {
      const turf = (window as any).turf;
      const a = { type: 'Feature', properties: {}, geometry: before };
      const b = { type: 'Feature', properties: {}, geometry: after };
      return { areaRatio: turf.area(b) / turf.area(a), movedM: turf.distance(turf.centroid(a), turf.centroid(b)) * 1000 };
    }, [beforeMove, saved.geometry.buildings[0].geometry]);
    expect(shape.areaRatio).toBeGreaterThan(0.98);
    expect(shape.areaRatio).toBeLessThan(1.02);
    expect(shape.movedM).toBeGreaterThan(5);
    expect(saved.buildingProposal.parameters).toMatchObject({ typology: 'single' });
    expect(saved.buildingProposal.parameters).not.toHaveProperty('manualMode');
    expect(saved.buildingProposal.parameters).not.toHaveProperty('width');
    expect(saved.freePlacement).toBe(true);
  });
});
