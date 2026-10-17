// Named plans in the app (js/proposals/plans.js, js/proposals/plan-view.js): the parcel menu's
// "Proposals (N)" opens the parcel's Proposals tab; a proposal row says which plan it is part of; the
// tab's Plans view and the proposals list's Plans source list plans; a plan opens hatched on the map
// with its panel, where Apply plan applies it, and a plan link opens the same view instead of
// applying at once.
import { test, expect } from '../helpers/fixtures';
import { createSpace, openCity, showProposal, clickMapPoint, publishOn, PARCEL_ID } from '../helpers/runtime';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';

const SLUG = 'e2e-harbor-plan';

// The published park (uploaded through the real Share → Upload) is the plan's one member. The plan
// answers are routed before the app loads: it asks for the city's plans early and keeps the answer.
async function publishPark(page: any): Promise<{ localId: string; serverId: string; title: string }> {
  const server = createSharedProposalServer();
  await attachSharedProposalServer(page, server);
  await routePlans(page, String(server.nextId));
  await openCity(page);
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Plan tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  const localId = await createSpace(page, 'park');
  const title = await page.evaluate((id: string) => (window as any).proposalStorage.getProposal(id)?.title, localId);
  await showProposal(page, localId);
  await page.locator('#proposal-details-panel .btn-share-proposal').click();
  const share = page.locator('.share-modal-overlay');
  await share.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(share.locator('.share-modal-link').first()).toHaveValue(/\/proposals\/\d+\?/);
  await share.locator('.share-modal .close-circle-btn').click();
  const serverId = [...server.records.keys()][0];
  await page.evaluate(() => (window as any).hideProposalDetailsPanel(true));
  return { localId, serverId, title: String(title) };
}

async function routePlans(page: any, serverId: string): Promise<void> {
  const plan = {
    slug: SLUG, name: `${SLUG}.proposals.urbangametheory.eth`, title: 'E2E harbor plan', description: 'A park and nothing else.',
    author: 'Plan tester', place: 'Harbor', city: 'zagreb', proposalIds: [serverId], memberCount: 1, superseded: false,
    proposalAccount: null, createdAt: '2026-10-17T10:00:00.000Z'
  };
  await page.route(/\/plans(\?.*)?$/, (route: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plans: [plan] }) }));
  await page.route(`**/plans/${SLUG}`, (route: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ...plan, supersededBy: [], members: [{ id: serverId, proposalId: 'p-park', title: 'Harbor park', type: 'park', goal: 'park', changed: false }]
  }) }));
}

async function openParcelMenu(page: any): Promise<void> {
  const center = await page.evaluate((id: string) => {
    const w = window as any;
    const c = w.ParcelPresenter.getLayer(id).getBounds().getCenter();
    w.map.panTo(c, { animate: false });
    return { lng: c.lng, lat: c.lat };
  }, PARCEL_ID);
  await clickMapPoint(page, center.lng, center.lat);
  await expect(page.locator('#parcel-menu')).toBeVisible();
}

test.describe('Named plans @features', () => {
  test('the parcel menu counts the proposals here, published ones included, and opens the Proposals tab', async ({ mockApi: page }) => {
    await publishOn(page, PARCEL_ID);
    await openCity(page);
    await openParcelMenu(page);
    const item = page.locator('#parcel-menu [data-command="parcel.proposals"]');
    await expect(item).toHaveText('Proposals (1)');
    await expect(item).not.toHaveClass(/cb-busy/);
    await item.click();
    await expect(page.locator('#proposals-tab')).toBeVisible();
    await expect(page.locator('#proposals-content .parcel-set-proposal')).toHaveCount(1);
    await expect(page.locator('#parcel-info-panel [data-parcel-proposals-count="proposals"]')).toHaveText('(1)');
  });

  test('a proposal row names its plan, the Plans view lists it, and the plan opens hatched with Apply plan', async ({ mockApi: page }) => {
    const { localId, serverId } = await publishPark(page);
    expect(serverId).toBe('7001');
    // Off the map, so that Apply plan has something to apply.
    await page.evaluate((id: string) => (window as any).ProposalManager.unapplyProposal(id), localId);
    await expect.poll(() => page.evaluate((id: string) => (window as any).isProposalCurrentlyApplied((window as any).getProposalByIdOrHash(id)), localId)).toBe(false);

    await openParcelMenu(page);
    await page.locator('#parcel-menu [data-command="parcel.proposals"]').click();
    const line = page.locator('#proposals-content .proposal-plan-link');
    await expect(line).toHaveText(/Part of plan E2E harbor plan/);

    await page.locator('#parcel-info-panel [data-parcel-proposals-view="plans"]').click();
    await expect(page.locator('#parcel-plans-content .plan-item')).toHaveCount(1);
    await expect(page.locator('#parcel-info-panel [data-parcel-proposals-count="plans"]')).toHaveText('(1)');
    await expect(page.locator('#proposals-content')).toBeHidden();
    await page.locator('#parcel-info-panel [data-parcel-proposals-view="proposals"]').click();
    await line.click();

    const panel = page.locator('#plan-view-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#plan-view-title')).toHaveText('E2E harbor plan');
    await expect(page.locator('#parcel-info-panel')).toBeHidden();
    await expect(page.locator('.plan-preview-member')).not.toHaveCount(0);
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe(`/proposals/${SLUG}`);
    await panel.locator('[data-plan-member]').first().click();
    const apply = panel.locator('[data-plan-action="apply"]');
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(panel).toBeHidden();
    // Applying a plan goes through its published records: the member stands as the record of its row id.
    await expect.poll(() => page.evaluate((id: string) => {
      const w = window as any;
      return w.proposalStorage.getAllProposals().some((p: any) => String(w.getServerProposalId(p)) === id && w.isProposalCurrentlyApplied(p));
    }, serverId), { timeout: 30_000 }).toBe(true);
    // Apply plan ends the way a plan link used to: framing what it applied and opening its panel.
    await expect(page.locator('#proposal-details-panel')).toBeVisible({ timeout: 30_000 });

    // Opened again, the plan says it is on the map; Copy link and Close work, and Escape closes too.
    await page.evaluate((slug: string) => (window as any).PlanView.open(slug), SLUG);
    await expect(apply).toBeDisabled();
    await expect(apply).toHaveText(/On the map/);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.locator('[data-plan-action="share"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`/proposals/${SLUG}`);
    await panel.locator('[data-plan-action="close"]').click();
    await expect(panel).toBeHidden();
    await expect(page.locator('.plan-preview-member')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => location.pathname)).toBe('/');
  });

  test('the proposals list has a Plans source whose rows open their plan', async ({ mockApi: page }) => {
    await publishPark(page);
    await page.evaluate(() => (window as any).showAllProposalsModal());
    const source = page.locator('.proposal-source-btn[data-source="plans"]');
    await expect(source).toHaveText(/Plans \(1\)/);
    await expect(page.locator('.proposal-list-item .proposal-plan-link')).toHaveText(/Part of plan E2E harbor plan/);
    await source.click();
    await expect(page.locator('.proposal-list-modal .proposal-filters-toggle')).toHaveCount(0);
    await page.locator('.proposal-list-modal .plan-item').click();
    await expect(page.locator('#plan-view-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#plan-view-panel')).toBeHidden();
  });
});
