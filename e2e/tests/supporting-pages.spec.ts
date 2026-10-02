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
    await page.getByRole('combobox', { name: 'Actor controller' }).selectOption('human');
    await expect(page.locator('.ae-event')).toHaveCount(1);
    await expect(page.locator('.ae-event')).toContainText('Ari');
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await page.getByRole('button', { name: /run run-1/ }).click();
    await expect(page.locator('.ae-run-detail')).toContainText('Preserve open space');
  });

  test('transaction explorer filters returned transactions and refreshes through the sync boundary', async ({ mockApi: page }) => {
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
      if (url.pathname.endsWith('/transactions/sync')) return json(route, { synced: 0, new: 0 });
      return json(route, payload);
    });

    await page.goto('/tx-explorer.html');
    await expect(page.locator('#tx-tbody tr')).toHaveCount(2);
    await page.locator('#tx-search').fill('Alpha');
    await expect(page.locator('#tx-tbody tr')).toHaveCount(1);
    await expect(page.locator('#tx-tbody')).toContainText('sig-alpha');
    await page.locator('#tx-filter-clear').click();
    await page.locator('#tx-refresh').click();
    await expect.poll(() => calls.some(call => call.startsWith('POST /transactions/sync'))).toBe(true);
    await expect.poll(() => calls.some(call => call.includes('/transactions?limit=25&sync=0'))).toBe(true);
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
    await page.locator('#lc-filter-kind').selectOption('ownership');
    await page.locator('#lc-filter-parcel').fill('parcel-1');
    await page.locator('#lc-attestations-load').click();
    await expect(page.locator('#lc-attestations .lc-item')).toHaveCount(1);
    await expect(page.locator('#lc-attestations')).toContainText('parcel-1');
    expect(attestationRequests.some(query => query.includes('kind=ownership') && query.includes('parcelUid=parcel-1'))).toBe(true);
  });

  test('Canton explorer creates a demo party and moves an accepted proposal into sales', async ({ mockApi: page }) => {
    const owner = 'Owner::participant-fingerprint';
    let accepted = false;
    const calls: string[] = [];
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
    // Generation remembers a test identity, but does not promise to activate that identity on the
    // explorer. Select it through the page's supported party input and Load control.
    await page.locator('#canton-party').fill(owner);
    await page.locator('#canton-load').click();
    await expect(page.locator('.canton-card')).toHaveCount(1);
    await page.locator('.canton-accept').click();
    await expect(page.locator('#canton-sales .canton-card')).toHaveCount(1);
    await expect(page.locator('#canton-proposals')).toContainText('No proposals.');
    expect(calls.some(call => call.startsWith('POST /canton/proposals/contract-1/accept'))).toBe(true);
  });

  test('pitch deck advances through its real slide controls and roadmap links reach each horizon', async ({ mockApi: page }) => {
    await page.route('**/docs/agents.json', route => json(route, { x402: { priceProposal: '0.05 USDC' } }));
    await page.route('**/oracle/public-records/summary', route => json(route, { attestations: 3, v2: { attestations: 2 } }));
    await page.route('**/hackathon/proof.json', route => json(route, { hackathonPrograms: ['program-1'] }));
    await page.route('**/oracle/markets/prospective/status', route => json(route, { state: 'open', market: 'market-1' }));

    await page.goto('/deck.html');
    await page.locator('#deck-next').click();
    await expect(page.locator('#deck-current')).toHaveText('2');
    await expect(page).toHaveURL(/#slide-2$/);
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
    await expect(page.locator('#hackathon-demo')).toContainText('Demo readiness and recovery');
    await expect(page.locator('#hackathon-demo')).toContainText('Evidence case');
    const beforeRetry = calls.get('/agent/activity') || 0;
    await page.getByRole('button', { name: 'Retry live evidence' }).click();
    await expect.poll(() => calls.get('/agent/activity') || 0).toBeGreaterThan(beforeRetry);
    await expect(page.locator('#hackathon-demo')).toContainText('Demo readiness and recovery');
  });
});
