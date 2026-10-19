// Exercise activity links emitted by real simulation and user proposal actions.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal, chooseProposalKind, PARCEL_ID } from '../helpers/runtime';
import { sampleParcels } from '../helpers/mocks/parcel-data';

const SECOND_PARCEL_ID = 'HR-335754-1235';

async function openActivityExplorer(page: import('@playwright/test').Page): Promise<void> {
  if (await page.locator('.game-log-modal').isVisible()) return;
  const sheet = page.locator('#activity-sheet');
  if (!(await sheet.isVisible())) await page.locator('#activity-button').click();
  await expect(sheet).toBeVisible();
  await sheet.locator('#activity-explorer-button').click();
  await expect(page.locator('.game-log-modal')).toBeVisible();
}

test.describe('simulation log links @features', () => {
  test('agent, proposal, and parcel links from real simulation actions open their targets', async ({ mockApi: page }) => {
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

      // These actions pass through the production simulation dispatcher and action handlers. The
      // two-parcel proposal keeps its first acceptance local, so opening its log link does not
      // execute or apply the proposal as a side effect.
      const rejected = await dispatch({ type: 'accept', proposalId: 'missing-e2e-simulation-proposal', parcelId: parcelIds[0] });
      const accepted = await dispatch({ type: 'accept', proposalId, parcelId: parcelIds[0] });
      if (!accepted.includes('parcel-link-clickable')) throw new Error(`Accept action did not emit a parcel link: ${accepted}`);
      const noOp = await dispatch({ type: 'nothing' });
      const noDonation = await dispatch({ type: 'donate', proposalId: 'missing-e2e-simulation-proposal', amount: 1 });
      const failedDonation = await dispatch({ type: 'donate', proposalId, amount: 0 });
      const donated = await dispatch({ type: 'donate', proposalId, amount: 1 });
      const noPledge = await dispatch({ type: 'pledge', proposalId: 'missing-e2e-simulation-proposal', amount: 1 });
      const failedPledge = await dispatch({ type: 'pledge', proposalId, amount: 0 });
      const pledged = await dispatch({ type: 'pledge', proposalId, amount: 1 });
      const unknown = await dispatch({ type: 'e2e-unknown-action' });

      const userAgent = w.agentStorage.getAllAgents().find((candidate: any) => candidate.userControlled);
      if (!userAgent) throw new Error('Guest setup did not create a user agent for game initialization');
      return {
        agentId: agent.id,
        userAgentId: userAgent.id,
        userAgentName: userAgent.name,
        proposalId,
        proposalTitle: w.proposalStorage.getProposal(proposalId).title,
        actionMessages: [created, noGround, staleGround, incomplete, rejected, accepted, noOp, noDonation, failedDonation, donated, noPledge, failedPledge, pledged, unknown],
      };
    }, { parcelIds: [PARCEL_ID, SECOND_PARCEL_ID] });

    await openActivityExplorer(page);
    const explorer = page.locator('.game-log-modal');

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
    // successful create/accept/donate/pledge paths and the ordinary no-op action.
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

    // Proposal buttons are the real markup returned by executeAgentAction and bound by game.js.
    const proposalLinks = explorer.locator('.activity-entry-main .proposal-link-clickable');
    const proposalLinkCount = await proposalLinks.count();
    expect(proposalLinkCount).toBeGreaterThanOrEqual(4);
    for (let index = 0; index < proposalLinkCount; index++) {
      const link = proposalLinks.nth(index);
      const targetId = await link.getAttribute('data-proposal-id');
      expect(targetId).toBeTruthy();
      const targetTitle = await page.evaluate(id => (window as any).proposalStorage.getProposal(id)?.title, targetId);
      expect(targetTitle).toBeTruthy();
      await link.click();
      await expect(page.locator('#proposal-details-panel')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(targetId);
      await expect(page.locator('#proposal-details-panel')).toContainText(targetTitle);
      if (index + 1 < proposalLinkCount) await openActivityExplorer(page);
    }

    // The accepted action adds its parcel control to the message body. Its handler highlights
    // the linked parcel and centers the map while the explorer stays open.
    await openActivityExplorer(page);
    const acceptedRow = page.locator('.game-log-modal .activity-entry').filter({ hasText: 'accepted proposal' }).first();
    const parcelLink = acceptedRow.locator('.activity-entry-main .parcel-link-clickable');
    await expect(parcelLink).toHaveAttribute('data-parcel-id', PARCEL_ID);
    await parcelLink.click();
    await expect.poll(() => page.evaluate(() => (window as any).selectedParcelId)).toBe(PARCEL_ID);
    await expect.poll(() => page.evaluate(parcelId => {
      const w = window as any;
      const layer = w.multiParcelSelection.findParcelById(parcelId);
      const style = layer?.options;
      const selectedStyles = [{ color: '#f57c00', fillOpacity: 0.6 }, w.selectedParcelStyle];
      return {
        parcelInView: Boolean(layer && w.map.getBounds().contains(layer.getBounds())),
        centered: Boolean(layer && w.map.getCenter().distanceTo(layer.getBounds().getCenter()) < 1),
        zoomClamped: w.map.getZoom() <= 18,
        // Parcels use Canvas. The live layer is highlighted immediately, and the presenter may
        // restore its single-selection style after the viewport refresh. Both must be rendered.
        highlighted: Boolean(layer && w.map.hasLayer(layer) && selectedStyles.some(expected =>
          style.color === expected.color && style.fillOpacity === expected.fillOpacity)),
      };
    }, PARCEL_ID)).toEqual({ parcelInView: true, centered: true, zoomClamped: true, highlighted: true });

    // The generic footer link comes from Activity explorer's event.entity renderer rather than
    // the action message HTML. Simulation events with a proposal action have this link as well.
    await openActivityExplorer(page);
    const footerProposalLink = page.locator(`.game-log-modal .activity-entry[data-source="simulation"] .activity-entry-links .proposal-link-clickable[data-proposal-id="${fixture.proposalId}"]`).first();
    await expect(footerProposalLink).toHaveAttribute('data-proposal-id', fixture.proposalId);
    await footerProposalLink.click();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(page.locator('#proposal-details-panel')).toContainText(fixture.proposalTitle);
  });

  test('user create, acceptance, and withdrawal log links open their targets', async ({ mockApi: page }) => {
    // Supply two owners at the parcel-data boundary so every repository refresh preserves the
    // same ownership. One acceptance must leave another outstanding for the real Undo action.
    const owners = [
      { name: 'Fixture private owner A', ownership: '1/2', percentageShare: 50 },
      { name: 'Fixture private owner B', ownership: '1/2', percentageShare: 50 },
    ];
    const parcels = structuredClone(sampleParcels);
    const parcel = parcels.features.find(feature => feature.properties.parcelId === PARCEL_ID)!;
    Object.assign(parcel.properties, {
      owners,
      ownershipList: owners.map(owner => ({ ...owner, percentage: owner.percentageShare })),
      ownershipDetails: { owners },
    });
    await page.route(url => /\/parcels(?:\/parcelIds)?$/.test(url.pathname), route => route.fulfill({
      contentType: 'application/json', body: JSON.stringify(parcels),
    }));
    await openCity(page);
    await page.evaluate(() => { if (!(window as any).gameState.isInitialized) (window as any).initializeGame(); });
    await page.locator('#username-display').click();
    await page.locator('#username-input').fill('Simulation log user');
    await page.locator('#welcome-submit-btn').click();
    await openParcel(page, 'info');
    await page.waitForFunction(parcelId => {
      const slots = (window as any).getParcelOwnerSlots?.(parcelId);
      return Array.isArray(slots) && slots.length === 2 && slots.every((slot: any) => !slot.placeholder);
    }, PARCEL_ID);
    await page.locator('#parcel-info-panel .close-button').click();

    // Use the regular Fork and proposal form to produce the user-created action, then the
    // same ownership acceptance controls used by the proposal actions UI. Owner data is fixture
    // state; the create, accept, and withdrawal effects themselves run through production code.
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
    await page.locator('.btn-counterpropose-proposal').click();
    const dialog = page.locator('.create-proposal-modal:visible');
    await expect(dialog).toBeVisible();
    const title = `Simulation log user action ${Date.now()}`;
    await dialog.locator('#proposalName').fill(title);
    await chooseProposalKind(dialog, 'owner-deal');
    const offer = dialog.locator('#proposalOffer');
    if (!(await offer.isVisible())) await dialog.locator('#proposalOptionsSection > .collapsible-header').click();
    await offer.fill('100');
    await dialog.locator('#createProposalSubmitButton').click();
    await expect(dialog).toBeHidden({ timeout: 10000 });

    const fixture = await page.evaluate(({ title, parcelId }) => {
      const w = window as any;
      const proposal = w.proposalStorage.getAllProposals().find((item: any) => item.title === title);
      if (!proposal) throw new Error('The user-created proposal was not saved');
      const owners = w.getOwnerSlotsForParcel(parcelId);
      if (!owners?.length) throw new Error('The parcel fixture returned no owner slots');
      const ownerOrder = owners.map((slot: any) => slot.key);
      // The fork/create flow authors abstract approval terms. For this local owner-control fixture,
      // use the same legacy owner-acceptance contract as proposal-actions.spec.ts so the real
      // Accept/Undo buttons do not require a wallet-backed rights attestation.
      delete proposal.approvalConfig;
      delete proposal.ownerApprovals;
      proposal.lifecycleStatus = 'Active';
      proposal.applied = false;
      proposal.funded = true;
      proposal.ownerAcceptances = {
        [parcelId]: {
          owners: Object.fromEntries(owners.map((slot: any) => [slot.key, slot])),
          ownerOrder,
          acceptedOwnerKeys: [],
          acceptedBy: {},
        },
      };
      w.proposalStorage._indexProposal(proposal);
      w.proposalStorage.save();
      const userAgent = w.agentStorage.getAllAgents().find((agent: any) => agent.userControlled);
      if (!userAgent) throw new Error('The local user agent is unavailable');
      return { proposalId: proposal.proposalId, userAgentId: userAgent.id, userAgentName: userAgent.name, ownerKey: ownerOrder[0] };
    }, { title, parcelId: PARCEL_ID });

    await showProposal(page, fixture.proposalId);
    const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
    if (await expand.isVisible()) await expand.click();
    const land = page.locator('#proposal-details-panel details[data-proposal-section="land"]');
    if (!(await land.evaluate((element: HTMLDetailsElement) => element.open))) await land.locator(':scope > summary').click();
    const ownerRow = page.locator(`.owner-acceptance-row[data-owner-key="${fixture.ownerKey}"]`);
    await expect(ownerRow.getByRole('button', { name: 'Accept' })).toBeVisible();
    await ownerRow.getByRole('button', { name: 'Accept' }).click();
    await expect(ownerRow.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect.poll(() => page.evaluate(({ proposalId, parcelId }) => {
      const proposal = (window as any).proposalStorage.getProposal(proposalId);
      return proposal.ownerAcceptances[parcelId].acceptedOwnerKeys;
    }, { proposalId: fixture.proposalId, parcelId: PARCEL_ID })).toContain(fixture.ownerKey);
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).lifecycleStatus, fixture.proposalId)).toBe('Active');
    await ownerRow.getByRole('button', { name: 'Undo' }).click();
    await expect(ownerRow.getByRole('button', { name: 'Accept' })).toBeVisible();
    await expect.poll(() => page.evaluate(({ proposalId, parcelId }) => {
      const proposal = (window as any).proposalStorage.getProposal(proposalId);
      return proposal.ownerAcceptances[parcelId].acceptedOwnerKeys;
    }, { proposalId: fixture.proposalId, parcelId: PARCEL_ID })).not.toContain(fixture.ownerKey);
    expect(await page.evaluate(id => (window as any).proposalStorage.getProposal(id).lifecycleStatus, fixture.proposalId)).toBe('Active');

    await openActivityExplorer(page);
    const explorer = page.locator('.game-log-modal');
    const openUserActor = async (row: import('@playwright/test').Locator) => {
      const actor = row.locator('.activity-entry-main .agent-link-clickable');
      await expect(actor).toHaveAttribute('data-agent-id', fixture.userAgentId);
      await actor.click();
      const profile = page.locator('.agent-dialog-modal');
      await expect(profile).toBeVisible();
      await expect(profile.locator('#agent-dialog-title')).toHaveText(fixture.userAgentName);
      await profile.locator('.agent-dialog-modal-close').click();
      await expect(profile).toHaveCount(0);
    };
    const createdRow = explorer.locator('.activity-entry').filter({ hasText: / created a .* proposal/ })
      .filter({ has: page.locator(`.activity-entry-main .proposal-link-clickable[data-proposal-id="${fixture.proposalId}"]`) });
    const createdLink = createdRow.locator('.activity-entry-main .proposal-link-clickable');
    await expect(createdLink).toBeVisible();
    await expect(createdRow).toHaveAttribute('data-source', 'simulation');
    await openUserActor(createdRow);
    await createdLink.click();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();
    await expect(page.locator('#proposal-details-panel')).toContainText(title);

    await openActivityExplorer(page);
    const acceptedRow = explorer.locator('.activity-entry').filter({ hasText: 'recorded acceptance' }).first();
    await expect(acceptedRow.locator('.activity-entry-main .proposal-link-clickable')).toHaveAttribute('data-proposal-id', fixture.proposalId);
    await openUserActor(acceptedRow);
    await acceptedRow.locator('.activity-entry-main .proposal-link-clickable').click();
    await expect(page.locator('#proposal-details-panel')).toBeVisible();

    await openActivityExplorer(page);
    const withdrawnRow = explorer.locator('.activity-entry').filter({ hasText: 'revoked acceptance' }).first();
    await openUserActor(withdrawnRow);
  });
});
