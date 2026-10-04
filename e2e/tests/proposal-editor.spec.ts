// Browser coverage for the SimCity object lifecycle: draw-first instant creation, the Build
// palette, design-session scoping, and "Create proposal" as the only terms surface. The old
// drafts list and editor-dialog flows are retired; the draft store remains internal plumbing.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { clickMapPoint } from '../helpers/runtime';

async function addEditableSquare(page: Page, suffix: string): Promise<{ proposalId: string; parcelId: string }> {
  await page.waitForFunction(() => !!(window as any).proposalStorage && !!(window as any).CadastralParcelRepository);
  return page.evaluate(async (key) => {
    const w = window as any;
    const parcelId = 'HR-335754-1234';
    const proposalId = `e2e-edit-${key}`;
    const ring = [
      [15.9819, 45.8000],
      [15.9825, 45.8000],
      [15.9825, 45.8005],
      [15.9819, 45.8005],
      [15.9819, 45.8000],
    ];
    await w.CadastralParcelRepository.ensureIds([parcelId]);

    w.proposalStorage.addProposal({
      proposalId,
      title: `Source square ${key}`,
      description: 'A stable immutable source.',
      offer: 100,
      offerCurrency: 'EUR',
      city: 'zg',
      goal: 'square',
      lifecycleStatus: 'Active',
      applied: false,
      cadastreParcelIds: [parcelId],
      structureProposal: {
        kind: 'square',
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    });
    return { proposalId, parcelId };
  }, suffix);
}

test.describe('SimCity proposal lifecycle @core', () => {
  // The bench-angle slider was removed when furniture became first-class; a bearing is still carried
  // in the data for legacy squares, but the editor no longer sets one. What matters now is that each
  // tool places its item and that the placements survive the save.
  test('the square geometry editor places furniture and persists it', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'square-geometry');

    await page.evaluate((proposalId) => (window as any).editProposalGeometry(proposalId), source.proposalId);
    const editor = page.locator('.structure-geometry-editor');
    await expect(editor).toBeVisible();

    const place = async (tool: string, lng: number, lat: number) => {
      await editor.locator(`[data-tool="${tool}"]`).click();
      await clickMapPoint(page, lng, lat);
    };
    await place('fountain', 15.98210, 45.80020);
    await place('tree', 15.98225, 45.80025);
    await place('bench', 15.98235, 45.80030);
    await place('stall', 15.98230, 45.80015);
    await place('statue', 15.98215, 45.80035);
    await editor.locator('[data-action="save"]').click();
    await expect(editor).toBeHidden();

    // A square is auto-decorated on creation (a fountain, a statue, a few tables), so assert that
    // each tool ADDED something rather than pinning absolute counts.
    await expect.poll(() => page.evaluate((sourceId) => {
      const w = window as any;
      const saved = w.proposalStorage.getAllProposals().find((proposal: any) =>
        proposal.proposalId !== sourceId && proposal.structureProposal?.kind === 'square'
      )?.structureProposal?.decorations;
      if (!saved) return null;
      return {
        hasFountain: (saved.fountains || []).length >= 1,
        hasTree: (saved.trees || []).length >= 1,
        hasBench: (saved.benches || []).length >= 1,
        hasStall: (saved.stalls || []).length >= 1,
        hasStatue: (saved.statues || []).length >= 1
      };
    }, source.proposalId)).toEqual({ hasFountain: true, hasTree: true, hasBench: true, hasStall: true, hasStatue: true });
  });

  test('the park geometry editor places trees, flowerbeds, ponds, and footpaths', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'park-geometry');
    await page.evaluate((proposalId) => {
      const w = window as any;
      const proposal = w.proposalStorage.getProposal(proposalId);
      proposal.goal = 'park';
      proposal.title = 'Source park geometry';
      proposal.structureProposal.kind = 'park';
      w.proposalStorage._indexProposal(proposal);
      w.proposalStorage.save();
    }, source.proposalId);

    await page.evaluate((proposalId) => (window as any).editProposalGeometry(proposalId), source.proposalId);
    const editor = page.locator('.structure-geometry-editor');
    await expect(editor).toBeVisible();

    const place = async (tool: string, lng: number, lat: number) => {
      await editor.locator(`[data-tool="${tool}"]`).click();
      await clickMapPoint(page, lng, lat);
    };
    await place('tree', 15.98205, 45.80020);
    await place('flowerbed', 15.98218, 45.80020);
    await place('pond', 15.98234, 45.80028);
    await place('path', 15.98202, 45.80010);
    await clickMapPoint(page, 15.98242, 45.80040);
    await editor.locator('[data-action="finish-path"]').click();
    await editor.locator('[data-action="save"]').click();
    await expect(editor).toBeHidden();

    await expect.poll(() => page.evaluate((sourceId) => {
      const w = window as any;
      const replacement = w.proposalStorage.getAllProposals().find((proposal: any) =>
        proposal.proposalId !== sourceId && proposal.structureProposal?.kind === 'park'
      );
      const decorations = replacement?.structureProposal?.decorations;
      return decorations ? {
        trees: decorations.trees?.length,
        flowerbeds: decorations.flowerbeds?.length,
        ponds: decorations.ponds?.length,
        paths: decorations.paths?.length,
      } : null;
    }, source.proposalId)).toEqual({ trees: 1, flowerbeds: 1, ponds: 1, paths: 1 });
  });

  test('the Build palette renders for a selected parcel and one-click creates an applied park', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'palette');

    await page.evaluate((parcelId) => {
      const w = window as any;
      // The actions container is part of the parcel panel's dynamic content — open it first.
      const layer = w.ParcelPresenter.getLayer(parcelId);
      const showPanel = w.Parcels?.uiParcelPanel?.showParcelInfoPanel || w.showParcelInfoPanel;
      showPanel(w.LiveParcelFabric.get(parcelId));
      document.getElementById('parcel-info-panel')?.classList.add('visible');
      w.currentParcel = { id: parcelId, layer: layer || null, isRoad: false };
      w.renderParcelProposalActions(parcelId);
      // The palette lives in the Proposals tab.
      const switchTab = w.Parcels?.proposals?.switchParcelTab || w.switchParcelTab;
      if (typeof switchTab === 'function') switchTab(null, 'proposals-tab');
    }, source.parcelId);

    const palette = page.locator('.parcel-build-palette');
    await expect(palette).toBeVisible();
    // Rules, structures, transport, and ownership tools; no retired Create proposal button.
    await expect(palette.locator('.parcel-build-btn')).toHaveCount(15);
    await expect(page.locator('#createProposalFromParcelButton')).toHaveCount(0);

    await palette.locator('.parcel-build-btn--park').click();
    await expect.poll(() => page.evaluate((sourceId) => {
      return (window as any).proposalStorage.getAllProposals().some((proposal: any) =>
        proposal.proposalId !== sourceId && proposal.structureProposal?.kind === 'park' && proposal.applied);
    }, source.proposalId)).toBe(true);

    const created = await page.evaluate((sourceId) => {
      const w = window as any;
      const proposal = w.proposalStorage.getAllProposals().find((record: any) =>
        record.proposalId !== sourceId && record.structureProposal?.kind === 'park');
      return {
        id: proposal?.proposalId,
        title: proposal?.title || null,
        kind: proposal?.structureProposal?.kind || null,
        applied: proposal?.applied,
      };
    }, source.proposalId);

    expect(created.id).toBeTruthy();
    expect(created.title).toBe('Park · parcel 1234'); // auto-named by place: "Type · parcel N"
    expect(created.kind).toBe('park');
    expect(created.applied).toBe(true);
  });

  test('"Create proposal" on an object opens the prefilled terms dialog', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'propose');

    await page.evaluate((proposalId) => (window as any).proposeExistingProposal(proposalId), source.proposalId);

    const modal = page.locator('.create-proposal-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#proposalName')).toHaveValue('Source square propose');
  });

  test('proposal lookup follows live parcel provenance and ignores fabricated descendant IDs', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'ancestry');

    const matches = await page.evaluate(async ({ proposalId, parcelId }) => {
      const w = window as any;
      const direct = w.proposalStorage.getProposalsForParcel(parcelId).map((p: any) => p.proposalId);
      await w.ProposalManager.applyProposal(proposalId);
      const descendants = w.LiveParcelFabric.producedBy(proposalId).map((feature: any) => ({
        id: feature.properties.parcelId,
        proposals: w.proposalStorage.getProposalsForParcel(feature.properties.parcelId).map((p: any) => p.proposalId),
      }));
      const fabricated = w.proposalStorage.getProposalsForParcel(`${parcelId}#p-abc123-1`).map((p: any) => p.proposalId);
      const unrelated = w.proposalStorage.getProposalsForParcel('HR-000000-OTHER').map((p: any) => p.proposalId);
      return { direct, descendants, fabricated, unrelated, proposalId };
    }, source);

    expect(matches.direct).toContain(matches.proposalId);
    expect(matches.descendants.length).toBeGreaterThan(0);
    for (const descendant of matches.descendants) expect(descendant.proposals).toContain(matches.proposalId);
    expect(matches.fabricated).not.toContain(matches.proposalId);
    expect(matches.unrelated).not.toContain(matches.proposalId);
  });

  test('live design synchronization is scoped to its draft and cannot leak into another draft', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const result = await page.evaluate(() => {
      const w = window as any;
      const feature = (offset: number) => ({
        type: 'Feature',
        properties: { height: 12 + offset },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [15.98 + offset * 0.001, 45.80],
            [15.981 + offset * 0.001, 45.80],
            [15.981 + offset * 0.001, 45.801],
            [15.98 + offset * 0.001, 45.80],
          ]],
        },
      });
      const firstFeature = feature(0);
      const secondFeature = feature(1);
      const first = w.proposalDraftStore.createDraft({
        cityId: 'zagreb', goal: 'buildings', adapterKey: 'buildings',
        fields: { name: 'First', parentParcelIds: ['first'] },
        editorPayload: { typology: 'buildings', context: { buildings: [firstFeature] } },
      });
      const second = w.proposalDraftStore.createDraft({
        cityId: 'zagreb', goal: 'buildings', adapterKey: 'buildings',
        fields: { name: 'Second', parentParcelIds: ['second'] },
        editorPayload: { typology: 'buildings', context: { buildings: [secondFeature] } },
      });

      w.beginProposalDraftDesignSession(first.id);
      w.syncActiveProposalDraftFromEditor('building', {
        parcelIds: ['first'], parameters: { typology: 'buildings', height: 30 },
        buildingFeature: firstFeature, buildings: [firstFeature],
      });
      w.finishProposalDraftDesignSession(first.id);
      const ignored = w.syncActiveProposalDraftFromEditor('building', {
        parcelIds: ['leak'], buildingFeature: secondFeature, buildings: [secondFeature],
      });

      return {
        firstHeight: w.proposalDraftStore.getDraft(first.id).editorPayload.context.parameters.height,
        secondParcels: w.proposalDraftStore.getDraft(second.id).fields.parentParcelIds,
        ignored,
      };
    });

    expect(result).toEqual({ firstHeight: 30, secondParcels: ['second'], ignored: null });
  });

  test('finishing a drawing instantly creates an applied, auto-named object and consumes the draft', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const parcelId = 'HR-335754-1234';
      await w.CadastralParcelRepository.ensureIds([parcelId]);

      const segment = [{ lat: 45.8001, lng: 15.9820 }, { lat: 45.8004, lng: 15.9823 }];
      const draft = w.proposalDraftStore.createDraft({
        cityId: 'zagreb', goal: 'road-track', adapterKey: 'road-track', proposalType: 'Road',
        fields: { name: '', parentParcelIds: [parcelId] },
        editorPayload: {
          kind: 'road',
          definition: {
            points: [segment], segments: [segment], segmentIds: [null], width: 10, tunnels: [],
            polygon: { type: 'Polygon', coordinates: [[[15.98195, 45.80005], [15.98235, 45.80035], [15.98240, 45.80030], [15.98200, 45.80000], [15.98195, 45.80005]]] },
            metadata: { isCorridor: true, isRoad: true },
          },
        },
      });
      const createdId = await w.instantCreateProposalFromDraft(draft.id);
      const proposal = createdId ? w.getProposalByIdOrHash(createdId) : null;
      return {
        createdId,
        title: proposal?.title || null,
        applied: proposal?.applied,
        draftGone: !w.proposalDraftStore.getDraft(draft.id),
        dialogOpen: !!document.querySelector('.create-proposal-modal'),
      };
    });

    expect(result.createdId).toBeTruthy();
    // Auto-named "Type · place"; a freehand road has no parcels until it is applied, so the place is
    // the creation time. Never an empty or placeholder name.
    expect(result.title).toMatch(/^Road · \S.*\d/);
    expect(result.title).not.toMatch(/^New (road|track)$/i);
    expect(result.draftGone).toBe(true);
    expect(result.dialogOpen).toBe(false);
    expect(result.applied).toBe(true);
  });

  test('an applied proposal surface is selectable in 3D without opening the 2D action panel', async ({ mockApi: page }) => {
    // SimCity lifecycle: only applied objects (or the selected preview) render in 3D, so the
    // pickable surface belongs to an applied proposal. 3D is a viewing mode: clicking selects
    // and isolates the proposal, and the 2D details/button panel stays hidden.
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'three');
    await page.evaluate(async (proposalId) => {
      const w = window as any;
      await w.ProposalManager.applyProposal(proposalId);
      w.map.fitBounds([[45.7999, 15.9818], [45.8006, 15.9826]], { animate: false });
      w.enterThreeMode();
    }, source.proposalId);
    await expect.poll(async () => page.evaluate(() => (window as any).isThreeModeActive?.())).toBe(true);
    const canvas = page.locator('#three-container canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await canvas.click();

    await expect.poll(async () => page.evaluate(() => (window as any).ProposalSelection?.getKey?.()))
      .toBe(source.proposalId);
    const panel = page.locator('#proposal-details-panel');
    await expect(panel).toBeHidden();
  });
});

test('structure furniture can be dragged, erased and restored with Undo; cancelling leaves the source unchanged', async ({ mockApi: page }) => {
  await page.goto('/?city=zg');
  await waitForMapReady(page);
  const source = await addEditableSquare(page, 'pointer-controls');
  const original = await page.evaluate(id => JSON.stringify((window as any).getProposalByIdOrHash(id)), source.proposalId);
  await page.evaluate(id => (window as any).editProposalGeometry(id), source.proposalId);
  const editor = page.locator('.structure-geometry-editor');
  await expect(editor).toBeVisible();
  await editor.locator('[data-tool="tree"]').click();
  await clickMapPoint(page, 15.98220, 45.80025);
  const trees = page.locator('.structure-geometry-icon.is-tree');
  const count = await trees.count();
  await editor.locator('[data-tool="erase"]').click();
  await trees.last().click();
  await expect(trees).toHaveCount(count - 1);
  await page.keyboard.press('Meta+z');
  await expect(trees).toHaveCount(count);
  await editor.locator('[data-tool="tree"]').click();
  const tree = trees.last();
  const before = await tree.boundingBox();
  expect(before).toBeTruthy();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 20, before!.y + before!.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  const after = await tree.boundingBox();
  expect(after!.x - before!.x).toBeGreaterThan(10);
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await trees.last().boundingBox())!.x).toBeCloseTo(before!.x, 0);
  await editor.locator('[data-action="cancel"]').last().click();
  await expect(editor).toBeHidden();
  expect(await page.evaluate(id => JSON.stringify((window as any).getProposalByIdOrHash(id)), source.proposalId)).toBe(original);
  expect(await page.evaluate(() => (window as any).proposalStorage.getAllProposals().length)).toBe(1);
});
