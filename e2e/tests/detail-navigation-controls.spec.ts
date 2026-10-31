// Cover proposal and parcel links that navigate from their semantic detail surfaces.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, showProposal, showProposalTab, PARCEL_ID, PARCEL_GEOMETRY } from '../helpers/runtime';
import { proposeOverPark } from '../helpers/agreements';

async function addProposal(page: import('@playwright/test').Page, record: Record<string, unknown>): Promise<string> {
  const value = {
    lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'unknown', claimedStatus: 'Active', reason: 'no-matching-observation' },
    ...record,
  };
  return page.evaluate(proposal => (window as any).proposalStorage.addProposal(proposal), value);
}

test.describe('Detail navigation controls @features', () => {
  test('Open design in live Activity opens the matching local design', async ({ mockApi: page }) => {
    await openCity(page);
    // An agreement proposed from this device over a park applied here: the feed carries the park as a
    // design row whose link opens this device's copy (plan-design-agreement.md, M3).
    const { designCid, parkId, parkTitle } = await proposeOverPark(page, { title: 'Activity link agreement', author: 'Navigation actor' });

    await page.locator('#activity-button').click();
    const explorer = page.locator('#activity-sheet');
    await expect(explorer).toBeVisible();
    const link = explorer.locator(`.activity-entity-link[data-entity-type="design"][data-entity-id="${designCid}"]`);
    await expect(link).toBeVisible({ timeout: 30_000 });
    // The row is an object-list item: hovering outlines the design, a click keeps it outlined
    // (pressed) and opens nothing, a second click lets go; only Open design opens it.
    const row = explorer.locator('#game-log-content .activity-entry')
      .filter({ has: page.locator(`.activity-entity-link[data-entity-id="${designCid}"]`) });
    await row.locator('.activity-entry-main').hover();
    await expect(page.locator('path.proposal-hover-outline').first()).toBeAttached();
    await row.locator('.activity-entry-main').click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(explorer).toBeVisible();
    await row.locator('.activity-entry-main').click();
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    await link.click();
    await expect(explorer).toBeHidden();
    const planningInspector = page.locator('#planning-inspector');
    const proposalPanel = page.locator('#proposal-details-panel');
    await expect.poll(async () => await planningInspector.isVisible() || await proposalPanel.isVisible()).toBe(true);
    if (await planningInspector.isVisible()) {
      await expect.poll(() => page.evaluate(() => (window as any).PlanningViews?.getSelected()?.proposalId)).toBe(parkId);
      await expect(planningInspector).toContainText(parkTitle);
    } else {
      await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(parkId);
      await expect(proposalPanel).toContainText(parkTitle);
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
    await showProposalTab(page, 'overview');
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
    await showProposalTab(page, 'overview');
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
});
