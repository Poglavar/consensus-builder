// Verify secondary wallet, profile, activity and supporting controls through real UI paths.
import { test, expect } from '../helpers/fixtures';
import { openCity, stubBasemapTiles } from '../helpers/runtime';
import { waitForMapReady } from '../helpers/app';
import { getWalletStates, injectMockEvmWallet, injectMockSolanaWallet, openWalletModal, waitForBlockchainRuntime } from '../helpers/blockchain';
import { cidOfObject } from '../helpers/mocks/shared-server';
import { selectors } from '../helpers/selectors';

const json = (route: any, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// Two agreements in the live feed (plan-design-agreement.md, M3: activity is about agreements, by CID).
const SCOPED_AGREEMENT = cidOfObject({ schema: 'agreement/v1', title: 'Scoped park agreement' });
const OTHER_AGREEMENT = cidOfObject({ schema: 'agreement/v1', title: 'Unrelated block agreement' });
const shortCid = (cid: string) => `${cid.slice(0, 12)}…${cid.slice(-6)}`;
const SCOPED_EVENT = {
  id: 'scoped-event', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
  actor: { id: 'scope-actor', name: 'Map Steward', kind: 'agent', controller: 'algorithm' },
  action: { type: 'propose', agreementCid: SCOPED_AGREEMENT }, entity: { type: 'agreement', id: SCOPED_AGREEMENT },
  source: 'live', message: 'Proposed the scoped park agreement', ok: true, runId: 'scope-run-42',
};
const OTHER_EVENT = {
  id: 'other-event', occurredAt: '2026-10-02T12:00:00Z', recordedAt: '2026-10-02T12:00:00Z',
  actor: { id: 'other-actor', name: 'Other Planner', kind: 'agent', controller: 'algorithm' },
  action: { type: 'propose', agreementCid: OTHER_AGREEMENT }, entity: { type: 'agreement', id: OTHER_AGREEMENT },
  source: 'live', message: 'Proposed an unrelated block agreement', ok: true, runId: 'other-run-99',
};

async function openProfile(page: import('@playwright/test').Page, username: string) {
  await page.locator('#username-display').click();
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) {
    await page.locator('#username-input').fill(username);
    await page.locator('#welcome-submit-btn').click();
  }
  await page.locator('#username-display').click();
  const profile = page.locator('.agent-dialog-modal');
  await expect(profile).toBeVisible();
  return profile;
}

test.describe('Supporting secondary controls @core', () => {
  test('EVM chain options switch networks and the chain modal Close button dismisses it', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { chainIdHex: '0x1', walletKind: 'metamask' });
    await page.addInitScript(() => {
      const provider = (window as any).ethereum;
      if (!provider?.request) return;
      const request = provider.request.bind(provider);
      provider.request = async (args: any) => {
        if (args?.method === 'eth_getCode') return '0x6000';
        if (args?.method === 'eth_getBalance') return '0x0';
        if (args?.method === 'eth_blockNumber') return '0x1';
        if (args?.method === 'eth_getTransactionCount') return '0x0';
        if (args?.method === 'eth_gasPrice' || args?.method === 'eth_maxPriorityFeePerGas') return '0x1';
        if (args?.method === 'eth_estimateGas') return '0x5208';
        if (args?.method === 'eth_call') return '0x';
        return request(args);
      };
    });
    await openCity(page);
    await openWalletModal(page);
    await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="metamask"]`).click();
    await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);
    const profile = await openProfile(page, 'EVM selector actor');
    const network = profile.locator('.wallet-chain-info');
    await network.click();
    const chainModal = page.locator('.chain-modal-overlay');
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-id="0x14a34"]').click();
    await expect.poll(async () => (await getWalletStates(page)).evm?.chainId).toBe('0x14a34');

    await network.click();
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-modal-close]').click();
    await expect(chainModal).toHaveCount(0);
  });

  test('City token Register and Claim use the connected account and render their completion states', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { chainIdHex: '0xaa36a7', walletKind: 'metamask' });
    await page.route('**/contracts/addresses.json', route => route.fulfill({ json: {
      '11155111': { CityMemeToken: '0x0000000000000000000000000000000000000001' },
    } }));
    await page.addInitScript(() => {
      const provider = (window as any).ethereum;
      if (!provider?.request) return;
      const request = provider.request.bind(provider);
      provider.request = async (args: any) => {
        if (args?.method === 'eth_getCode') return '0x6000';
        if (args?.method === 'eth_getBalance') return '0x0';
        if (args?.method === 'eth_blockNumber') return '0x1';
        // Ethers may inspect the connected account while refreshing wallet state. The
        // injected wallet's default null response is not a valid JSON-RPC quantity.
        if (args?.method === 'eth_getTransactionCount') return '0x0';
        if (args?.method === 'eth_gasPrice' || args?.method === 'eth_maxPriorityFeePerGas') return '0x1';
        if (args?.method === 'eth_estimateGas') return '0x5208';
        if (args?.method === 'eth_call') return '0x';
        return request(args);
      };
    });
    await openCity(page);
    await openWalletModal(page);
    await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="metamask"]`).click();
    const profile = await openProfile(page, 'City token actor');
    // ethers loads on demand (the EVM connection starts it, the city token awaits it); the token
    // contract is replaced only once it is there.
    await waitForBlockchainRuntime(page, ['ethers']);
    await page.evaluate(() => {
      const w = window as any;
      let registered = false;
      let available = 3n;
      const tokenAddress = '0x0000000000000000000000000000000000000001';
      const originalContract = w.ethers.Contract;
      Object.defineProperty(w.ethers, 'Contract', {
        configurable: true,
        value: new Proxy(originalContract, {
          construct(target, args, newTarget) {
            if (String(args[0]).toLowerCase() !== tokenAddress) return Reflect.construct(target, args, newTarget);
            return {
              decimals: async () => 0,
              balanceOf: async () => 0n,
              availableBalance: async () => available,
              citizens: async () => [registered ? 1n : 0n, 0n],
              registerAsCitizen: async () => {
                registered = true;
                return { hash: '0xregister', wait: async () => ({ hash: '0xregister' }) };
              },
              withdraw: async (_amount: bigint) => {
                available = 0n;
                return { hash: '0xclaim', wait: async () => ({ hash: '0xclaim' }) };
              },
            };
          },
        }),
      });
    });

    await profile.getByRole('button', { name: 'City token', exact: true }).click();
    const cityToken = page.locator('.city-token-overlay');
    await expect(cityToken).toBeVisible();
    await expect(cityToken.locator('[data-city-token-claim]')).toBeDisabled();
    await cityToken.locator('[data-city-token-register]').click();
    await expect(cityToken.locator('[data-city-token-register]')).toHaveClass(/city-token-registered-label/);
    await expect(cityToken.locator('[data-city-token-register]')).toHaveText('Registered');
    await expect(cityToken.locator('[data-city-token-claim]')).toBeEnabled();
    await cityToken.locator('[data-city-token-claim]').click();
    await expect(cityToken.locator('[data-city-token-allotment]')).toHaveText(/0\.0+ CTY/);
    await expect(cityToken.locator('[data-city-token-claim]')).toBeDisabled();
    await cityToken.locator('[data-readonly-allow]').click();
    await expect(cityToken).toHaveCount(0);
  });

  test('Attestify close and Proceed buttons produce their expected outcomes', async ({ mockApi: page }) => {
    await page.context().route(url => url.searchParams.has('eoaAddress') && url.searchParams.has('MY_NAME_IS'), route => route.fulfill({
      contentType: 'text/html', body: '<title>Attestify navigation boundary</title>',
    }));
    await injectMockEvmWallet(page, { chainIdHex: '0xaa36a7', walletKind: 'metamask' });
    await page.addInitScript(() => {
      const provider = (window as any).ethereum;
      if (!provider?.request) return;
      const request = provider.request.bind(provider);
      provider.request = async (args: any) => {
        if (args?.method === 'eth_getCode') return '0x6000';
        if (args?.method === 'eth_getBalance') return '0x0';
        if (args?.method === 'eth_blockNumber') return '0x1';
        if (args?.method === 'eth_getTransactionCount') return '0x0';
        if (args?.method === 'eth_gasPrice' || args?.method === 'eth_maxPriorityFeePerGas') return '0x1';
        if (args?.method === 'eth_estimateGas') return '0x5208';
        if (args?.method === 'eth_call') return '0x';
        return request(args);
      };
    });
    await openCity(page);
    await openWalletModal(page);
    await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="metamask"]`).click();
    const profile = await openProfile(page, 'Attestify actor');
    const attest = profile.locator('.wallet-attest-link');
    await attest.click();
    const explainer = page.locator('.attestify-overlay');
    await expect(explainer).toBeVisible();
    await explainer.locator('.attestify-close').click();
    await expect(explainer).toHaveCount(0);

    await attest.click();
    const popupPromise = page.context().waitForEvent('page');
    await Promise.all([
      explainer.locator('[data-attest-proceed]').click(),
      popupPromise.then(async popup => {
        await expect(popup).toHaveURL(url => url.searchParams.get('eoaAddress') === '0x1234567890abcdef1234567890abcdef12345678');
        expect(new URL(popup.url()).searchParams.get('MY_NAME_IS')).toBe('Attestify actor');
        await popup.close();
      }),
    ]);
    await expect(explainer).toHaveCount(0);
  });

  test('Solana chain options change the active cluster through the chain modal', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { providerName: 'phantom' });
    await openCity(page);
    await openWalletModal(page);
    await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="solana-phantom"]`).click();
    await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);
    const profile = await openProfile(page, 'Solana selector actor');
    const network = profile.locator('.wallet-chain-info');
    await network.click();
    const chainModal = page.locator('.chain-modal-overlay');
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-id="solana-mainnet-beta"]').click();
    await expect.poll(async () => (await getWalletStates(page)).solana?.cluster).toBe('mainnet-beta');
  });

  test('activity row scope buttons filter the explorer, Clear scope resets it, and a row opens its agreement', async ({ mockApi: page }) => {
    const queries: URLSearchParams[] = [];
    await page.route('**/agent/activity**', route => {
      queries.push(new URL(route.request().url()).searchParams);
      return json(route, { events: [SCOPED_EVENT, OTHER_EVENT] });
    });
    await openCity(page);
    // This device proposed the scoped agreement, so its row opens the local copy's panel.
    const localId = await page.evaluate(cid => {
      const w = window as any;
      return String(w.AgreementStore.save({
        schema: 'agreement/v1', id: w.AgreementRecord.newId(), title: 'Scoped park agreement', city: 'zagreb',
        createdAt: '2026-10-01T11:00:00.000Z', designs: [{ proposalId: 'scoped-park', title: 'Scoped park', goal: 'park', cid: null }],
        inputs: { parcels: [], openGroundM2: 0 }, outputs: [], rule: { electorate: 'community', binding: false },
        published: { cid, publishedAt: '2026-10-01T11:00:00.000Z', apiBase: w.DesignSync.apiBase(), sponsor: null },
      }).id);
    }, SCOPED_AGREEMENT);
    await page.locator('#activity-button').click();
    await page.locator('#activity-explorer-button').click();
    const modal = page.locator('.game-log-modal');
    const content = modal.locator('#game-log-content');
    await expect(content.locator('.log-entry')).toHaveCount(2);
    const scopedRow = content.locator('.log-entry').filter({ hasText: 'scoped park agreement' });
    const scope = modal.locator('[data-activity-scope-chip]');

    await scopedRow.locator('details > summary').click();
    await scopedRow.locator('[data-activity-scope="actorId"]').click();
    await expect(scope).toBeVisible();
    await expect(scope).toContainText('Actor: scope-actor');
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await expect(content).toContainText('Proposed the scoped park agreement');
    await expect(content).not.toContainText('unrelated block agreement');
    await modal.locator('[aria-label="Clear scope"]').click();
    await expect(scope).toBeHidden();
    await expect(content.locator('.log-entry')).toHaveCount(2);

    // The agreement scope asks the server for that agreement's activity (?agreement=<cid>).
    await scopedRow.locator('details > summary').click();
    await scopedRow.locator('[data-activity-scope="agreementCid"]').click();
    await expect(scope).toBeVisible();
    await expect(scope).toContainText(`Agreement: ${shortCid(SCOPED_AGREEMENT)}`);
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await expect(content).toContainText('Proposed the scoped park agreement');
    await expect(content).not.toContainText('unrelated block agreement');
    expect(queries.some(query => query.get('agreement') === SCOPED_AGREEMENT)).toBe(true);
    await modal.locator('[aria-label="Clear scope"]').click();
    await expect(scope).toBeHidden();
    await expect(content.locator('.log-entry')).toHaveCount(2);

    await scopedRow.locator('details > summary').click();
    await scopedRow.locator('[data-activity-scope="runId"]').click();
    await expect(scope).toBeVisible();
    await expect(scope).toContainText('Run: scope-run-42');
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await expect(content).toContainText('Proposed the scoped park agreement');
    await expect(content).not.toContainText('unrelated block agreement');
    await modal.locator('[aria-label="Clear scope"]').click();
    await expect(scope).toBeHidden();
    await expect(content.locator('.log-entry')).toHaveCount(2);

    // Open agreement: the explorer closes and the agreement's panel takes the right dock.
    await scopedRow.locator(`.activity-entity-link[data-entity-type="agreement"][data-entity-id="${SCOPED_AGREEMENT}"]`).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('section#agreement-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#agreement-panel-title')).toHaveText('Scoped park agreement');
    expect(await page.evaluate(() => (window as any).AgreementPanel.current())).toBe(localId);
  });

  test('an ?activity=agreement:<cid> link opens the explorer scoped to that agreement, once', async ({ mockApi: page }) => {
    await stubBasemapTiles(page);
    await page.route('**/agent/activity**', route => json(route, { events: [SCOPED_EVENT, OTHER_EVENT] }));
    await page.goto(`/?city=zg&reduceMotion=1&activity=${encodeURIComponent(`agreement:${SCOPED_AGREEMENT}`)}`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    const modal = page.locator('.game-log-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await expect(modal.locator('[data-activity-scope-chip]')).toContainText(`Agreement: ${shortCid(SCOPED_AGREEMENT)}`);
    const content = modal.locator('#game-log-content');
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await expect(content).toContainText('Proposed the scoped park agreement');
    await expect(content).not.toContainText('unrelated block agreement');
    // Closing the explorer drops the link from the address, so a reload does not open it again.
    await modal.locator('.game-log-modal-close').click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => new URLSearchParams(location.search).has('activity'))).toBe(false);
  });

  test('country name buttons take the report to the matching city inventory', async ({ mockApi: page }) => {
    await page.goto('/parcel-coverage-report.html');
    for (const table of ['city-table', 'country-table', 'breakdown-table']) {
      const firstHeading = page.locator(`#${table} thead th`).first();
      await firstHeading.locator('button').click();
      await expect(firstHeading).not.toHaveAttribute('aria-sort', 'none');
    }
    const nationalSegment = page.locator('.bar-segment.national').first();
    await nationalSegment.click();
    await expect(page.locator('#country-category')).toHaveValue('national');

    const countries = page.locator('#country-table tbody');
    const croatia = countries.locator('tr').filter({ hasText: 'Croatia' });
    await expect(croatia).toHaveCount(1);
    await croatia.getByRole('button', { name: 'Croatia', exact: true }).click();

    await expect(page).toHaveURL(/#cities$/);
    await expect(page.locator('#city-country')).toHaveValue('HR');
    await expect(page.locator('#city-table tbody tr').first()).toContainText('Croatia');
  });

  test('transaction explorer Copy button places the selected signature on the clipboard', async ({ mockApi: page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route('**/transactions**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/transactions/watched')) return json(route, {
        watched: [{ address: 'wallet-one', label: 'agent wallet', kind: 'wallet' }],
        explorer: { tx: 'https://explorer.solana.com/tx/{sig}?cluster=devnet', address: 'https://explorer.solana.com/address/{addr}?cluster=devnet' },
      });
      return json(route, { cluster: 'devnet', fetchedAt: '2026-10-01T12:00:00Z', cached: false, count: 2, transactions: [
        {
          signature: 'sig-copy-target', time: '2026-10-01T12:00:00Z', status: 'success', summary: 'Create proposal',
          feePayer: { address: 'wallet-one', label: 'agent wallet' }, feeSol: '0.00001', programs: ['proposal-market'],
          actions: ['createMarket'], amounts: [], instructions: [],
        },
        {
          signature: 'sig-other', time: '2026-10-01T11:00:00Z', status: 'success', summary: 'Token transfer',
          feePayer: { address: 'wallet-one', label: 'agent wallet' }, feeSol: '0.00001', programs: ['spl-token'],
          actions: ['transfer'], amounts: [], instructions: [],
        },
      ] });
    });

    await page.goto('/tx-explorer.html');
    const copy = page.locator('.tx-copy[data-copy="sig-copy-target"]');
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(copy).toHaveClass(/is-copied/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('sig-copy-target');

    const program = page.locator('button[data-facet="programs"][data-value="proposal-market"]');
    await program.click();
    await expect(program).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tx-tbody .tx-row')).toHaveCount(1);
    const transfer = page.locator('button[data-facet="actions"][data-value="transfer"]');
    await transfer.click();
    await expect(page.locator('#tx-tbody .tx-row')).toHaveCount(0);
    await transfer.click();
    await expect(page.locator('#tx-tbody .tx-row')).toHaveCount(1);
    await program.click();
    await expect(page.locator('#tx-tbody .tx-row')).toHaveCount(2);
  });



  test.describe('Controls with slow map bootstrap @core', () => {
    test.describe.configure({ timeout: 60_000 });

    test('welcome Close, No, and Yes controls dismiss or take over the selected agent', async ({ mockApi: page }) => {
      await openCity(page);
      const display = page.locator('#username-display');
      await expect.poll(() => page.evaluate(() => (window as any).getCurrentUserAgent?.()?.id || null)).toBeTruthy();
      const guestId = await page.evaluate(() => (window as any).getCurrentUserAgent?.()?.id || null);
      expect(guestId).toBeTruthy();
      await display.click();
      const welcome = page.locator('#welcome-modal');
      await expect(welcome).toBeVisible();
      await page.locator('#welcome-close-btn').click();
      await expect(welcome).toBeHidden();
      expect(await page.evaluate(() => (window as any).getCurrentUserAgent?.()?.id || null)).toBe(guestId);

      await display.click();
      await expect(welcome).toBeVisible();
      await page.evaluate(() => {
        (window as any).agentStorage.addAgent({
          id: 'ui-takeover-target', name: 'Takeover Target', avatarIndex: 15,
          isGuest: false, userControlled: false, aiControlled: true, controller: 'algorithm',
          ethBalance: 100, walletAddresses: [], ownedParcels: [], proposalsCreated: [], proposalsExecuted: [],
        });
      });
      const target = await page.evaluate(() => {
        const agent = (window as any).agentStorage.getAllAgents().find((item: any) => !item.isGuest && !item.userControlled);
        return agent ? { id: agent.id, name: agent.name } : null;
      });
      expect(target).not.toBeNull();
      const username = page.locator('#username-input');
      await username.fill(target!.name);
      const takeover = page.locator('#takeover-section');
      await expect(takeover).toBeVisible();
      await takeover.locator('[data-takeover-agent]').click();
      const profile = page.locator('.agent-dialog-modal');
      await expect(profile).toBeVisible();
      await expect(profile.locator('#agent-dialog-title')).toHaveText(target!.name);
      expect(await page.evaluate(() => (window as any).getCurrentUserAgent?.()?.id || null)).toBe(guestId);
      await profile.locator('.agent-dialog-modal-close').click();
      await expect(profile).toHaveCount(0);
      await expect(welcome).toBeVisible();
      await expect(username).toBeFocused();
      await page.locator('#takeover-no-btn').click();
      await expect(takeover).toBeHidden();
      await expect(username).toHaveValue('');
      expect(await page.evaluate(() => (window as any).getCurrentUserAgent?.()?.id || null)).toBe(guestId);
      expect(await page.evaluate(id => (window as any).agentStorage.getAgent(id).userControlled, target!.id)).toBe(false);

      await username.fill(target!.name);
      await expect(takeover).toBeVisible();
      await page.locator('#takeover-yes-btn').click();
      await expect(welcome).toBeHidden();
      await expect(page.locator('#username-text')).toHaveText(target!.name);
      expect(await page.evaluate(() => (window as any).getCurrentUserAgent?.()?.id || null)).toBe(target!.id);
      expect(await page.evaluate(id => (window as any).agentStorage.getAgent(id).userControlled, target!.id)).toBe(true);
    });
  });

});
