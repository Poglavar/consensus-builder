import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, clickMapPoint, drawCorridor, showProposal, proposalState } from '../helpers/runtime';

test.describe('Corridor drawing @features', () => {
  test('applied road nodes can be inserted, dragged, removed and stretches bulldozed', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await drawCorridor(page, 'road');
    await showProposal(page, id);
    const nodes = page.locator('.road-node-handle');
    await expect(nodes).toHaveCount(2);
    await page.locator('[data-road-edge-action="add"]').first().click();
    await expect(nodes).toHaveCount(3);
    const before = await proposalState(page, id);
    const box = await nodes.nth(1).boundingBox();
    if (!box) throw new Error('Road node is not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => JSON.stringify((await proposalState(page, id)).roadProposal.definition.segments)).not.toBe(JSON.stringify(before.roadProposal.definition.segments));
    await nodes.nth(1).click({ modifiers: ['Alt'] });
    await expect(nodes).toHaveCount(2);
    await page.locator('[data-road-edge-action="bulldoze"]').first().click();
    await expect(nodes).toHaveCount(0);
    await expect.poll(async () => (await proposalState(page, id)).applied).toBe(false);
    await expect.poll(() => page.evaluate(id => (window as any).LiveParcelFabric.producedBy(id).length, id)).toBe(0);
  });
  test('an applied road cross-section edits the existing corridor and persists after reload', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await drawCorridor(page, 'road');
    const before = await proposalState(page, id);
    await showProposal(page, id);
    const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.locator('#proposal-details-panel .btn-cross-section').click();
    const editor = page.locator('#corridor-editor-overlay');
    await expect(editor).toBeVisible();
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="sidewalk"]').click();
    await expect(editor.locator('.corridor-editor-save')).toBeEnabled();
    await editor.locator('.corridor-editor-save').click();
    await expect(editor).toBeHidden();
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.profile.strips.length).toBe(before.roadProposal.definition.profile.strips.length + 1);
    const edited = await proposalState(page, id);
    expect(edited.applied).toBe(true);
    expect(edited.roadProposal.definition.polygon).not.toEqual(before.roadProposal.definition.polygon);
    await page.reload();
    await page.waitForFunction(() => !!(window as any).proposalStorage);
    await expect.poll(async () => (await proposalState(page, id))?.roadProposal?.definition?.profile?.strips.length).toBe(edited.roadProposal.definition.profile.strips.length);
    expect((await proposalState(page, id)).roadProposal.definition.polygon).toEqual(edited.roadProposal.definition.polygon);
  });
  for (const kind of ['road', 'track']) {
    test(`${kind}: draw vertices, undo, edit cross-section and finish into an applied corridor`, async ({ mockApi: page }) => {
      await openCity(page);
      await openParcel(page, 'proposals');
      await page.locator(`.parcel-transport-btn--${kind}`).click();
      if (kind === 'track') {
        await expect(page.locator('#track-speed-modal')).toBeVisible();
        await page.locator('#track-speed-confirm-btn').click();
      }
      await expect(page.locator('#road-info-panel')).toBeVisible();
      await expect(page.locator('#undoRoadButton')).toBeDisabled();
      await clickMapPoint(page, 15.98195, 45.8001);
      await clickMapPoint(page, 15.98215, 45.8001);
      await clickMapPoint(page, 15.9824, 45.8001);
      const length = () => page.locator('#road-length').innerText();
      await expect.poll(length).not.toBe('0 m');
      const beforeUndo = await length();
      await page.locator('#undoRoadButton').click();
      await expect.poll(length).not.toBe(beforeUndo);
      await clickMapPoint(page, 15.9824, 45.8001);
      await page.locator('#editRoadCrossSectionButton').click();
      const editor = page.locator('#corridor-editor-overlay');
      await expect(editor).toBeVisible();
      const initialRows = await editor.locator('.corridor-lane-row').count();
      await editor.locator('.cb-lane-dropdown-toggle').click();
      await editor.locator('[data-lane-type="sidewalk"]').click();
      await expect(editor.locator('.corridor-lane-row')).toHaveCount(initialRows + 1);
      await editor.locator('.corridor-editor-save').click();
      await expect(editor).toBeHidden();
      await page.locator('#finishRoadButton').click();
      await expect(page.locator('#road-drawing-controls')).toBeHidden();
      await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied && p.roadProposal).length)).toBe(1);
      const proposal = await page.evaluate(() => (window as any).proposalStorage.getAllProposals().find((p: any) => p.applied && p.roadProposal));
      expect(proposal.roadProposal.definition.polygon.type).toMatch(/Polygon/);
      expect(proposal.roadProposal.definition.profile.strips.some((lane: any) => lane.type === 'sidewalk')).toBe(true);
      expect(proposal.roadProposal.definition.segments[0].length).toBeGreaterThanOrEqual(3);
      expect(await page.evaluate(id => (window as any).LiveParcelFabric.producedBy(id).length, proposal.proposalId)).toBeGreaterThan(0);
      if (kind === 'track') expect(proposal.roadProposal.definition.metadata.trackSpeed).toBeGreaterThan(0);
    });
  }

  test('track speed picker cancellation creates no corridor', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--track').click();
    await page.locator('#track-speed-cancel-btn').click();
    await expect(page.locator('#track-speed-modal')).toBeHidden();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
    expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(0);
  });
});
