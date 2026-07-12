// Browser coverage for the universal immutable-replacement editor and local draft lifecycle.
import { Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

async function addEditableSquare(page: Page, suffix: string): Promise<{ proposalId: string; parcelId: string }> {
  return page.evaluate(async (key) => {
    const w = window as any;
    const parcelId = `HR-335754-EDIT-${key}`;
    const proposalId = `e2e-edit-${key}`;
    const ring = [
      [15.9819, 45.8000],
      [15.9825, 45.8000],
      [15.9825, 45.8005],
      [15.9819, 45.8005],
      [15.9819, 45.8000],
    ];
    await w.ingestParcelFeatures([{
      type: 'Feature',
      properties: {
        parcelId,
        parcel_id: parcelId,
        id: parcelId,
        BROJ_CESTICE: `EDIT-${key}`,
        maticni_broj_ko: '335754',
        MATICNI_BROJ_KO: '335754',
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    }], { replaceExisting: false });

    w.proposalStorage.addProposal({
      proposalId,
      title: `Source square ${key}`,
      description: 'A stable immutable source.',
      offer: 100,
      offerCurrency: 'EUR',
      city: 'zg',
      goal: 'square',
      status: 'Active',
      parentParcelIds: [parcelId],
      structureProposal: {
        kind: 'square',
        status: 'unapplied',
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    });
    w.requirePersonalizedUser = () => false;
    return { proposalId, parcelId };
  }, suffix);
}

test.describe('Universal proposal editor @core', () => {
  test('New draft enters the same shell and can choose a design adapter', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    await page.locator('#proposal-drafts-button').click();
    const list = page.locator('#proposal-drafts-overlay');
    await expect(list).toBeVisible();
    await list.locator('[data-draft-list-action="new"]').click();

    const shell = page.locator('#proposal-editor-shell');
    await expect(shell).toBeVisible();
    const type = shell.locator('[data-draft-goal]');
    await expect(type).toHaveValue('as-is');
    await type.selectOption('buildings');
    await expect(shell.locator('[data-editor-tab="design"]')).toBeVisible();

    const draft = await page.evaluate(() => {
      const value = (window as any).proposalDraftStore.getActiveDraft();
      return { source: value?.sourceProposalId, goal: value?.goal, adapter: value?.adapterKey };
    });
    expect(draft).toEqual({ source: null, goal: 'buildings', adapter: 'buildings' });
  });

  test('Edit from proposal details creates one source-linked draft and resumes it', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'details');

    await page.evaluate(({ proposalId, parcelId }) => {
      (window as any).selectAndHighlightProposal(proposalId, parcelId, false, true);
    }, source);

    const panel = page.locator('#proposal-details-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.btn-edit-proposal')).toContainText('Edit');
    await panel.locator('.btn-edit-proposal').click();

    const shell = page.locator('#proposal-editor-shell');
    await expect(shell).toBeVisible();
    await expect(shell.locator('.proposal-editor-source')).toContainText(source.proposalId);

    const firstDraft = await page.evaluate(() => {
      const drafts = (window as any).proposalDraftStore.listDrafts();
      return { count: drafts.length, id: drafts[0]?.id, source: drafts[0]?.sourceProposalId };
    });
    expect(firstDraft).toMatchObject({ count: 1, source: source.proposalId });

    await shell.locator('[data-editor-action="close"]').click();
    await expect(shell).toBeHidden();
    await page.evaluate((proposalId) => (window as any).editProposal(proposalId), source.proposalId);
    await expect(shell).toBeVisible();

    const resumed = await page.evaluate(() => {
      const drafts = (window as any).proposalDraftStore.listDrafts();
      return { count: drafts.length, id: drafts[0]?.id };
    });
    expect(resumed).toEqual(firstDraft && { count: 1, id: firstDraft.id });
  });

  test('autosave, undo, redo, comparison, and review survive a reload', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'lifecycle');
    const draftId = await page.evaluate((proposalId) => {
      const w = window as any;
      const proposal = w.getProposalByIdOrHash(proposalId);
      const draft = w.proposalDraftStore.createDraftFromProposal(proposal, { cityId: 'zg' });
      w.openProposalEditorShell(draft.id);
      return draft.id;
    }, source.proposalId);

    const shell = page.locator('#proposal-editor-shell');
    await shell.locator('[data-editor-tab="details"]').click();
    const name = shell.locator('[data-draft-path="fields.name"]');
    await name.fill('Replacement square');
    await shell.locator('[data-editor-action="undo"]').click();
    await expect(shell.locator('[data-draft-path="fields.name"]')).toHaveValue('Source square lifecycle');
    await shell.locator('[data-editor-action="redo"]').click();
    await expect(shell.locator('[data-draft-path="fields.name"]')).toHaveValue('Replacement square');

    await shell.locator('[data-comparison-mode="source-only"]').click();
    const comparison = await page.evaluate(() => {
      const value = (window as any).activeProposalDraftComparison;
      return { mode: value?.mode, hasSource: !!value?.sourceProposal, hasDraft: !!value?.draftPreview };
    });
    expect(comparison).toEqual({ mode: 'source-only', hasSource: true, hasDraft: false });

    await shell.locator('[data-editor-action="review"]').click();
    await expect(shell.locator('.proposal-editor-review')).toBeVisible();
    await expect(shell.locator('.proposal-editor-review-notice')).toContainText('new immutable proposal');
    await shell.locator('[data-editor-action="close"]').click();

    await page.reload();
    await waitForMapReady(page);
    await page.evaluate((id) => (window as any).openProposalEditorShell(id), draftId);
    await expect(shell).toBeVisible();
    await expect(shell.locator('.proposal-editor-review')).toBeVisible();

    const persisted = await page.evaluate((id) => {
      const draft = (window as any).proposalDraftStore.getDraft(id);
      return {
        name: draft?.fields?.name,
        sourceName: draft?.sourceSnapshot?.title,
        state: draft?.state,
      };
    }, draftId);
    expect(persisted).toEqual({
      name: 'Replacement square',
      sourceName: 'Source square lifecycle',
      state: 'review',
    });
  });

  test('Drafts groups cities, confirms destructive discard, and fits a 390px viewport', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?city=zg');
    await waitForMapReady(page);

    const ids = await page.evaluate(() => {
      const w = window as any;
      const base = {
        goal: 'park',
        adapterKey: 'park',
        fields: { description: 'Saved locally', parentParcelIds: ['parcel-1'] },
      };
      const zagreb = w.proposalDraftStore.createDraft({
        ...base,
        cityId: 'zg',
        fields: { ...base.fields, name: 'Zagreb draft' },
      });
      const split = w.proposalDraftStore.createDraft({
        ...base,
        cityId: 'st',
        fields: { ...base.fields, name: 'Split draft' },
      });
      w.updateDraftsEntryPoint();
      return { zagreb: zagreb.id, split: split.id };
    });

    await page.locator('#proposal-drafts-floating-button').click();
    const list = page.locator('#proposal-drafts-overlay');
    await expect(list).toBeVisible();
    await expect(list.locator('.proposal-drafts-city')).toHaveCount(2);
    await expect(list).toContainText('Zagreb draft');
    await expect(list).toContainText('Split draft');

    await page.evaluate(() => { (window as any).showStyledConfirm = async () => false; });
    await list.locator(`[data-draft-id="${ids.split}"] [data-draft-list-action="discard"]`).click();
    await expect(list.locator('.proposal-draft-list-item')).toHaveCount(2);

    await page.evaluate(() => { (window as any).showStyledConfirm = async () => true; });
    await list.locator(`[data-draft-id="${ids.split}"] [data-draft-list-action="discard"]`).click();
    await expect(list.locator('.proposal-draft-list-item')).toHaveCount(1);
    await list.locator(`[data-draft-id="${ids.zagreb}"] [data-draft-list-action="resume"]`).click();

    const shell = page.locator('#proposal-editor-shell');
    await expect(shell).toBeVisible();
    const box = await shell.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(384);
    expect(box!.height).toBeLessThanOrEqual(620);
    expect(box!.y).toBeGreaterThan(180);
    await expect(page.locator('#map')).toBeVisible();
  });

  test('resuming a draft in another city switches silently and reopens it after reload', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const draftId = await page.evaluate(() => {
      const w = window as any;
      const draft = w.proposalDraftStore.createDraft({
        cityId: 'split', goal: 'park', adapterKey: 'park',
        fields: { name: 'Split cross-city draft', description: 'Keep me', parentParcelIds: ['split-1'] },
      });
      return draft.id;
    });

    await page.locator('#proposal-drafts-button').click();
    await page.locator(`[data-draft-id="${draftId}"] [data-draft-list-action="resume"]`).click();
    await page.waitForURL(/\?city=split/, { timeout: 15_000 });
    await waitForMapReady(page);

    const shell = page.locator('#proposal-editor-shell');
    await expect(shell).toBeVisible();
    await expect(shell.locator('.proposal-editor-title')).toHaveText('Split cross-city draft');
    expect(await page.evaluate(() => (window as any).CityConfigManager.getCurrentCityId())).toBe('split');
  });

  test('publishing creates a new immutable replacement and consumes only its draft', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'publish');
    const draftId = await page.evaluate((proposalId) => {
      const w = window as any;
      const proposal = w.getProposalByIdOrHash(proposalId);
      const draft = w.proposalDraftStore.createDraftFromProposal(proposal, { cityId: 'zagreb' });
      w.proposalDraftStore.updateDraft(draft.id, {
        fields: {
          name: 'Published replacement square',
          description: 'A reviewed replacement proposal.',
          ownership: 'to-city',
        },
      });
      w.openProposalEditorShell(draft.id);
      w.confirm = () => false;
      return draft.id;
    }, source.proposalId);

    const shell = page.locator('#proposal-editor-shell');
    await shell.locator('[data-editor-action="review"]').click();
    await shell.locator('[data-editor-action="publish"]').click();

    const modal = page.locator('.create-proposal-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#proposalName')).toHaveValue('Published replacement square');
    await expect(modal.locator('input[name="proposalOwnership"][value="to-city"]')).toBeChecked();
    await modal.locator('#createProposalSubmitButton').click();
    await expect(modal).toBeHidden({ timeout: 20_000 });

    const outcome = await page.evaluate(({ proposalId, draftId: id }) => {
      const w = window as any;
      const proposals = w.proposalStorage.getAllProposals();
      const sourceProposal = w.getProposalByIdOrHash(proposalId);
      const replacement = proposals.find((proposal: any) => proposal.sourceProposalId === proposalId);
      return {
        count: proposals.length,
        sourceTitle: sourceProposal?.title,
        sourceStatus: sourceProposal?.status,
        replacementTitle: replacement?.title,
        replacementSource: replacement?.sourceProposalId,
        replacementStatus: replacement?.status,
        replacementOwnership: replacement?.facets?.ownership,
        draftExists: !!w.proposalDraftStore.getDraft(id),
        receipt: w.proposalDraftStore.getPublishReceipt(id),
      };
    }, { proposalId: source.proposalId, draftId });

    expect(outcome).toMatchObject({
      count: 2,
      sourceTitle: 'Source square publish',
      sourceStatus: 'Active',
      replacementTitle: 'Published replacement square',
      replacementSource: source.proposalId,
      replacementOwnership: 'to-city',
      draftExists: false,
    });
    expect(outcome.receipt?.persistedProposalId).toBeTruthy();
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

  test('a storage failure leaves the draft recoverable and retry creates only one replacement', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'retry');
    const draftId = await page.evaluate((proposalId) => {
      const w = window as any;
      const draft = w.proposalDraftStore.createDraftFromProposal(w.getProposalByIdOrHash(proposalId), { cityId: 'zagreb' });
      w.proposalDraftStore.updateDraft(draft.id, {
        fields: { name: 'Retry replacement', description: 'Recover this publish.', offer: 100 },
      });
      w.openProposalEditorShell(draft.id);
      w.confirm = () => false;
      return draft.id;
    }, source.proposalId);

    const shell = page.locator('#proposal-editor-shell');
    await shell.locator('[data-editor-action="review"]').click();
    await shell.locator('[data-editor-action="publish"]').click();
    const modal = page.locator('.create-proposal-modal');
    await expect(modal).toBeVisible();

    await page.evaluate(() => {
      const w = window as any;
      w.__proposalDraftOriginalAdd = w.proposalStorage.addProposal;
      w.proposalStorage.addProposal = () => null;
    });
    await modal.locator('#createProposalSubmitButton').click();
    await expect.poll(async () => page.evaluate((id) => (window as any).proposalDraftStore.getDraft(id)?.state, draftId))
      .toBe('error');
    await expect(modal).toBeVisible();

    await page.evaluate(() => {
      const w = window as any;
      w.proposalStorage.addProposal = w.__proposalDraftOriginalAdd;
      delete w.__proposalDraftOriginalAdd;
    });
    await modal.locator('#createProposalSubmitButton').click();
    await expect(modal).toBeHidden({ timeout: 20_000 });

    const retry = await page.evaluate(({ proposalId, draftId: id }) => {
      const w = window as any;
      const replacements = w.proposalStorage.getAllProposals()
        .filter((proposal: any) => proposal.sourceProposalId === proposalId);
      return {
        replacementCount: replacements.length,
        draftExists: !!w.proposalDraftStore.getDraft(id),
        receipt: w.proposalDraftStore.getPublishReceipt(id),
      };
    }, { proposalId: source.proposalId, draftId });

    expect(retry.replacementCount).toBe(1);
    expect(retry.draftExists).toBe(false);
    expect(retry.receipt?.persistedProposalId).toBeTruthy();
  });

  test('finishing a drawing instantly creates an applied, auto-named object and consumes the draft', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const result = await page.evaluate(async () => {
      const w = window as any;
      const parcelId = 'HR-335754-EDIT-instant';
      const ring = [
        [15.9819, 45.8000], [15.9825, 45.8000], [15.9825, 45.8005], [15.9819, 45.8005], [15.9819, 45.8000],
      ];
      await w.ingestParcelFeatures([{
        type: 'Feature',
        properties: { parcelId, parcel_id: parcelId, id: parcelId, BROJ_CESTICE: 'EDIT-instant', maticni_broj_ko: '335754' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      }], { replaceExisting: false });
      w.requirePersonalizedUser = () => false;

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
        roadStatus: proposal?.roadProposal?.status || null,
        draftGone: !w.proposalDraftStore.getDraft(draft.id),
        dialogOpen: !!document.querySelector('.create-proposal-modal'),
      };
    });

    expect(result.createdId).toBeTruthy();
    // Auto-named like "Road 1207-0148" — never an empty or placeholder name.
    expect(result.title).toMatch(/\d{4}-\d{4}$/);
    expect(result.draftGone).toBe(true);
    expect(result.dialogOpen).toBe(false);
    expect(result.roadStatus).toBe('applied');
  });

  test('an applied proposal surface is selectable in 3D and opens collapsed details', async ({ mockApi: page }) => {
    // SimCity lifecycle: only applied objects (or the selected preview) render in 3D,
    // so the pickable surface belongs to an applied proposal.
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'three');
    await page.evaluate((proposalId) => {
      const w = window as any;
      const proposal = w.getProposalByIdOrHash(proposalId);
      proposal.status = 'Applied';
      if (proposal.structureProposal) proposal.structureProposal.status = 'applied';
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
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/is-minimized/);
    await expect(panel.locator('.btn-edit-proposal')).toBeVisible();
  });

  test('switching between 2D and 3D preserves the open draft and map camera', async ({ mockApi: page }) => {
    await page.goto('/?city=zg');
    await waitForMapReady(page);
    const source = await addEditableSquare(page, 'views');
    const setup = await page.evaluate((proposalId) => {
      const w = window as any;
      const draft = w.proposalDraftStore.createDraftFromProposal(w.getProposalByIdOrHash(proposalId), { cityId: 'zagreb' });
      w.openProposalEditorShell(draft.id);
      const center = w.map.getCenter();
      w.enterThreeMode();
      return { draftId: draft.id, lat: center.lat, lng: center.lng };
    }, source.proposalId);

    await expect.poll(async () => page.evaluate(() => (window as any).isThreeModeActive?.())).toBe(true);
    const shell = page.locator('#proposal-editor-shell');
    await expect(shell).toBeVisible();
    await shell.locator('[data-comparison-mode="draft-only"]').click();
    expect(await page.evaluate(() => (window as any).activeProposalDraftComparison?.viewMode)).toBe('3d');

    await page.evaluate(() => (window as any).exitThreeMode());
    await expect.poll(async () => page.evaluate(() => (window as any).isThreeModeActive?.())).toBe(false);
    await expect(shell).toBeVisible();
    const restored = await page.evaluate((draftId) => {
      const w = window as any;
      const center = w.map.getCenter();
      return {
        activeDraftId: w.proposalDraftStore.getActiveDraft()?.id,
        lat: center.lat,
        lng: center.lng,
      };
    }, setup.draftId);
    expect(restored.activeDraftId).toBe(setup.draftId);
    expect(restored.lat).toBeCloseTo(setup.lat, 6);
    expect(restored.lng).toBeCloseTo(setup.lng, 6);
  });
});
