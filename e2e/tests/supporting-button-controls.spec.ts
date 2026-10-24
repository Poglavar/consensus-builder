// Exercise supporting page and wallet buttons through their actual dialogs and persisted state.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';
import { cidOfObject } from '../helpers/mocks/shared-server';

// Activity is about agreements and designs, named by their CIDs (plan-design-agreement.md, M3).
const PARK_AGREEMENT = cidOfObject({ schema: 'agreement/v1', title: 'Park agreement' });
const BLOCK_AGREEMENT = cidOfObject({ schema: 'agreement/v1', title: 'Block agreement' });
const BLOCK_DESIGN = cidOfObject({ schema: 'design/v1', title: 'Block design' });

const json = (route: any, body: unknown) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.describe('Supporting page button controls @core', () => {
  test('Activity feed filter and Refresh buttons change the feed and reload its source', async ({ mockApi: page }) => {
    let requests = 0;
    await page.route('**/agent/activity**', route => {
      requests += 1;
      return json(route, { events: [
        {
          id: 'feed-human', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
          actor: { id: 'human-1', name: 'Ari', kind: 'human', controller: 'human' },
          action: { type: 'propose', agreementCid: PARK_AGREEMENT }, entity: { type: 'agreement', id: PARK_AGREEMENT },
          source: 'live', message: 'Proposed a park agreement', ok: true,
        },
        {
          id: 'feed-agent', occurredAt: '2026-10-01T11:00:00Z', recordedAt: '2026-10-01T11:00:00Z',
          actor: { id: 'agent-1', name: 'Block planner', kind: 'agent', controller: 'algorithm' },
          action: { type: 'design', designCid: BLOCK_DESIGN }, entity: { type: 'design', id: BLOCK_DESIGN },
          source: 'live', message: 'Published a block design', ok: true,
        },
      ] });
    });

    await openCity(page);
    await page.locator('#activity-button').click();
    const panel = page.locator('#activity-sheet');
    const feed = panel.locator('#game-log-content');
    const controls = panel.locator('#activity-panel-controls');
    const filterDetails = controls.locator('details');
    if (!(await filterDetails.evaluate((details: HTMLDetailsElement) => details.open))) await filterDetails.locator(':scope > summary').click();
    // These fixture events have no cityId, so keep the feed on its explicit all-cities scope.
    await controls.locator('[data-activity-filter-field="cityScope"]').selectOption('all');
    await expect(feed.locator('.activity-entry')).toHaveCount(2);
    // Each row opens what it is about: the agreement, or the design.
    await expect(feed.locator('.activity-entry').filter({ hasText: 'Proposed a park agreement' })
      .locator(`.activity-entity-link[data-entity-type="agreement"][data-entity-id="${PARK_AGREEMENT}"]`)).toHaveText('Open agreement');
    await expect(feed.locator('.activity-entry').filter({ hasText: 'Published a block design' })
      .locator(`.activity-entity-link[data-entity-type="design"][data-entity-id="${BLOCK_DESIGN}"]`)).toHaveText('Open design');
    const kind = controls.locator('[data-activity-filter-field="kind"]');
    await kind.selectOption('agent');
    await expect(kind).toHaveValue('agent');
    await expect(feed.locator('.activity-entry')).toHaveCount(1);
    await expect(feed).toContainText('Published a block design');
    await expect(feed).not.toContainText('Proposed a park agreement');

    const beforeRefresh = requests;
    await controls.locator('[data-activity-refresh]').click();
    await expect.poll(() => requests).toBeGreaterThan(beforeRefresh);
    await kind.selectOption('human');
    await expect(feed.locator('.activity-entry')).toHaveCount(1);
    await expect(feed).toContainText('Proposed a park agreement');
    await kind.selectOption('all');
    await expect(feed.locator('.activity-entry')).toHaveCount(2);
    await expect(feed).toContainText('Proposed a park agreement');
    await expect(feed).toContainText('Published a block design');
  });

  test('actor profile buttons filter the activity list and can restore all actors', async ({ mockApi: page }) => {
    await page.route('**/agent/activity**', route => json(route, { events: [
      {
        id: 'event-human', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
        actor: { id: 'human-1', name: 'Ari', kind: 'human', controller: 'human' },
        action: { type: 'propose', agreementCid: PARK_AGREEMENT }, entity: { type: 'agreement', id: PARK_AGREEMENT },
        source: 'live', message: 'Proposed a park agreement', ok: true,
      },
      {
        id: 'event-agent', occurredAt: '2026-10-01T11:00:00Z', recordedAt: '2026-10-01T11:00:00Z',
        actor: { id: 'agent-1', name: 'Block planner', kind: 'agent', controller: 'algorithm' },
        action: { type: 'execute', agreementCid: BLOCK_AGREEMENT }, entity: { type: 'agreement', id: BLOCK_AGREEMENT },
        source: 'live', message: 'Executed the block agreement', ok: true, transaction: 'execute-signature-fixture',
      },
    ] }));

    await page.goto('/actor-explorer.html');
    const profiles = page.locator('.ae-profile-grid .cb-option');
    await expect(profiles).toHaveCount(2);
    const planner = profiles.filter({ hasText: 'Block planner' });
    // A card counts the agreements its actor acted on and the transactions it signed.
    await expect(planner).toContainText('1 activity · 1 agreement · 1 transaction');
    await planner.click();
    await expect(planner).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.ae-activity')).toContainText('Activity (1)');
    await expect(page.locator('.ae-event')).toContainText('Executed the block agreement');
    await expect(page.locator('.ae-event')).not.toContainText('Proposed a park agreement');

    await planner.click();
    await expect(planner).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.ae-activity')).toContainText('Activity (2)');
  });

  test('transaction rows expand and collapse their instruction details on click', async ({ mockApi: page }) => {
    const payload = {
      cluster: 'devnet', fetchedAt: '2026-10-01T12:00:00Z', cached: false,
      explorer: { tx: 'https://explorer.solana.com/tx/{sig}?cluster=devnet', address: 'https://explorer.solana.com/address/{addr}?cluster=devnet' },
      watched: [{ address: 'wallet-one', label: 'agent wallet', kind: 'wallet' }], count: 1,
      transactions: [{
        signature: 'sig-expand', time: '2026-10-01T12:00:00Z', status: 'success', summary: 'Create proposal market',
        feePayer: { address: 'wallet-one', label: 'agent wallet' }, feeSol: '0.00001', programs: ['proposal-market'],
        actions: ['createMarket'], amounts: [], instructions: [{
          program: { name: 'proposal-market', address: 'program-one', label: 'proposal-market' },
          action: 'createMarket', accounts: [{ address: 'wallet-one', label: 'agent wallet', role: 'authority', signer: true, writable: true }],
        }],
      }],
    };
    await page.route('**/transactions**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/transactions/watched')) return json(route, { watched: payload.watched, explorer: payload.explorer });
      return json(route, payload);
    });

    await page.goto('/tx-explorer.html');
    const row = page.locator('.tx-row[data-signature="sig-expand"]');
    await expect(row).toBeVisible();
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    const details = page.locator('.tx-details-row[data-signature="sig-expand"]');
    await expect(details).toBeVisible();
    await expect(details).toContainText('createMarket');
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(details).toHaveCount(0);
  });
});
