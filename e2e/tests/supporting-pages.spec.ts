import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';

const json = (route: any, body: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({
  status,
  contentType: 'application/json',
  headers,
  body: JSON.stringify(body),
});

test.describe('Supporting pages @core', () => {
  test('actor explorer filters activity and opens run provenance', async ({ mockApi: page }) => {
    const events = [
      {
        id: 'activity-human', occurredAt: '2026-09-30T12:00:00Z', recordedAt: '2026-09-30T12:00:00Z',
        actor: { id: 'human-1', name: 'Ari', kind: 'human', controller: 'human' },
        action: { type: 'publish' }, entity: { type: 'proposal', id: 'proposal-1' },
        source: 'proposal', message: 'Published the park plan', ok: true,
      },
      {
        id: 'activity-agent', occurredAt: '2026-09-30T11:00:00Z', recordedAt: '2026-09-30T11:00:00Z',
        actor: { id: 'agent-1', name: 'Block planner', kind: 'agent', controller: 'algorithm' },
        action: { type: 'create' }, entity: { type: 'proposal', id: 'proposal-2' },
        source: 'agent', message: 'Created a square proposal', runId: 'run-1', rationale: 'Preserve open space', ok: true,
      },
    ];
    await page.route('**/agent/activity**', route => json(route, { events }));
    await page.route('**/agent/runs/run-1', route => json(route, {
      run: { id: 'run-1', persona: 'Block planner', status: 'done', stage: 'propose', model: 'test-model', costs: [{ item: 'planning', model: 'test-model', usd: 0.02 }], picks: [{ name: 'Square', proposalId: 'proposal-2', rationale: 'Preserve open space' }] },
    }));

    await page.goto('/actor-explorer.html');
    await expect(page.locator('.ae-event')).toHaveCount(2);
    await selectNativeOption(page.getByRole('combobox', { name: 'Actor controller' }), 'human');
    await expect(page.locator('.ae-event')).toHaveCount(1);
    await expect(page.locator('.ae-event')).toContainText('Ari');
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await page.getByRole('button', { name: /run run-1/ }).click();
    await expect(page.locator('.ae-run-detail')).toContainText('Preserve open space');
  });

  test('transaction explorer filters stored transactions and refreshes its database read', async ({ mockApi: page }) => {
    const calls: string[] = [];
    const payload = {
      cluster: 'devnet', fetchedAt: '2026-09-30T12:00:00Z', cached: false,
      explorer: { tx: 'https://explorer.solana.com/tx/{sig}?cluster=devnet', address: 'https://explorer.solana.com/address/{addr}?cluster=devnet' },
      watched: [{ address: 'wallet-one', label: 'agent wallet', kind: 'wallet' }], count: 2,
      transactions: [
        { signature: 'sig-alpha', time: '2026-09-30T12:00:00Z', status: 'success', summary: 'Alpha payment', feePayer: { address: 'wallet-one', label: 'agent wallet' }, feeSol: '0.00001', programs: ['spl-token'], actions: ['transfer'], amounts: [], instructions: [] },
        { signature: 'sig-beta', time: '2026-09-30T11:00:00Z', status: 'failed', summary: 'Beta market call', feePayer: { address: 'wallet-one', label: 'agent wallet' }, feeSol: '0.00002', programs: ['proposal-market'], actions: ['createMarket'], amounts: [], instructions: [] },
      ],
    };
    await page.route('**/transactions**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      calls.push(`${request.method()} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/transactions/watched')) return json(route, { watched: payload.watched, explorer: payload.explorer });
      return json(route, payload);
    });

    await page.goto('/tx-explorer.html');
    await expect(page.locator('#tx-tbody tr')).toHaveCount(2);
    await page.locator('#tx-search').fill('Alpha');
    await expect(page.locator('#tx-tbody tr')).toHaveCount(1);
    await expect(page.locator('#tx-tbody')).toContainText('sig-alpha');
    await page.locator('#tx-filter-clear').click();
    const listReadsBeforeRefresh = calls.filter(call => call.startsWith('GET /transactions?limit=25')).length;
    await page.locator('#tx-refresh').click();
    await expect.poll(() => calls.filter(call => call.startsWith('GET /transactions?limit=25')).length)
      .toBeGreaterThan(listReadsBeforeRefresh);
    expect(calls.some(call => call.startsWith('POST /transactions/sync'))).toBe(false);
  });

  test('Lens console reads a member service and filters its attestation list', async ({ mockApi: page }) => {
    const attestationRequests: string[] = [];
    const memberKey = '11111111111111111111111111111111';
    await page.route('**/lenses/members', route => json(route, {
      members: [{ key: memberKey, name: 'Test Lens', serviceUrl: 'http://lens-member.test' }],
    }));
    await page.route('**/lens/status', route => json(route, {
      key: memberKey, kind: 'notary', identity: 'verified', credential: 'active', counts: { ownership: 2 },
      pricing: { ownership: { enabled: true, priceUsdc: 0.05, network: 'devnet' } },
    }, 200, { 'access-control-allow-origin': '*' }));
    await page.route('**/lens/attestations**', async route => {
      const url = new URL(route.request().url());
      attestationRequests.push(url.search);
      const all = [
        { address: 'attestation-one', kind: 'ownership', authority: memberKey, parcelUid: 'parcel-1', owner: 'owner-1', issuedAt: '2026-09-30T12:00:00Z' },
        { address: 'attestation-two', kind: 'verdict', authority: memberKey, proposalAccount: memberKey, payload: { verdict: 'executed' }, issuedAt: '2026-09-30T11:00:00Z' },
      ];
      const kind = url.searchParams.get('kind');
      const parcel = url.searchParams.get('parcelUid');
      return json(route, { attestations: all.filter(item => (!kind || item.kind === kind) && (!parcel || item.parcelUid === parcel)) }, 200, { 'access-control-allow-origin': '*' });
    });

    await page.goto('/lens.html');
    await page.locator('#lc-service-url').fill('http://lens-member.test');
    await page.locator('#lc-service-load').click();
    await expect(page.locator('#lc-directory')).toContainText('Test Lens');
    await expect(page.locator('#lc-status')).toContainText('notary');
    await expect(page.locator('#lc-attestations .lc-item')).toHaveCount(2);
    await selectNativeOption(page.locator('#lc-filter-kind'), 'ownership');
    await page.locator('#lc-filter-parcel').fill('parcel-1');
    await page.locator('#lc-attestations-load').click();
    await expect(page.locator('#lc-attestations .lc-item')).toHaveCount(1);
    await expect(page.locator('#lc-attestations')).toContainText('parcel-1');
    expect(attestationRequests.some(query => query.includes('kind=ownership') && query.includes('parcelUid=parcel-1'))).toBe(true);

    await page.locator('#lc-wallet-connect').click();
    await expect(page.locator('#lc-wallet')).toContainText('No Solana wallet found');
    let verdictRequest: { body: unknown; token: string | undefined } | null = null;
    await page.route('**/lens/verdict', async route => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-lens-operator-token',
        } });
      }
      verdictRequest = {
        body: route.request().postDataJSON(),
        token: route.request().headers()['x-lens-operator-token'],
      };
      return json(route, { address: 'verdict-account', accountHash: 'hash-1', reused: false }, 200, { 'access-control-allow-origin': '*' });
    });
    await page.locator('#lc-verdict-proposal').fill(memberKey);
    await selectNativeOption(page.locator('#lc-verdict-kind'), 'executed');
    await page.locator('#lc-verdict-evidence').fill('https://records.example/case-1');
    await page.locator('#lc-verdict-observed').fill('2026-09-30T12:00');
    await page.locator('#lc-verdict-token').fill('operator-token-for-test');
    const observedAtSeconds = await page.evaluate(() => Math.floor(new Date('2026-09-30T12:00').getTime() / 1000));
    await page.locator('#lc-verdict-submit').click();
    await expect(page.locator('#lc-verdict-result')).toContainText('Verdict attested');
    expect(verdictRequest).toEqual({
      token: 'operator-token-for-test',
      body: {
        proposalAccount: memberKey, verdict: 'executed',
        evidenceRef: 'https://records.example/case-1', sourceObservedAt: observedAtSeconds,
      },
    });
    await expect(page.locator('#lc-verdict-token')).toHaveValue('');
  });

  test('Canton explorer creates a demo party and moves an accepted proposal into sales', async ({ mockApi: page }) => {
    const owner = 'Owner::participant-fingerprint';
    let accepted = false;
    const calls: string[] = [];
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route('**/parcel-nyc**', route => json(route, {
      type: 'FeatureCollection', features: [{ type: 'Feature', properties: { parcelId: 'PARCEL-NYC-1', estimatedMarketPrice: 125000 }, geometry: { type: 'Polygon', coordinates: [] } }],
    }));
    // canton.html resolves its API base independently from the app shell. Intercept fetch/XHR
    // requests at the data boundary and match their actual endpoint pathname, regardless of host.
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return route.continue();
      if (!url.pathname.includes('/canton/')) return route.continue();
      calls.push(`${request.method()} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith('/canton/parties') && request.method() === 'POST') return json(route, { party: owner });
      if (url.pathname.includes('/canton/ccview/')) return json(route, { indexed: false, explorerUrl: 'https://ccview.example/party/owner' });
      if (url.pathname.endsWith('/canton/proposals') && request.method() === 'GET') {
        return json(route, { proposals: accepted ? [] : [{ parcelId: 'PARCEL-NYC-1', buyer: 'Buyer::fp', owner, lens: 'Lens::fp', price: '125000', contractId: 'contract-1' }] });
      }
      if (url.pathname.endsWith('/canton/sales')) return json(route, { sales: accepted ? [{ parcelId: 'PARCEL-NYC-1', buyer: 'Buyer::fp', owner, lens: 'Lens::fp', price: '125000', contractId: 'contract-1' }] : [] });
      if (url.pathname.endsWith('/canton/proposals/contract-1/accept') && request.method() === 'POST') {
        accepted = true;
        return json(route, { accepted: true });
      }
      return json(route, { error: 'Unexpected Canton API request' }, 404);
    });

    await page.goto('/canton.html');
    const partyResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && /\/canton\/parties\/?$/.test(new URL(response.url()).pathname));
    await page.locator('#gen-party-btn').click();
    expect((await partyResponse).ok()).toBe(true);
    // The party ID is intentionally abbreviated in the visible row; its full value stays in the
    // ID span's title and the copy button's data-copy attribute.
    const partyRow = page.locator('.canton-party-row').filter({
      has: page.locator(`.canton-party-id[title="${owner}"]`),
    });
    await expect(partyRow).toHaveCount(1);
    await partyRow.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.locator('#canton-status')).toContainText('Copied party id: Owner');
    await partyRow.getByRole('button', { name: 'CCView', exact: true }).click();
    await expect(partyRow.locator('.canton-ccview-out')).toContainText('Not yet indexed on CCView');
    await expect(partyRow.locator('.canton-ccview-out a')).toHaveAttribute('href', 'https://ccview.example/party/owner');
    await partyRow.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.locator('#canton-party')).toHaveValue(owner);
    await expect(page.locator('.canton-card')).toHaveCount(1);
    await partyRow.getByRole('button', { name: 'Forget', exact: true }).click();
    await expect(page.locator('.canton-party-row')).toHaveCount(0);
    // Entering an existing party and pressing Load remains a separate supported action.
    await page.locator('#canton-party').fill(owner);
    await page.locator('#canton-load').click();
    await expect(page.locator('.canton-card')).toHaveCount(1);
    await page.locator('.canton-accept').click();
    await expect(page.locator('#canton-sales .canton-card')).toHaveCount(1);
    await expect(page.locator('#canton-proposals')).toContainText('No proposals.');
    expect(calls.some(call => call.startsWith('POST /canton/proposals/contract-1/accept'))).toBe(true);
  });

  test('Canton Create proposal and Clear parties actions update their real page state', async ({ mockApi: page }) => {
    let created: any = null;
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return route.continue();
      if (url.pathname.includes('/parcel-nyc')) {
        return json(route, { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { parcelId: 'PARCEL-NYC-1', estimatedMarketPrice: 125000 }, geometry: { type: 'Polygon', coordinates: [] } }] });
      }
      if (!url.pathname.includes('/canton/')) return route.continue();
      if (url.pathname.endsWith('/canton/parties') && request.method() === 'POST') return json(route, { party: 'Stranger::fp' });
      if (url.pathname.endsWith('/canton/proposals') && request.method() === 'POST') {
        created = request.postDataJSON();
        return json(route, { proposalContractId: 'created-contract', parcelId: 'PARCEL-NYC-1', buyer: 'Buyer::fp', owner: 'Owner::fp', lens: 'Lens::fp' });
      }
      if (url.pathname.endsWith('/canton/proposals') && request.method() === 'GET') {
        return json(route, { proposals: [{ parcelId: 'PARCEL-NYC-1', buyer: 'Buyer::fp', owner: 'Owner::fp', lens: 'Lens::fp', price: '125000', contractId: 'created-contract' }] });
      }
      if (url.pathname.endsWith('/canton/sales')) return json(route, { sales: [] });
      return json(route, { error: `Unexpected Canton request: ${request.method()} ${url.pathname}` }, 404);
    });

    await page.goto('/canton.html');
    await expect(page.locator('#create-parcel')).toHaveValue('PARCEL-NYC-1');
    await page.locator('#create-price').fill('125000');
    await page.locator('#create-btn').click();
    await expect(page.locator('#create-result')).toContainText('Created created-contract');
    await expect(page.locator('#canton-proposals .canton-card')).toHaveCount(1);
    expect(created).toMatchObject({ parcelId: 'PARCEL-NYC-1', price: '125000' });
    await expect(page.locator('.canton-party-row')).toHaveCount(3);

    const perspective = page.locator('#canton-perspective');
    for (const role of ['Buyer', 'Owner', 'Lens']) {
      const option = perspective.getByRole('button', { name: role });
      await option.click();
      await expect(page.locator('#canton-party')).toHaveValue(`${role}::fp`);
      await expect(option).toHaveAttribute('aria-pressed', 'true');
    }
    const stranger = perspective.getByRole('button', { name: 'Stranger' });
    await stranger.click();
    await expect(page.locator('#canton-party')).toHaveValue('Stranger::fp');
    await expect(stranger).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#clear-parties-btn').click();
    await expect(page.locator('.canton-party-row')).toHaveCount(0);
    await expect(page.locator('#canton-parties-list')).toContainText('No test parties yet');
  });

  test('pitch deck advances through its real slide controls and roadmap links reach each horizon', async ({ mockApi: page }) => {
    await page.route('**/docs/agents.json', route => json(route, { x402: { priceProposal: '0.05 USDC' } }));
    await page.route('**/oracle/public-records/summary', route => json(route, { attestations: 3, v2: { attestations: 2 } }));
    await page.route('**/hackathon/proof.json', route => json(route, { hackathonPrograms: ['program-1'] }));
    await page.route('**/oracle/markets/prospective/status', route => json(route, { state: 'open', market: 'market-1' }));

    for (const deck of ['/deck.html', '/deck2.html', '/deck3.html']) {
      await page.goto(deck);
      await page.locator('#deck-next').click();
      await expect(page.locator('#deck-current')).toHaveText('2');
      await expect(page).toHaveURL(/#slide-2$/);
      await page.locator('#deck-prev').click();
      await expect(page.locator('#deck-current')).toHaveText('1');
      await expect(page).toHaveURL(/#slide-1$/);
      await page.locator('#deck-fullscreen').click();
      await expect(page.locator('#deck-fullscreen')).toHaveText('Exit');
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      await page.locator('#deck-fullscreen').click();
      await expect(page.locator('#deck-fullscreen')).toHaveText('Present');
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    }
    await page.goto('/deck.html');
    await page.keyboard.press('End');
    await expect(page.locator('#deck-current')).toHaveText('7');
    await page.goto('/roadmap.html');
    for (const horizon of ['now', 'next', 'later']) {
      await page.locator(`.sidebar-links a[href="#${horizon}"]`).click();
      await expect(page).toHaveURL(new RegExp(`#${horizon}$`));
      await expect(page.locator(`#${horizon}`)).toBeInViewport();
    }
    await page.goto('/how-to-use.html');
    await page.locator('.sidebar-links a[href="#sharing"]').click();
    await expect(page).toHaveURL(/#sharing$/);
    await expect(page.locator('#sharing')).toBeInViewport();
  });

  test('floor plan archive tabs and plan navigation update the selected view', async ({ mockApi: page }) => {
    await page.route('**/floor-plan-archive/catalogue', route => json(route, {
      buildings: [{ id: 'sample-building', name: 'Sample Building', kind: 'units', planCount: 2 }], sources: [],
    }));
    await page.route('**/floor-plan-archive/status', route => json(route, { coverage: { agencies: { total: 1, websites: 1 } } }));
    await page.route('**/floor-plan-archive/agencies?*', route => json(route, { agencies: [{ legal_name: 'Sample Agency', registered_address: 'Zagreb', website: 'https://agency.example' }] }));
    await page.route('**/floor-plan-archive/building/sample-building', route => json(route, {
      name: 'Sample Building', kind: 'units', location: null,
      plans: [{ id: 'plan-one', label: 'Plan One' }, { id: 'plan-two', label: 'Plan Two' }],
    }));

    await page.goto('/floor-plan-archive.html?building=sample-building');
    await expect(page.locator('#selection-name')).toHaveText('Sample Building');
    await expect(page.locator('#unit')).toHaveValue('0');
    await page.locator('#next').click();
    await expect(page.locator('#unit')).toHaveValue('1');
    await expect(page.locator('#unit option:checked')).toHaveText('Plan Two');
    await expect(page.locator('#previous')).toBeEnabled();
    await expect(page.locator('#next')).toBeDisabled();
    await page.locator('#previous').click();
    await expect(page.locator('#unit')).toHaveValue('0');
    await expect(page.locator('#unit option:checked')).toHaveText('Plan One');

    await page.locator('#tab-agencies').click();
    await expect(page.locator('#tab-agencies')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-agencies')).toBeVisible();
    await expect(page.locator('#agencies')).toContainText('Sample Agency');
    await page.locator('#tab-buildings').click();
    await expect(page.locator('#tab-buildings')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panel-buildings')).toBeVisible();
  });

  test('coverage report Print report invokes the browser print action', async ({ mockApi: page }) => {
    await page.addInitScript(() => {
      (window as any).__printCalls = 0;
      window.print = () => { (window as any).__printCalls += 1; };
    });
    await page.goto('/parcel-coverage-report.html');
    await page.locator('#print-report').click();
    await expect.poll(() => page.evaluate(() => (window as any).__printCalls)).toBe(1);
  });

  test('hackathon demo renders live evidence results and retries the data reads', async ({ mockApi: page }) => {
    const calls = new Map<string, number>();
    const bodies: Record<string, unknown> = {
      '/agent/runs': { runs: [] },
      '/agent/activity': { events: [] },
      '/docs/agents.json': { x402: { priceProposal: '0.05 USDC' }, mcp: { tools: [] } },
      '/agent/discovery': { state: 'listed' },
      '/oracle/events': { events: [] },
      '/oracle/public-records/summary': { attestations: 0, v2: { attestations: 0 } },
      '/oracle/markets/prospective/status': { state: 'open', market: 'market-1' },
      '/hackathon/proof.json': { publicProof: { canonicalCase: 'http://localhost:3000/hackathon/cases/test-case' } },
      '/hackathon/cases/test-case': { id: 'test-case', state: 'pending', proposal: { name: 'Evidence case' }, parcelSet: { parcelCount: 1 }, progress: { complete: 0, total: 3 }, activity: [] },
    };
    await page.route('**/agent/**', route => {
      const path = new URL(route.request().url()).pathname;
      calls.set(path, (calls.get(path) || 0) + 1);
      return json(route, bodies[path] || { runs: [], events: [] });
    });
    await page.route('**/docs/agents.json', route => {
      const path = new URL(route.request().url()).pathname;
      calls.set(path, (calls.get(path) || 0) + 1);
      return json(route, bodies[path]);
    });
    await page.route('**/oracle/**', route => {
      const path = new URL(route.request().url()).pathname;
      calls.set(path, (calls.get(path) || 0) + 1);
      return json(route, bodies[path] || { events: [] });
    });
    await page.route('**/hackathon/**', route => {
      const path = new URL(route.request().url()).pathname;
      calls.set(path, (calls.get(path) || 0) + 1);
      return json(route, bodies[path] || {});
    });

    await page.goto('/hackathon-demo.html');
    await expect(page.locator('#hackathon-demo')).toContainText('Running now');
    await expect(page.locator('#hackathon-demo')).toContainText('Two proposals, followed end to end');
    const beforeRetry = calls.get('/agent/activity') || 0;
    await page.getByRole('button', { name: 'Refresh live data' }).click();
    await expect.poll(() => calls.get('/agent/activity') || 0).toBeGreaterThan(beforeRetry);
    await expect(page.locator('#hackathon-demo')).toContainText('Running now');
  });
});
