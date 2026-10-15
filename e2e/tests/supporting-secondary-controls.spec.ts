// Verify secondary wallet, profile, activity, Canton, and supporting controls through real UI paths.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import { getWalletStates, injectMockEvmWallet, injectMockSolanaWallet, openWalletModal } from '../helpers/blockchain';
import { selectors } from '../helpers/selectors';

const json = (route: any, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

function routeCantonApi(page: import('@playwright/test').Page, handler: (route: any) => any) {
  return page.route('**/canton/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    // Canton frontend modules live under /js/canton/. Only stub API endpoints.
    if (pathname.includes('/js/canton/')) return route.continue();
    return handler(route);
  });
}

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

  test('activity row scope buttons filter the explorer and Clear scope resets it', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).proposalStorage.addProposal({
      proposalId: 'scope-proposal', title: 'Scoped park plan', goal: 'park', city: 'zagreb',
      cadastreParcelIds: ['HR-335754-1234'], parcelSet: { setHash: 'scope-land-hash', parcelIds: ['HR-335754-1234'] },
    }));
    const scopedEvent = {
      id: 'scoped-event', occurredAt: '2026-10-01T12:00:00Z', recordedAt: '2026-10-01T12:00:00Z',
      actor: { id: 'scope-actor', name: 'Map Steward', kind: 'agent', controller: 'algorithm' },
      action: { type: 'publish' }, entity: { type: 'proposal', id: 'scope-proposal' },
      source: 'agent', message: 'Published the scoped park plan', ok: true,
      runId: 'scope-run-42',
    };
    await page.route('**/agent/activity**', route => json(route, { events: [scopedEvent, {
      id: 'other-event', occurredAt: '2026-10-02T12:00:00Z', recordedAt: '2026-10-02T12:00:00Z',
      actor: { id: 'other-actor', name: 'Other Planner', kind: 'agent', controller: 'algorithm' },
      action: { type: 'publish' }, entity: { type: 'proposal', id: 'other-proposal' },
      source: 'agent', message: 'Published an unrelated block plan', ok: true, runId: 'other-run-99',
    }] }));
    await page.locator('#activity-button').click();
    await page.locator('#activity-explorer-button').click();
    const modal = page.locator('.game-log-modal');
    const content = modal.locator('#game-log-content');
    await expect(content.locator('.log-entry')).toHaveCount(2);
    const row = content.locator('.log-entry').filter({ hasText: 'scoped park plan' });
    await row.locator('details > summary').click();
    await row.locator('[data-activity-scope="actorId"]').click();
    const scope = modal.locator('[data-activity-scope-chip]');
    await expect(scope).toBeVisible();
    await expect(scope).toContainText('Actor: scope-actor');
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await expect(content).toContainText('Published the scoped park plan');
    await expect(content).not.toContainText('unrelated block plan');

    await modal.locator('[aria-label="Clear scope"]').click();
    await expect(scope).toBeHidden();
    await expect(content.locator('.log-entry')).toHaveCount(2);
    const scopedRow = content.locator('.log-entry').filter({ hasText: 'scoped park plan' });
    await scopedRow.locator('details > summary').click();
    await scopedRow.locator('[data-activity-scope="proposalId"]').click();
    await expect(scope).toBeVisible();
    await expect(scope).toContainText('Proposal: scope-proposal');
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await modal.locator('[aria-label="Clear scope"]').click();
    await expect(scope).toBeHidden();
    await expect(content.locator('.log-entry')).toHaveCount(2);

    const landRow = content.locator('.log-entry').filter({ hasText: 'scoped park plan' });
    await landRow.locator('details > summary').click();
    await landRow.locator('[data-activity-scope="parcelSetOf"]').click();
    await expect(scope).toBeVisible();
    // The UI intentionally truncates long parcel-set hashes in the visible chip.
    await expect(scope.locator('span')).toHaveText('Land: scope-land-ha…');
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await expect(content).toContainText('Published the scoped park plan');
    await expect(content).not.toContainText('unrelated block plan');
    await modal.locator('[aria-label="Clear scope"]').click();
    await expect(content.locator('.log-entry')).toHaveCount(2);

    const runRow = content.locator('.log-entry').filter({ hasText: 'scoped park plan' });
    await runRow.locator('details > summary').click();
    await runRow.locator('[data-activity-scope="runId"]').click();
    await expect(scope).toBeVisible();
    await expect(scope).toContainText('Run: scope-run-42');
    await expect(content.locator('.log-entry')).toHaveCount(1);
    await expect(content).toContainText('Published the scoped park plan');
    await expect(content).not.toContainText('unrelated block plan');
    await modal.locator('[aria-label="Clear scope"]').click();
    await expect(scope).toBeHidden();
    await expect(content.locator('.log-entry')).toHaveCount(2);
  });

  test('Canton identity Clear, switch-network, and Close actions keep their dialogs in sync', async ({ mockApi: page }) => {
    await page.addInitScript(() => {
      (window as any).CANTON_ENABLED = true;
      localStorage.setItem('canton.parties', JSON.stringify([{ party: 'Owner::fingerprint', role: 'owner', parcelId: '', ts: 1 }]));
    });
    await routeCantonApi(page, route => json(route, { counts: {}, proposals: [], sales: [] }));
    await openCity(page);
    const profile = await openProfile(page, 'Canton identity dialogs');
    const network = profile.locator('.wallet-chain-info');
    await network.click();
    const chainModal = page.locator('.chain-modal-overlay');
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-id="canton"]').click();
    const picker = page.locator('.canton-id-overlay');
    await expect(picker).toBeVisible();
    await picker.locator('[data-clear]').click();
    await expect(picker.locator('[data-list]')).toContainText('No parties yet');
    await picker.locator('[data-switch]').click();
    await expect(picker).toHaveCount(0);
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-modal-close]').click();
    await expect(chainModal).toHaveCount(0);

    await network.click();
    await expect(picker).toBeVisible();
    await picker.locator('[data-close]').click();
    await expect(picker).toHaveCount(0);
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

  test('floor-plan View in 3D toggles the plan mode and Reset view rebuilds its whole-building canvas', async ({ mockApi: page }) => {
    const rectangle = (x: number, y: number, width: number, depth: number) => [[
      [x, y], [x + width, y], [x + width, y + depth], [x, y + depth],
    ]];
    const architecture = {
      schema: 'consensus-builder.floor-architecture.v1', dimensionsM: [10, 10], wallHeightM: 2.7, slabThicknessM: 0.2,
      walls: [rectangle(0, 0, 1, 0.025)], slabs: [rectangle(0, 0, 1, 1)],
      landings: [], platforms: [], openings: [], stairs: [], railings: [],
    };
    const footprintCorners = [[16, 45.8], [16.0001, 45.8], [16.0001, 45.8001], [16, 45.8001]];
    const buildingFloorPlans = {
      schema: 'consensus-builder.building-floor-plans.v2',
      registration: { corners: footprintCorners, basis: 'UI test footprint', accuracy: 'test' },
      layouts: [{ id: 'layout-one', source: { url: 'https://example.org/plan.png', sha256: 'test-plan' }, architecture }],
      floors: [{ id: 'floor-one', level: 0, elevationM: 0, elevationBasis: 'documented', layoutId: 'layout-one' }],
    };
    await page.route('**/floor-plan-archive/catalogue', route => json(route, {
      buildings: [{ id: 'ui-building', name: 'UI Building', kind: 'units', planCount: 1 }], sources: [],
    }));
    await page.route('**/floor-plan-archive/status', route => json(route, { coverage: { agencies: { total: 1, websites: 1 } } }));
    await page.route('**/floor-plan-archive/agencies?*', route => json(route, { agencies: [] }));
    await page.route('**/floor-plan-archive/building/ui-building', route => json(route, {
      name: 'UI Building', kind: 'units', wholeBuilding: { type: 'floor-stack' },
      location: { latitude: 45.8, longitude: 16.0, basis: 'test footprint' },
      footprint: { type: 'Polygon', coordinates: [[[16, 45.8], [16.0001, 45.8], [16.0001, 45.8001], [16, 45.8001], [16, 45.8]]] },
      floorPlans: buildingFloorPlans,
      plans: [{ id: 'plan-one', label: 'Plan One', architecture, rooms: [] }],
    }));

    await page.goto('/floor-plan-archive.html?building=ui-building');
    const mode = page.locator('#view3d');
    await expect(mode).toBeEnabled();
    await expect(mode).toHaveText('3D view');
    await mode.click();
    await expect(mode).toHaveText('2D view');
    await mode.click();
    await expect(mode).toHaveText('3D view');

    const reset = page.locator('#show-building');
    await expect(reset).toBeEnabled();
    const canvas = page.locator('#building-3d canvas');
    await expect(canvas).toBeVisible();
    await canvas.evaluate(element => element.setAttribute('data-before-reset', 'true'));
    await reset.click();
    await expect(canvas).toBeVisible();
    await expect(canvas).not.toHaveAttribute('data-before-reset', 'true');
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
          ethBalance: 100, walletAddresses: [], ownedParcels: [], proposalsCreated: [], proposalsAccepted: [], proposalsExecuted: [],
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

    test('Canton explorer party chips, Load, Accept, and Close perform their visible actions', async ({ mockApi: page }) => {
      await page.addInitScript(() => {
        (window as any).CANTON_ENABLED = true;
        localStorage.setItem('canton.active', '1');
        localStorage.setItem('canton.party', 'Owner::fingerprint');
        localStorage.setItem('canton.parties', JSON.stringify([
          { party: 'Owner::fingerprint', role: 'owner', parcelId: '', ts: 1 },
          { party: 'Buyer::fingerprint', role: 'buyer', parcelId: '', ts: 2 },
        ]));
      });
      let accepted = false;
      let acceptRequest: { path: string; owner?: string } | null = null;
      await routeCantonApi(page, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname.endsWith('/canton/parcel-counts')) return json(route, { counts: {} });
        if (url.pathname.endsWith('/canton/proposals') && request.method() === 'GET') {
          const party = url.searchParams.get('party');
          return json(route, { proposals: party === 'Owner::fingerprint' && !accepted ? [
            { parcelId: 'PARCEL-1', buyer: 'Buyer::fingerprint', owner: 'Owner::fingerprint', lens: 'Lens::fingerprint', price: '125000', contractId: 'explorer-contract' },
          ] : [] });
        }
        if (url.pathname.endsWith('/canton/sales')) {
          const party = url.searchParams.get('party');
          return json(route, { sales: accepted && party === 'Owner::fingerprint' ? [
            { parcelId: 'PARCEL-1', buyer: 'Buyer::fingerprint', owner: 'Owner::fingerprint', lens: 'Lens::fingerprint', price: '125000', contractId: 'explorer-contract' },
          ] : [] });
        }
        if (url.pathname.endsWith('/canton/proposals/explorer-contract/accept') && request.method() === 'POST') {
          accepted = true;
          acceptRequest = { path: url.pathname, owner: request.postDataJSON()?.owner };
          return json(route, { accepted: true });
        }
        return json(route, {});
      });

      await openCity(page);
      await page.locator('#username-display').click();
      await expect(page.locator('#welcome-modal')).toBeVisible();
      await page.locator('#username-input').fill('Canton explorer actor');
      await page.locator('#welcome-submit-btn').click();
      await page.locator('#username-display').click();
      const profile = page.locator('.agent-dialog-modal');
      await expect(profile).toBeVisible();
      await profile.locator('.wallet-chain-info').click();
      const picker = page.locator('.canton-id-overlay');
      await expect(picker).toBeVisible();
      await picker.locator('[data-explorer]').click();

      const explorer = page.locator('.canton-explorer-overlay');
      await expect(explorer).toBeVisible();
      const status = explorer.locator('[data-status]');
      await expect(status).toContainText('1 proposal(s), 0 sale(s) — as Owner');
      await explorer.locator('[data-party="Buyer::fingerprint"]').click();
      await expect(status).toContainText('0 proposal(s), 0 sale(s) — as Buyer');
      await explorer.locator('[data-party="Owner::fingerprint"]').click();
      await expect(status).toContainText('1 proposal(s), 0 sale(s) — as Owner');
      await explorer.locator('#canton-explorer-party').fill('Owner::fingerprint');
      await explorer.locator('[data-load]').click();
      await expect(explorer.locator('.canton-explorer-accept')).toBeVisible();
      await explorer.locator('.canton-explorer-accept').click();
      await expect(status).toContainText('0 proposal(s), 1 sale(s) — as Owner');
      expect(accepted).toBe(true);
      expect(acceptRequest).toEqual({ path: '/canton/proposals/explorer-contract/accept', owner: 'Owner::fingerprint' });
      await explorer.locator('[data-close]').click();
      await expect(explorer).toHaveCount(0);
    });

    test('Canton parcel Accept updates the private proposal to a sale', async ({ mockApi: page }) => {
      await page.addInitScript(() => {
        (window as any).CANTON_ENABLED = true;
        localStorage.setItem('canton.parties', JSON.stringify([{ party: 'Owner::fingerprint', role: 'owner', parcelId: '', ts: 1 }]));
      });
      let accepted = false;
      const calls: string[] = [];
      let acceptRequest: { path: string; owner?: string } | null = null;
      await routeCantonApi(page, async route => {
        const request = route.request();
        const url = new URL(request.url());
        calls.push(`${request.method()} ${url.pathname}${url.search}`);
        if (url.pathname.endsWith('/canton/parcel-counts')) return json(route, { counts: { [PARCEL_ID]: 1 } });
        if (url.pathname.endsWith('/canton/proposals') && request.method() === 'GET') {
          return json(route, { proposals: accepted ? [] : [{ parcelId: PARCEL_ID, buyer: 'Buyer::fingerprint', owner: 'Owner::fingerprint', lens: 'Lens::fingerprint', price: '125000', contractId: 'panel-contract' }] });
        }
        if (url.pathname.endsWith('/canton/sales')) {
          return json(route, { sales: accepted ? [{ parcelId: PARCEL_ID, buyer: 'Buyer::fingerprint', owner: 'Owner::fingerprint', lens: 'Lens::fingerprint', price: '125000', contractId: 'panel-contract' }] : [] });
        }
        if (url.pathname.endsWith('/canton/proposals/panel-contract/accept') && request.method() === 'POST') {
          accepted = true;
          acceptRequest = { path: url.pathname, owner: request.postDataJSON()?.owner };
          return json(route, { accepted: true });
        }
        return json(route, {});
      });

      await openCity(page);
      const profile = await openProfile(page, 'Canton parcel actor');
      const network = profile.locator('.wallet-chain-info');
      await network.click();
      const chainModal = page.locator('.chain-modal-overlay');
      await expect(chainModal).toBeVisible();
      await chainModal.locator('[data-chain-id="canton"]').click();
      const picker = page.locator('.canton-id-overlay');
      await expect(picker).toBeVisible();
      await picker.locator('[data-party-select="Owner::fingerprint"]').click();
      await expect(network).toContainText('Canton · Owner');
      await profile.getByRole('button', { name: 'Close agent dialog' }).click();
      await openParcel(page, 'info', PARCEL_ID);
      await page.locator('#parcel-info-panel [data-parcel-tab-id="proposals-tab"]').click();
      await expect(page.locator('#proposals-tab')).toBeVisible();
      const canton = page.locator('#canton-proposals-content');
      await expect(canton.locator('.canton-panel-accept')).toBeVisible();
      await canton.locator('.canton-panel-accept').click();
      await expect(canton).toContainText('Accepted');
      await expect(canton.locator('.canton-panel-accept')).toHaveCount(0);
      expect(calls.some(call => call === 'POST /canton/proposals/panel-contract/accept')).toBe(true);
      expect(acceptRequest).toEqual({ path: '/canton/proposals/panel-contract/accept', owner: 'Owner::fingerprint' });
    });
  });

});
