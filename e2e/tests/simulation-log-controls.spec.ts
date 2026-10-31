import { openDesignReview } from '../helpers/design-review';
// Exercise activity links emitted by real simulation and user design actions. A simulated agent only
// creates designs (plan-design-agreement.md, M3: owners decide on agreements, so the simulation no
// longer accepts, donates or pledges).
import { test, expect } from '../helpers/fixtures';
import { openCity, showProposal, showProposalTab, PARCEL_ID } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

const SECOND_PARCEL_ID = 'HR-335754-1235';

async function openActivityPanel(page: import('@playwright/test').Page): Promise<void> {
  const sheet = page.locator('#activity-sheet');
  if (!(await sheet.isVisible())) await page.evaluate(() => (window as any).openActivityPanel());
  await expect(sheet).toBeVisible();
  const filters = sheet.locator('#activity-panel-controls details').first();
  if (!(await filters.evaluate((node: HTMLDetailsElement) => node.open))) await filters.locator('> summary').click();
}

async function expectProposalTarget(page: import('@playwright/test').Page, proposalId: string, title: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.ProposalSelection?.getKey?.() || w.currentlyHighlightedProposalId || w.PlanningViews?.getSelected?.()?.proposalId;
  })).toBe(proposalId);
  await showProposalTab(page, 'overview');
  await expect(page.locator('#click-stack').getByRole('region', { name: title, exact: true })).toBeVisible();
}

test.describe('simulation log links @features', () => {
  test('agent and design links from real simulation actions open their targets', async ({ mockApi: page }) => {
    // Every link of every logged action is opened in turn: on a loaded host that outlasts 30 s.
    test.setTimeout(120_000);
    const owners = [
      { name: 'Fixture simulation owner A', ownership: '1/2', percentageShare: 50 },
      { name: 'Fixture simulation owner B', ownership: '1/2', percentageShare: 50 },
    ];
    const parcels = structuredClone(sampleParcels);
    for (const parcelId of [PARCEL_ID, SECOND_PARCEL_ID]) {
      const parcel = parcels.features.find(feature => feature.properties.parcelId === parcelId);
      if (!parcel) throw new Error(`Missing parcel fixture ${parcelId}`);
      Object.assign(parcel.properties, {
        owners,
        ownershipList: owners.map(owner => ({ ...owner, percentage: owner.percentageShare })),
        ownershipDetails: { owners },
      });
    }
    await page.route(url => /\/parcels(?:\/parcelIds)?$/.test(url.pathname), route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify(parcels),
    }));
    await openCity(page);

    const fixture = await page.evaluate(async ({ parcelIds }) => {
      const w = window as any;
      if (!w.gameState.isInitialized) w.initializeGame();
      await w.CadastralParcelRepository.ensureIds(parcelIds);

      const agent = w.agentStorage.getAllAgents().find((candidate: any) => !candidate.userControlled);
      if (!agent) throw new Error('Game initialization did not create a simulation agent');
      // Use the real action engine with a deterministic human decision input, while recording the
      // outcomes as simulation activity. The wildcard handler still calls executeAgentAction.
      const actor = { ...agent, controller: 'human', aiControlled: false, userControlled: true };
      const dispatch = async (action: any) => {
        const result = await w.dispatchAgentAction(actor, action, { source: 'simulation', action });
        if (typeof result.outcome !== 'string') throw new Error(`Action ${action.type} did not return its log markup`);
        return result.outcome as string;
      };

      const geometry = {
        type: 'Polygon',
        coordinates: [[
          [15.9820, 45.8001], [15.9824, 45.8001], [15.9824, 45.8004],
          [15.9820, 45.8004], [15.9820, 45.8001],
        ]],
      };
      const createAction = {
        type: 'create', title: `E2E simulation log ${Date.now()}`,
        description: 'Activity explorer link fixture', budget: 1,
        goal: 'square', parcelIds, geometry,
      };
      const created = await dispatch(createAction);
      const proposalId = created.match(/data-proposal-id="([^"]+)"/)?.[1];
      if (!proposalId) throw new Error(`Create action did not emit a proposal link: ${created}`);

      const originalFabric = w.LiveParcelFabric;
      // The fabric API is frozen. Replace only this data-boundary capability on a copy, keeping
      // its real reads available to the bounds resolver, and restore it before the next action.
      w.LiveParcelFabric = { ...originalFabric, cadastreIdsForParcelIds: undefined };
      let noGround = '';
      try {
        noGround = await dispatch({ ...createAction, title: `${createAction.title} no ground` });
      } finally {
        w.LiveParcelFabric = originalFabric;
      }
      if (!noGround.includes('cadastral ground is unavailable')) {
        throw new Error(`Unavailable-ground fixture did not reach its error path: ${noGround}`);
      }
      // A missing selected identity exercises the real provenance error without replacing a handler.
      const staleGround = await dispatch({
        ...createAction, title: `${createAction.title} stale ground`, parcelIds: ['missing-e2e-simulation-parcel'],
      });
      if (!staleGround.includes('selected ground is no longer current')) {
        throw new Error(`Stale-ground fixture did not reach its error path: ${staleGround}`);
      }
      const incomplete = await dispatch({ ...createAction, title: `${createAction.title} incomplete`, geometry: null });

      // These actions pass through the production simulation dispatcher and action handlers.
      const noOp = await dispatch({ type: 'nothing' });
      // Acceptance, donations and pledges belong to agreements now: the simulation has no such action.
      const formerAccept = await dispatch({ type: 'accept', proposalId, parcelId: parcelIds[0] });
      if (!formerAccept.includes('performed an unknown action')) throw new Error(`An accept action still has a simulation handler: ${formerAccept}`);
      const formerPledge = await dispatch({ type: 'pledge', proposalId, amount: 1, currency: 'ETH', basis: 'simulated-agent-eth-balance' });
      if (!formerPledge.includes('performed an unknown action')) throw new Error(`A pledge action still has a simulation handler: ${formerPledge}`);
      const unknown = await dispatch({ type: 'e2e-unknown-action' });

      const userAgent = w.agentStorage.getAllAgents().find((candidate: any) => candidate.userControlled);
      if (!userAgent) throw new Error('Guest setup did not create a user agent for game initialization');
      return {
        agentId: agent.id,
        userAgentId: userAgent.id,
        userAgentName: userAgent.name,
        proposalId,
        proposalTitle: w.proposalStorage.getProposal(proposalId).title,
        actionMessages: [created, noGround, staleGround, incomplete, noOp, formerAccept, formerPledge, unknown],
      };
    }, { parcelIds: [PARCEL_ID, SECOND_PARCEL_ID] });

    await openActivityPanel(page);
    const explorer = page.locator('#activity-sheet');
    await explorer.locator('[data-activity-filter-field="source"]').selectOption('simulation');

    // initializeGame emits both of these links through game.js, including the current guest actor.
    const userJoin = explorer.locator('.activity-entry').filter({ hasText: 'User agent joined' }).first();
    await expect(userJoin.locator('.agent-link-clickable')).toHaveAttribute('data-agent-id', fixture.userAgentId);
    await userJoin.locator('.agent-link-clickable').click();
    let agentDialog = page.locator('.agent-dialog-modal');
    await expect(agentDialog).toBeVisible();
    await expect(agentDialog.locator('#agent-dialog-title')).toHaveText(fixture.userAgentName);
    await agentDialog.locator('.agent-dialog-modal-close').click();
    await expect(agentDialog).toHaveCount(0);

    const createdAgent = explorer.locator('.activity-entry').filter({ hasText: 'Created agent:' }).first();
    const createdAgentLink = createdAgent.locator('.agent-link-clickable');
    await expect(createdAgentLink).toBeVisible();
    const expectedCreatedAgentName = (await createdAgentLink.innerText()).trim();
    await createdAgentLink.click();
    agentDialog = page.locator('.agent-dialog-modal');
    await expect(agentDialog).toBeVisible();
    await expect(agentDialog.locator('#agent-dialog-title')).toHaveText(expectedCreatedAgentName);
    await agentDialog.locator('.agent-dialog-modal-close').click();
    await expect(agentDialog).toHaveCount(0);

    // Every action-generated agent link lands on the actor named by that link, including the
    // successful create path, its refusals and the ordinary no-op action.
    const actionAgentLinks = explorer.locator('.activity-entry-main .agent-link-clickable');
    await expect.poll(() => actionAgentLinks.count()).toBeGreaterThanOrEqual(fixture.actionMessages.length);
    const actionLinkCount = await actionAgentLinks.count();
    for (let index = 0; index < actionLinkCount; index++) {
      const link = actionAgentLinks.nth(index);
      const expectedName = (await link.innerText()).trim();
      await link.click();
      agentDialog = page.locator('.agent-dialog-modal');
      await expect(agentDialog).toBeVisible();
      await expect(agentDialog.locator('#agent-dialog-title')).toHaveText(expectedName);
      await agentDialog.locator('.agent-dialog-modal-close').click();
      await expect(agentDialog).toHaveCount(0);
    }

    // Design buttons are the real markup returned by executeAgentAction and bound by game.js: the
    // created design's link.
    const proposalLinks = explorer.locator('.activity-entry-main .proposal-link-clickable');
    await expect(explorer.locator(`.activity-entry-main .proposal-link-clickable[data-proposal-id="${fixture.proposalId}"]`)).toHaveCount(1);
    const proposalLinkCount = await proposalLinks.count();
    expect(proposalLinkCount).toBeGreaterThanOrEqual(1);
    for (let index = 0; index < proposalLinkCount; index++) {
      const link = proposalLinks.nth(index);
      const targetId = await link.getAttribute('data-proposal-id');
      expect(targetId).toBeTruthy();
      const targetTitle = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, targetId);
      expect(targetTitle).toBeTruthy();
      await link.click();
      await expectProposalTarget(page, targetId!, targetTitle!);
      if (index + 1 < proposalLinkCount) await openActivityPanel(page);
    }
  });

  test('a user-created design logs a link to itself and its author', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => { if (!(window as any).gameState.isInitialized) (window as any).initializeGame(); });
    await page.locator('#username-display').click();
    await page.locator('#username-input').fill('Simulation log user');
    await page.locator('#welcome-submit-btn').click();

    // The draft review opens the regular proposal form from a stable design fixture; saving it is the
    // user-created action the log records, through production code.
    const sourceId = await page.evaluate(({ parcelId, suffix }) => {
      const w = window as any;
      const proposalId = `e2e-simulation-log-source-${suffix}`;
      const ring = [
        [15.9819, 45.8000], [15.9825, 45.8000], [15.9825, 45.8005],
        [15.9819, 45.8005], [15.9819, 45.8000],
      ];
      const geometry = { type: 'Polygon', coordinates: [ring] };
      w.proposalStorage.addProposal({
        proposalId,
        title: 'Unapplied source park for user actions',
        description: 'Stable source on the original cadastral parcel.',
        goal: 'park',
        lifecycleStatus: 'Active',
        applied: false,
        cadastreParcelIds: [parcelId],
        geometry,
        structureProposal: { kind: 'park', geometry },
      });
      return proposalId;
    }, { parcelId: PARCEL_ID, suffix: Date.now() });
    await showProposal(page, sourceId);
    await openDesignReview(page, sourceId);
    const dialog = page.locator('.create-proposal-modal:visible');
    await expect(dialog).toBeVisible();
    const title = `Simulation log user action ${Date.now()}`;
    await dialog.locator('#proposalName').fill(title);
    await dialog.locator('#createProposalSubmitButton').click();
    await expect(dialog).toBeHidden({ timeout: 10000 });

    const fixture = await page.evaluate(title => {
      const w = window as any;
      const proposal = w.proposalStorage.getAllProposals().find((item: any) => item.title === title);
      if (!proposal) throw new Error('The user-created proposal was not saved');
      const userAgent = w.agentStorage.getAllAgents().find((agent: any) => agent.userControlled);
      if (!userAgent) throw new Error('The local user agent is unavailable');
      return { proposalId: proposal.proposalId, userAgentId: userAgent.id, userAgentName: userAgent.name };
    }, title);

    await openActivityPanel(page);
    const explorer = page.locator('#activity-sheet');
    const source = explorer.locator('[data-activity-filter-field="source"]');
    await source.selectOption('live');
    await expect(explorer.locator(`.activity-entry-main .proposal-link-clickable[data-proposal-id="${fixture.proposalId}"]`)).toHaveCount(0);
    await source.selectOption('simulation');
    const createdRow = explorer.locator('.activity-entry').filter({ hasText: / created a .* proposal/ })
      .filter({ has: page.locator(`.activity-entry-main .proposal-link-clickable[data-proposal-id="${fixture.proposalId}"]`) });
    const createdLink = createdRow.locator('.activity-entry-main .proposal-link-clickable');
    await expect(createdLink).toBeVisible();
    await expect(createdRow).toHaveAttribute('data-source', 'simulation');
    const actor = createdRow.locator('.activity-entry-main .agent-link-clickable');
    await expect(actor).toHaveAttribute('data-agent-id', fixture.userAgentId);
    await actor.click();
    const profile = page.locator('.agent-dialog-modal');
    await expect(profile).toBeVisible();
    await expect(profile.locator('#agent-dialog-title')).toHaveText(fixture.userAgentName);
    await profile.locator('.agent-dialog-modal-close').click();
    await expect(profile).toHaveCount(0);
    await createdLink.click();
    await expectProposalTarget(page, fixture.proposalId, title);
  });
});
