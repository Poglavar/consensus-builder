// Purpose: cover the recent road editor paths that cross the map, shared editor, and persisted
// corridor records: Escape ownership, snapped junction authoring, stretch profiles, and import.
import { test, expect } from '../helpers/fixtures';
import { selectNativeOption } from '../helpers/controls';
import { clickMapPoint, drawCorridor, openCity, openParcel, proposalState, showProposal, expectStatusLogged } from '../helpers/runtime';

test.describe('Road editor complete controls @features', () => {
  test('Escape closes the shared cross-section editor without cancelling the road draft, then lifts the road pen', async ({ mockApi: page }) => {
    // The first cadastral ground request can take longer while the shared 100+ control suite is
    // rendering in parallel; once loaded, this scenario itself is short.
    test.setTimeout(90_000);
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    await clickMapPoint(page, 15.98195, 45.80025);
    await clickMapPoint(page, 15.98215, 45.80025);

    const editorButton = page.locator('#editRoadCrossSectionButton');
    await editorButton.click();
    const editor = page.locator('#corridor-editor-overlay').last();
    const editorPanel = editor.locator('.on-map-editor__panel');
    await expect(editorPanel).toBeVisible();
    const initialStrips = await page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length);
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="sidewalk"]').click();
    await expect(editor.locator('.corridor-lane-row')).toHaveCount(initialStrips + 1);

    await page.keyboard.press('Escape');
    await expect(editorPanel).toBeHidden();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).roadDrawingMode)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).getRoadDrawingProfile().strips.length)).toBe(initialStrips);

    const length = page.locator('#road-length');
    await expect(length).not.toHaveText('0 m');
    const retainedLength = await length.innerText();
    await page.keyboard.press('Escape');
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    await expect(length).toHaveText(retainedLength);
    await expectStatusLogged(page, 'Pen lifted');

    await page.locator('#finishRoadButton').click();
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied && p.roadProposal).length)).toBe(1);
  });

  test('a road branch snapped to an applied road persists one shared junction node on both roads', async ({ mockApi: page }) => {
    await openCity(page);
    const firstId = await drawCorridor(page, 'road');
    const beforeFirst = await proposalState(page, firstId);

    await page.evaluate(async () => (window as any).CadastralParcelRepository.ensureIds(['HR-335754-1235']));
    await openParcel(page, 'proposals', 'HR-335754-1235');
    await page.locator('.parcel-transport-btn--road').click();
    await expect(page.locator('#road-drawing-controls')).toBeVisible();
    // The first road runs east-west through this point. The second road approaches from the south
    // and ends on its centreline, exercising the actual map snap and junction transaction.
    await clickMapPoint(page, 15.9822, 45.79995);
    await clickMapPoint(page, 15.9822, 45.80025);
    await page.locator('#finishRoadButton').click();

    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals().filter((p: any) => p.applied && p.roadProposal).length)).toBe(2);
    const records = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .filter((p: any) => p.applied && p.roadProposal)
      .map((p: any) => ({ id: p.proposalId, definition: p.roadProposal.definition })));
    const branch = records.find((record: any) => record.id !== firstId);
    const original = records.find((record: any) => record.id === firstId);
    expect(branch).toBeTruthy();
    expect(original).toBeTruthy();
    const originalPoints = original.definition.segments.flat();
    const branchEnds = branch.definition.segments.flatMap((segment: any[]) => [segment[0], segment[segment.length - 1]]);
    const junction = branchEnds.find((point: any) => originalPoints.some((candidate: any) =>
      Math.abs(candidate.lat - point.lat) < 1e-7 && Math.abs(candidate.lng - point.lng) < 1e-7));
    expect(junction, 'the branch endpoint should be a shared snapped node on the original road').toBeTruthy();
    expect(original.definition.segments).not.toEqual(beforeFirst.roadProposal.definition.segments);
    const originalJunction = original.definition.junctions?.find((entry: any) =>
      Math.abs(entry.lat - junction.lat) < 1e-7 && Math.abs(entry.lng - junction.lng) < 1e-7);
    const branchJunction = branch.definition.junctions?.find((entry: any) =>
      Math.abs(entry.lat - junction.lat) < 1e-7 && Math.abs(entry.lng - junction.lng) < 1e-7);
    expect(originalJunction?.arms?.length, 'the original road stores the branch arm').toBeGreaterThanOrEqual(1);
    expect(branchJunction?.arms?.length, 'the branch stores both arms of the original road').toBeGreaterThanOrEqual(2);
    const armMembership = (entry: any) => entry.arms.map((arm: any) => ({ toward: arm.toward, profile: arm.profile }))
      .sort((a: any, b: any) => JSON.stringify(a.toward).localeCompare(JSON.stringify(b.toward)));
    const originalArms = armMembership(originalJunction);
    const branchArms = armMembership(branchJunction);
    const beforeMove = [original, branch].map((record: any) => ({
      id: record.id,
      segments: record.definition.segments,
      junctions: record.definition.junctions,
    }));
    await test.info().attach('junction-before.json', { body: JSON.stringify(beforeMove, null, 2), contentType: 'application/json' });

    // The junction is one editable map handle shared by both records. Dragging it must move every
    // leg and rewrite both stored junction records together.
    await showProposal(page, firstId);
    const junctionHandle = page.locator('#map-container .road-node-handle--junction').first();
    await expect(junctionHandle).toBeVisible();
    const box = await junctionHandle.boundingBox();
    if (!box) throw new Error('The shared road junction handle is not visible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 28, box.y + box.height / 2 + 12, { steps: 6 });
    await page.mouse.up();
    let afterMove: any[] = [];
    try {
      await expect.poll(async () => {
        const latest = await page.evaluate((ids: string[]) => ids.map(id => {
          const proposal = (window as any).getProposalByIdOrHash(id);
          return { id, segments: proposal?.roadProposal?.definition?.segments, junctions: proposal?.roadProposal?.definition?.junctions };
        }), [firstId, branch.id]);
        afterMove = latest;
        const definitions = latest.map((record: any) => record && ({ segments: record.segments, junctions: record.junctions }));
        const [firstDefinition, branchDefinition] = definitions;
        if (!firstDefinition?.segments || !branchDefinition?.segments) return false;
        const common = firstDefinition.segments.flat().find((point: any) => branchDefinition.segments.flat().some((other: any) =>
        Math.abs(other.lat - point.lat) < 1e-7 && Math.abs(other.lng - point.lng) < 1e-7
        && (Math.abs(point.lat - junction.lat) > 1e-7 || Math.abs(point.lng - junction.lng) > 1e-7)));
        if (!common) return false;
        const sharedRecords = definitions.map((definition: any) => definition?.junctions?.find((entry: any) =>
          Math.abs(entry.lat - common.lat) < 1e-7 && Math.abs(entry.lng - common.lng) < 1e-7));
        const currentArms = sharedRecords.map((entry: any) => entry ? armMembership(entry) : []);
        return sharedRecords.every(Boolean)
          && JSON.stringify(currentArms[0]) === JSON.stringify(originalArms)
          && JSON.stringify(currentArms[1]) === JSON.stringify(branchArms);
      }).toBe(true);
    } finally {
      await test.info().attach('junction-after.json', { body: JSON.stringify(afterMove, null, 2), contentType: 'application/json' });
    }
    await expect.poll(() => page.evaluate((id: string) => (window as any).LiveParcelFabric.producedBy(id).length, firstId)).toBeGreaterThan(0);
  });

  test('splitting a stretch creates an override, and the road-wide replace toggle controls whether it survives', async ({ mockApi: page }) => {
    await openCity(page);
    const id = await drawCorridor(page, 'road');
    await showProposal(page, id);
    const initialInspector = page.locator('#planning-inspector');
    const initialActions = initialInspector.getByRole('button', { name: 'Proposal actions', exact: true });
    if (await initialActions.isVisible()) await initialActions.click();
    await page.locator('[data-road-edge-action="add"]').first().click();
    const nodes = page.locator('#map-container .road-node-handle');
    await expect(nodes).toHaveCount(3);
    await nodes.nth(1).click();
    const choice = page.getByRole('alertdialog');
    await expect(choice).toBeVisible();
    await choice.getByRole('button', { name: /Split the stretch here/i }).click();
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.segmentIds.length).toBe(2);

    const segmentId = await page.evaluate((proposalId: string) => {
      const definition = (window as any).getProposalByIdOrHash(proposalId).roadProposal.definition;
      return String(definition.segmentIds[0]);
    }, id);
    // Each split stretch is shorter than the node editor's midpoint action hitbox at the default
    // zoom. Zoom in with the map wheel so a real pointer click can land on its hit path.
    const initialZoom = await page.evaluate(() => (window as any).map.getZoom());
    await page.evaluate(() => {
      (window as any).__roadControlZoomEnded = false;
      (window as any).map.once('zoomend', () => { (window as any).__roadControlZoomEnded = true; });
    });
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, -240);
    await expect.poll(() => page.evaluate(() => (window as any).map.getZoom())).toBeGreaterThan(initialZoom);
    await expect.poll(() => page.evaluate(() => (window as any).__roadControlZoomEnded)).toBe(true);
    const segmentPoint = await page.evaluate((proposalId: string) => {
      const definition = (window as any).getProposalByIdOrHash(proposalId).roadProposal.definition;
      const points = definition.segments[0];
      const a = points[0]; const b = points[points.length - 1];
      const map = (window as any).map;
      // Find a real segment-hit point away from the node editor's higher-z-index edge action
      // marker. Reprojecting after the map-control zoom keeps this a normal pointer interaction.
      for (let step = 1; step < 20; step += 1) {
        const fraction = step / 20;
        const point = { lng: a.lng + (b.lng - a.lng) * fraction, lat: a.lat + (b.lat - a.lat) * fraction };
        const pixel = map.latLngToContainerPoint([point.lat, point.lng]);
        const rect = map.getContainer().getBoundingClientRect();
        const target = document.elementFromPoint(rect.left + pixel.x, rect.top + pixel.y);
        if (target?.closest?.('.corridor-applied-hit-target')) return { ...point, fraction };
      }
      return { lng: a.lng + (b.lng - a.lng) * 0.25, lat: a.lat + (b.lat - a.lat) * 0.25, fraction: 0.25 };
    }, id);
    const mapHitBeforeClick = await page.evaluate((point: { lat: number; lng: number }) => {
      const map = (window as any).map;
      const containerPoint = map.latLngToContainerPoint([point.lat, point.lng]);
      const rect = map.getContainer().getBoundingClientRect();
      const element = document.elementFromPoint(rect.left + containerPoint.x, rect.top + containerPoint.y);
      return {
        x: rect.left + containerPoint.x,
        y: rect.top + containerPoint.y,
        target: element?.tagName,
        className: typeof element?.className === 'string' ? element.className : element?.getAttribute('class'),
        selected: (window as any).currentlyHighlightedProposal && (window as any).getProposalKey((window as any).currentlyHighlightedProposal),
        lastClickedSegment: (window as any).corridorLastClickedSegment,
        corridorHitPaths: Array.from(document.querySelectorAll('.corridor-applied-hit-target')).map((node: any) => ({
          tag: node.tagName,
          className: node.getAttribute('class'),
          rect: (() => { const bounds = node.getBoundingClientRect(); return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }; })(),
        })),
        ancestors: Array.from((element as Element | null)?.parentElement ? [(element as Element).parentElement] : []).map((node: any) => ({ tag: node.tagName, className: node.getAttribute('class') })),
      };
    }, segmentPoint);
    await test.info().attach('stretch-hit-before-click.json', { body: JSON.stringify(mapHitBeforeClick, null, 2), contentType: 'application/json' });
    await clickMapPoint(page, segmentPoint.lng, segmentPoint.lat);
    const mapHitAfterClick = await page.evaluate((point: { lat: number; lng: number }) => {
      const map = (window as any).map;
      const containerPoint = map.latLngToContainerPoint([point.lat, point.lng]);
      const rect = map.getContainer().getBoundingClientRect();
      const element = document.elementFromPoint(rect.left + containerPoint.x, rect.top + containerPoint.y);
      return {
        x: rect.left + containerPoint.x,
        y: rect.top + containerPoint.y,
        target: element?.tagName,
        className: typeof element?.className === 'string' ? element.className : element?.getAttribute('class'),
        selected: (window as any).currentlyHighlightedProposal && (window as any).getProposalKey((window as any).currentlyHighlightedProposal),
        lastClickedSegment: (window as any).corridorLastClickedSegment,
        corridorHitPaths: Array.from(document.querySelectorAll('.corridor-applied-hit-target')).map((node: any) => ({ tag: node.tagName, className: node.getAttribute('class') })),
      };
    }, segmentPoint);
    await test.info().attach('stretch-hit-after-click.json', { body: JSON.stringify(mapHitAfterClick, null, 2), contentType: 'application/json' });
    await expect.poll(() => page.evaluate(({ proposalId, segmentId }: { proposalId: string; segmentId: string }) => {
      const clicked = (window as any).corridorLastClickedSegment;
      return clicked?.proposalKey === proposalId && clicked?.segmentId === segmentId;
    }, { proposalId: id, segmentId })).toBe(true);
    const inspector = page.locator('#planning-inspector');
    const actions = inspector.getByRole('button', { name: 'Proposal actions', exact: true });
    if (await actions.isVisible()) await actions.click();
    const details = page.locator('#proposal-details-panel');
    const expand = details.getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    await details.locator('.btn-cross-section').click();
    const editor = page.locator('#corridor-editor-overlay').last();
    const editorPanel = editor.locator('.on-map-editor__panel');
    await expect(editorPanel).toBeVisible();
    const segmentScope = editor.locator('input[name="corridor-editor-scope"][value="segment"]');
    const roadScope = editor.locator('input[name="corridor-editor-scope"][value="road"]');
    await expect(segmentScope).toBeChecked();
    // Exercise both scope transitions through the radio controls; the editor opens in segment
    // scope for this hit target, so change to road scope and back before applying the override.
    await roadScope.check();
    await expect(roadScope).toBeChecked();
    await segmentScope.check();
    await expect(segmentScope).toBeChecked();
    const segmentBaseCount = await editor.locator('.corridor-lane-row').count();
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="sidewalk"]').click();
    await expect(editor.locator('.corridor-lane-row')).toHaveCount(segmentBaseCount + 1);
    const footwayPaving = editor.locator('.corridor-lane-paving').last();
    await expect(footwayPaving).toHaveValue('asphalt');
    await selectNativeOption(footwayPaving, 'paved');
    await expect(footwayPaving).toHaveValue('paved');
    await editor.locator('.corridor-editor-save').click();
    const applySegmentChange = page.getByRole('alertdialog').getByRole('button', { name: 'Apply', exact: true });
    if (await applySegmentChange.isVisible()) await applySegmentChange.click();
    await expect(editorPanel).toBeHidden();
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.segmentProfiles?.[segmentId]?.strips?.some((strip: any) => strip.type === 'sidewalk' && strip.paving === 'paved')).toBe(true);

    await details.locator('.btn-cross-section').click();
    await expect(editorPanel).toBeVisible();
    const replaceOverrides = editor.locator('.corridor-editor-stretches-input');
    await expect(replaceOverrides).toBeVisible();
    await expect(replaceOverrides).not.toBeChecked();
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="cycleway"]').click();
    await editor.locator('.corridor-editor-save').click();
    const applyRoadChange = page.getByRole('alertdialog').getByRole('button', { name: 'Apply', exact: true });
    if (await applyRoadChange.isVisible()) await applyRoadChange.click();
    await expect(editorPanel).toBeHidden();
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.profile.strips.some((strip: any) => strip.type === 'cycleway')).toBe(true);
    expect((await proposalState(page, id)).roadProposal.definition.segmentProfiles[segmentId].strips.some((strip: any) => strip.type === 'sidewalk' && strip.paving === 'paved')).toBe(true);

    await details.locator('.btn-cross-section').click();
    await expect(editorPanel).toBeVisible();
    const replaceAgain = editor.locator('.corridor-editor-stretches-input');
    await expect(replaceAgain).not.toBeChecked();
    await replaceAgain.check();
    await expect(replaceAgain).toBeChecked();
    await editor.locator('.cb-lane-dropdown-toggle').click();
    await editor.locator('[data-lane-type="median"]').click();
    await editor.locator('.corridor-editor-save').click();
    const applyReplacement = page.getByRole('alertdialog').getByRole('button', { name: 'Apply', exact: true });
    if (await applyReplacement.isVisible()) await applyReplacement.click();
    await expect(editorPanel).toBeHidden();
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.segmentProfiles).toBeUndefined();
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.profile.strips.some((strip: any) => strip.type === 'cycleway')).toBe(true);
    await expect.poll(async () => (await proposalState(page, id)).roadProposal.definition.profile.strips.some((strip: any) => strip.type === 'median')).toBe(true);
  });

  test('OpenDRIVE import through the road panel\'s format chooser creates an applied corridor and leaves drawing mode', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'proposals');
    await page.locator('.parcel-transport-btn--road').click();
    await expect(page.locator('#road-info-panel')).toBeVisible();
    await page.locator('#importRoadsButton').click();
    // The chooser shows every format; an unsupported one says so and keeps the chooser open.
    const chooser = page.locator('.corridor-import-dialog');
    await expect(chooser).toBeVisible();
    // aria-disabled keeps the tile clickable for its explanation; Playwright's actionability check
    // treats it as disabled, so the press is a real mouse click at the tile.
    const landXml = chooser.locator('.cb-tile[data-format="landxml"]');
    await expect(landXml).toHaveAttribute('aria-disabled', 'true');
    const box = await landXml.boundingBox();
    if (!box) throw new Error('LandXML tile has no box');
    // The status line is shared with ground loading, which can overwrite the note at once, so
    // every text it shows is recorded.
    await page.evaluate(() => {
      const w = window as any;
      w.__statusSeen = [];
      const status = document.getElementById('status')!;
      new MutationObserver(() => w.__statusSeen.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
    });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => (window as any).__statusSeen.join('\n'))).toContain('LandXML import is not supported yet.');
    await expect(chooser).toBeVisible();

    const xodr = `<?xml version="1.0"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="6" name="E2E import" version="1.00" date="2026-10-15" north="0" south="0" east="0" west="0"/>
  <road name="Imported Test Road" length="24" id="1" junction="-1">
    <type s="0" type="townLocal"/>
    <planView><geometry s="0" x="0" y="0" hdg="0" length="24"><line/></geometry></planView>
    <lanes><laneSection s="0"><left/><center><lane id="0" type="none" level="false"><width sOffset="0" a="0" b="0" c="0" d="0"/></lane></center>
      <right><lane id="-1" type="driving" level="false"><link/><width sOffset="0" a="3.2" b="0" c="0" d="0"/></lane></right>
    </laneSection></lanes>
  </road>
</OpenDRIVE>`;
    // OpenDRIVE closes the chooser and opens the file picker for its own extension.
    const picker = page.waitForEvent('filechooser');
    await chooser.locator('.cb-tile[data-format="opendrive"]').click();
    const fileChooser = await picker;
    await expect(chooser).toBeHidden();
    expect(await page.locator('#corridorImportInput').getAttribute('accept')).toBe('.xodr');
    await fileChooser.setFiles({
      name: 'e2e-road.xodr',
      mimeType: 'application/xml',
      buffer: Buffer.from(xodr),
    });

    await expect.poll(() => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .filter((p: any) => p.applied && p.roadProposal).length)).toBe(1);
    await expect(page.locator('#road-drawing-controls')).toBeHidden();
    const imported = await page.evaluate(() => (window as any).proposalStorage.getAllProposals()
      .find((p: any) => p.applied && p.roadProposal));
    expect(imported.title).toBe('Imported Test Road');
    expect(imported.roadProposal.definition.metadata.mode).toBe('import');
    expect(imported.roadProposal.definition.profile.strips.some((strip: any) => strip.type === 'driving')).toBe(true);
    expect(imported.roadProposal.definition.segments.flat().length).toBeGreaterThan(2);
    expect(await page.evaluate((id: string) => (window as any).LiveParcelFabric.producedBy(id).length, imported.proposalId)).toBeGreaterThan(0);

    await page.reload();
    await page.waitForFunction(() => !!(window as any).proposalStorage);
    await expect.poll(() => page.evaluate((id: string) => (window as any).getProposalByIdOrHash(id)?.roadProposal?.definition?.metadata?.mode, imported.proposalId)).toBe('import');
  });
});
