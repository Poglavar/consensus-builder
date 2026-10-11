// Exercise supporting page and wallet buttons through their actual dialogs and persisted state.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

const json = (route: any, body: unknown) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.describe('Supporting page button controls @core', () => {
  test('Canton chain selection opens the identity picker and its identity actions update the active party', async ({ mockApi: page }) => {
    await page.addInitScript(() => {
      (window as any).CANTON_ENABLED = true;
      localStorage.setItem('canton.parties', JSON.stringify([
        { party: 'Owner::fingerprint', role: 'owner', parcelId: '', ts: 1 },
        { party: 'Buyer::fingerprint', role: 'buyer', parcelId: '', ts: 2 },
      ]));
    });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route('**/canton/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      // The frontend modules also live under /js/canton/. Only fixture API calls here;
      // returning JSON for those script requests makes the Canton modules fail to parse.
      if (!pathname.startsWith('/canton/')) return route.continue();
      if (pathname.endsWith('/canton/parties') && request.method() === 'POST') {
        return json(route, { party: 'Generated::fingerprint' });
      }
      if (pathname.includes('/canton/ccview/')) {
        return json(route, { indexed: false, explorerUrl: 'https://ccview.example/party/owner' });
      }
      return json(route, { proposals: [], sales: [], counts: {} });
    });

    await openCity(page);
    await page.locator('#username-display').click();
    const welcome = page.locator('#welcome-modal');
    await expect(welcome).toBeVisible();
    await page.locator('#username-input').fill('Canton UI actor');
    await page.locator('#welcome-submit-btn').click();
    await page.locator('#username-display').click();
    const profile = page.locator('.agent-dialog-modal');
    await expect(profile).toBeVisible();

    const network = profile.locator('.wallet-chain-info');
    await network.click();
    const chainModal = page.locator('.chain-modal-overlay');
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-id="canton"]').click();
    const picker = page.locator('.canton-id-overlay');
    await expect(picker).toBeVisible();
    const owner = picker.locator('.canton-id-row2').filter({ has: page.locator('[data-party-select="Owner::fingerprint"]') });
    await owner.locator('[data-copy]').click();
    await expect(picker.locator('[data-err]')).toContainText('Copied party id');
    await owner.locator('[data-ccview]').click();
    await expect(owner.locator('.canton-ccview-out')).toContainText('Not yet indexed');
    await picker.locator('[data-forget="Buyer::fingerprint"]').click();
    await expect(picker.locator('.canton-id-row2')).toHaveCount(1);
    await picker.locator('#canton-id-paste').fill('Buyer::fingerprint');
    await picker.locator('[data-use-paste]').click();
    await expect(picker).toHaveCount(0);
    await expect(network).toContainText('Canton · Buyer');

    await network.click();
    const activePicker = page.locator('.canton-id-overlay');
    await activePicker.locator('[data-gen]').click();
    await expect(activePicker).toHaveCount(0);
    await expect(network).toContainText('Canton · Generated');
    await network.click();
    await page.locator('.canton-id-overlay [data-leave]').click();
    await expect(page.locator('.canton-id-overlay')).toHaveCount(0);
    await expect(network).toContainText('Select network');
  });

  test('Activity feed filter and Refresh buttons change the feed and reload its source', async ({ mockApi: page }) => {
    let requests = 0;
    await page.route('**/agent/activity**', route => {
      requests += 1;
      return json(route, { events: [
        {
          id: 'feed-human', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
          actor: { id: 'human-1', name: 'Ari', kind: 'human', controller: 'human' },
          action: { type: 'publish' }, entity: { type: 'proposal', id: 'park-1' },
          source: 'proposal', message: 'Published a park plan', ok: true,
        },
        {
          id: 'feed-agent', occurredAt: '2026-10-01T11:00:00Z', recordedAt: '2026-10-01T11:00:00Z',
          actor: { id: 'agent-1', name: 'Block planner', kind: 'agent', controller: 'algorithm' },
          action: { type: 'create' }, entity: { type: 'proposal', id: 'block-1' },
          source: 'agent', message: 'Created a block plan', ok: true,
        },
      ] });
    });

    await openCity(page);
    await page.locator('#activity-button').click();
    const feed = page.locator('#activity-feed');
    await expect(feed.locator('.activity-entry')).toHaveCount(2);
    const filters = feed.locator('.activity-feed__filters');
    const agents = filters.getByRole('button', { name: 'Agents' });
    await agents.click();
    await expect(agents).toHaveAttribute('aria-pressed', 'true');
    await expect(feed.locator('.activity-entry')).toHaveCount(1);
    await expect(feed).toContainText('Created a block plan');
    await expect(feed).not.toContainText('Published a park plan');

    const beforeRefresh = requests;
    await filters.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => requests).toBeGreaterThan(beforeRefresh);
    await filters.getByRole('button', { name: 'People' }).click();
    await expect(feed.locator('.activity-entry')).toHaveCount(1);
    await expect(feed).toContainText('Published a park plan');
    await filters.getByRole('button', { name: 'All', exact: true }).click();
    await expect(feed.locator('.activity-entry')).toHaveCount(2);
    await expect(feed).toContainText('Published a park plan');
    await expect(feed).toContainText('Created a block plan');
  });

  test('actor profile buttons filter the activity list and can restore all actors', async ({ mockApi: page }) => {
    await page.route('**/agent/activity**', route => json(route, { events: [
      {
        id: 'event-human', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
        actor: { id: 'human-1', name: 'Ari', kind: 'human', controller: 'human' },
        action: { type: 'publish' }, entity: { type: 'proposal', id: 'park-1' },
        source: 'proposal', message: 'Published a park plan', ok: true,
      },
      {
        id: 'event-agent', occurredAt: '2026-10-01T11:00:00Z', recordedAt: '2026-10-01T11:00:00Z',
        actor: { id: 'agent-1', name: 'Block planner', kind: 'agent', controller: 'algorithm' },
        action: { type: 'create' }, entity: { type: 'proposal', id: 'block-1' },
        source: 'agent', message: 'Created a block plan', ok: true,
      },
    ] }));

    await page.goto('/actor-explorer.html');
    const profiles = page.locator('.ae-profile-card');
    await expect(profiles).toHaveCount(2);
    const planner = profiles.filter({ hasText: 'Block planner' });
    await planner.click();
    await expect(planner).toHaveClass(/is-selected/);
    await expect(page.locator('.ae-activity')).toContainText('Activity (1)');
    await expect(page.locator('.ae-event')).toContainText('Created a block plan');
    await expect(page.locator('.ae-event')).not.toContainText('Published a park plan');

    await planner.click();
    await expect(planner).not.toHaveClass(/is-selected/);
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
