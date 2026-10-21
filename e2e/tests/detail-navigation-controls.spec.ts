// Cover proposal and parcel links that navigate from their semantic detail surfaces.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';

async function addProposal(page: import('@playwright/test').Page, record: Record<string, unknown>): Promise<string> {
  const value = {
    lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
    ...record,
  };
  return page.evaluate(proposal => (window as any).proposalStorage.addProposal(proposal), value);
}

test.describe('Detail navigation controls @features', () => {
  test('Open proposal in live Activity opens the matching local proposal', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await addProposal(page, {
      proposalId: 'e2e-activity-link-proposal', title: 'Activity link destination', goal: 'park',
      city: 'zagreb', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID],
    });
    await page.route('**/agent/activity**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [{
        id: 'e2e-activity-proposal-link', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
        actor: { id: 'e2e-link-actor', name: 'Navigation actor', kind: 'agent', controller: 'algorithm' },
        action: { type: 'publish' }, entity: { type: 'proposal', id: proposalId },
        source: 'live', message: 'Published the activity link destination', ok: true,
      }] }),
    }));

    await page.locator('#activity-button').click();
    await page.locator('#activity-explorer-button').click();
    const explorer = page.locator('.game-log-modal');
    await expect(explorer).toBeVisible();
    const link = explorer.locator(`.proposal-link-clickable[data-proposal-id="${proposalId}"]`);
    await expect(link).toBeVisible();
    await link.click();
    await expect(explorer).toBeHidden();
    const planningInspector = page.locator('#planning-inspector');
    const proposalPanel = page.locator('#proposal-details-panel');
    await expect.poll(async () => await planningInspector.isVisible() || await proposalPanel.isVisible()).toBe(true);
    if (await planningInspector.isVisible()) {
      await expect.poll(() => page.evaluate(() => (window as any).PlanningViews?.getSelected()?.proposalId)).toBe(proposalId);
      await expect(planningInspector).toContainText('Activity link destination');
    } else {
      await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(proposalId);
      await expect(proposalPanel).toContainText('Activity link destination');
    }
  });

  test('parcel block tag opens the matching block inspector', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(async parcelId => {
      const w = window as any;
      await w.CadastralParcelRepository.ensureIds([parcelId]);
      const layer = w.ParcelPresenter.getLayer(parcelId);
      if (!layer) throw new Error(`Fixture parcel ${parcelId} is unavailable`);
      w.blockStorage.addBlock('E2E navigation block', [layer]);
    }, PARCEL_ID);
    await openParcel(page, 'info');
    const blockTag = page.locator('#parcel-info-panel .block-tag');
    await expect(blockTag).toHaveText('E2E navigation block');
    await blockTag.click();
    const inspector = page.locator('#block-info-panel');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('E2E navigation block');
    await expect.poll(() => page.evaluate(() => (window as any).selectedBlockName)).toBe('E2E navigation block');
  });

  test('Based on and author links open their source proposal and agent', async ({ mockApi: page }) => {
    await openCity(page);
    await page.locator('#username-display').click();
    const welcome = page.locator('#welcome-modal');
    if (await welcome.isVisible()) {
      await page.locator('#username-input').fill('Detail navigation author');
      await page.locator('#welcome-submit-btn').click();
      await expect(welcome).toBeHidden();
    } else {
      const profile = page.locator('.agent-dialog-modal');
      if (await profile.isVisible()) await profile.locator('.agent-dialog-modal-close').click();
    }
    const author = await page.evaluate(() => {
      const agent = (window as any).getCurrentUserAgent();
      if (!agent?.id || !agent?.name) throw new Error('The fixture profile has no local agent');
      return { id: agent.id, name: agent.name };
    });
    const sourceId = await addProposal(page, {
      proposalId: 'e2e-based-on-source', title: 'Based-on source destination', goal: 'as-is', city: 'zagreb',
      lifecycleStatus: 'Active', author: author.name, cadastreParcelIds: [PARCEL_ID], geometry: PARCEL_GEOMETRY,
    });
    const childId = await addProposal(page, {
      proposalId: 'e2e-based-on-child', title: 'Based-on child source', goal: 'as-is', city: 'zagreb',
      lifecycleStatus: 'Active', author: author.name, cadastreParcelIds: [PARCEL_ID], geometry: PARCEL_GEOMETRY,
      proposalOrigin: { relation: 'copy', source: { kind: 'local', localProposalId: sourceId }, title: 'Based-on source destination' },
    });

    await showProposal(page, childId);
    const panel = page.locator('#proposal-details-panel');
    if (await panel.evaluate(element => element.classList.contains('is-minimized'))) {
      await panel.locator('#proposal-details-minimize').click();
    }
    await expect(panel).not.toHaveClass(/is-minimized/);
    const basedOn = panel.locator('.proposal-based-on-link');
    await expect(basedOn).toHaveText('Based-on source destination');
    await basedOn.click();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(sourceId);
    await expect(panel).toContainText('Based-on source destination');

    await showProposal(page, childId);
    if (await panel.evaluate(element => element.classList.contains('is-minimized'))) {
      await panel.locator('#proposal-details-minimize').click();
    }
    await expect(panel).not.toHaveClass(/is-minimized/);
    const authorLink = panel.locator('.proposal-author-row .agent-link-clickable');
    await expect(authorLink).toHaveAttribute('data-agent-id', author.id);
    await authorLink.click();
    const agentDialog = page.locator('.agent-dialog-modal');
    await expect(agentDialog).toBeVisible();
    await expect(agentDialog.locator('#agent-dialog-title')).toHaveText(author.name);
  });

  test('Edit approval opens the proposal editor on its Approval tab', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await addProposal(page, {
      proposalId: 'e2e-edit-approval-navigation', title: 'Approval editor destination', goal: 'as-is',
      city: 'zagreb', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID], geometry: PARCEL_GEOMETRY,
    });
    await showProposal(page, proposalId);
    const details = page.locator('#proposal-details-panel');
    if (await details.evaluate(element => element.classList.contains('is-minimized'))) {
      await details.locator('#proposal-details-minimize').click();
    }
    await expect(details).not.toHaveClass(/is-minimized/);
    const ownership = details.locator('details[data-proposal-section="land"]');
    if (!(await ownership.evaluate((element: HTMLDetailsElement) => element.open))) {
      await ownership.locator(':scope > summary').click();
    }
    const editApproval = details.locator('.btn-edit-approval');
    await expect(editApproval).toBeVisible();
    await editApproval.click();
    const editor = page.locator('.proposal-editor-shell');
    await expect(editor).toBeVisible();
    await expect(editor.locator('[data-editor-action="tab"][data-editor-tab="approval"]')).toHaveAttribute('aria-selected', 'true');
    await expect(editor.locator('[data-editor-section="approval"]')).toBeVisible();
  });
});
