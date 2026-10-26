// Purpose: the supporting pages from the screen (actor explorer, transaction explorer, lens console,
// decks, coverage report, hackathon demo): their reads, filters and actions against mocked services.
import { selectNativeOption } from '../helpers/controls';
import { test, expect } from '../helpers/fixtures';
import { cidOfObject } from '../helpers/mocks/shared-server';

// Agreements and designs are named by their CIDs (plan-design-agreement.md, M2/M3).
const AGREEMENT_CID = cidOfObject({ schema: 'agreement/v1', title: 'Supporting pages agreement' });
const OTHER_AGREEMENT_CID = cidOfObject({ schema: 'agreement/v1', title: 'An earlier agreement' });
const DESIGN_CID = cidOfObject({ schema: 'design/v1', title: 'Supporting pages square' });

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
        action: { type: 'propose', agreementCid: AGREEMENT_CID }, entity: { type: 'agreement', id: AGREEMENT_CID },
        source: 'live', message: 'Proposed the park agreement', ok: true,
      },
      {
        id: 'activity-agent', occurredAt: '2026-09-30T11:00:00Z', recordedAt: '2026-09-30T11:00:00Z',
        actor: { id: 'agent-1', name: 'Block planner', kind: 'agent', controller: 'algorithm' },
        action: { type: 'design', designCid: DESIGN_CID }, entity: { type: 'design', id: DESIGN_CID },
        source: 'live', message: 'Published a square design', runId: 'run-1', rationale: 'Preserve open space', ok: true,
      },
    ];
    await page.route('**/agent/activity**', route => json(route, { events }));
    await page.route('**/agent/runs/run-1', route => json(route, {
      run: { id: 'run-1', persona: 'Block planner', status: 'done', stage: 'propose', model: 'test-model', costs: [{ item: 'planning', model: 'test-model', usd: 0.02 }],
        picks: [{ name: 'Square', agreementCid: AGREEMENT_CID, designCid: DESIGN_CID, rationale: 'Preserve open space' }] },
    }));

    await page.goto('/actor-explorer.html');
    const profiles = page.locator('.ae-profile-grid .cb-option');
    const ari = profiles.filter({ hasText: 'Ari' });
    const planner = profiles.filter({ hasText: 'Block planner' });
    await expect(profiles).toHaveCount(2);
    await expect(page.locator('.ae-activity')).toContainText('Choose an actor to see its activity.');
    // The standalone page has no map to open them on: selecting each actor reveals its event subject.
    await expect(ari).toContainText('1 activity · 1 agreement · 0 transactions');
    await ari.click();
    const proposed = page.locator('.ae-event').filter({ hasText: 'Proposed the park agreement' });
    await expect(page.locator('.ae-event')).toHaveCount(1);
    await expect(proposed.locator('strong')).toHaveText('Ari · Proposed agreement');
    await expect(proposed.locator('.ae-meta')).toContainText(`Agreement ${AGREEMENT_CID.slice(0, 12)}…${AGREEMENT_CID.slice(-6)}`);

    await selectNativeOption(page.getByRole('combobox', { name: 'Actor controller' }), 'human');
    await expect(page.locator('.ae-activity')).toContainText('Choose an actor to see its activity.');
    await expect(profiles).toHaveCount(1);
    await profiles.filter({ hasText: 'Ari' }).click();
    await expect(page.locator('.ae-event')).toHaveCount(1);
    await expect(page.locator('.ae-event')).toContainText('Ari');

    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(profiles).toHaveCount(2);
    await planner.click();
    const designEvent = page.locator('.ae-event').filter({ hasText: 'Published a square design' });
    await expect(page.locator('.ae-event')).toHaveCount(1);
    await expect(designEvent.locator('.ae-meta')).toContainText(`Design ${DESIGN_CID.slice(0, 12)}…`);
    await page.getByRole('button', { name: 'Run run-1', exact: true }).click();
    const run = page.locator('.ae-run-detail');
    await expect(run).toContainText('Preserve open space');
    await expect(run).toContainText(`Agreement ${AGREEMENT_CID} · design ${DESIGN_CID}`);
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

  test('Lens console reads a member service, filters its attestations and attests the decision of an agreement', async ({ mockApi: page }) => {
    const attestationRequests: string[] = [];
    const memberKey = '11111111111111111111111111111111';
    const sponsor = 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W';
    const decisionOf = (agreementCid: string, address: string, issuedAt: string) => ({
      address, kind: 'decision', authority: memberKey, parcelUid: null, owner: null,
      payload: { agreementCid, sponsor, decision: 'satisfied', evidenceRef: 'sha256:fixture-receipts', sourceObservedAt: 1792500000 },
      accountHash: `hash-${address}`, expiry: 0, issuedAt,
    });
    // What the member has issued: an ownership fact and the decision of an earlier agreement; the
    // decision this test asks for joins them once the member issues it.
    const issued: any[] = [
      { address: 'attestation-one', kind: 'ownership', authority: memberKey, parcelUid: 'parcel-1', owner: 'owner-1', issuedAt: '2026-09-30T12:00:00Z' },
      decisionOf(OTHER_AGREEMENT_CID, 'attestation-earlier-decision', '2026-10-20T11:00:00Z'),
    ];
    await page.route('**/lenses/members', route => json(route, {
      members: [{ key: memberKey, name: 'Test Lens', serviceUrl: 'http://lens-member.test' }],
    }));
    await page.route('**/lens/status', route => json(route, {
      key: memberKey, kind: 'notary', identity: 'verified', credential: 'active', counts: { ownership: 1, decision: issued.length - 1 },
      pricing: { ownership: { enabled: true, priceUsdc: 0.05, network: 'devnet' } },
    }, 200, { 'access-control-allow-origin': '*' }));
    await page.route('**/lens/attestations**', async route => {
      const url = new URL(route.request().url());
      attestationRequests.push(url.search);
      const kind = url.searchParams.get('kind');
      const parcel = url.searchParams.get('parcelUid');
      return json(route, { attestations: issued.filter(item => (!kind || item.kind === kind) && (!parcel || item.parcelUid === parcel)) }, 200, { 'access-control-allow-origin': '*' });
    });
    let decisionRequest: { method: string; path: string; token: string | undefined; body: string | null } | null = null;
    await page.route('http://lens-member.test/lens/agreements/**', async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const url = new URL(request.url());
      decisionRequest = { method: request.method(), path: url.pathname, token: request.headers()['x-lens-operator-token'], body: request.postData() };
      const record = decisionOf(AGREEMENT_CID, 'attestation-new-decision', '2026-10-22T09:00:00Z');
      issued.push(record);
      return json(route, {
        ...record, credential: 'credential-fixture', schema: 'schema-fixture', transactionSignature: null, payment: null, reused: false,
        tally: { passed: true, ready: true, reason: null, acceptedOwners: 2, totalOwners: 2, acceptedAreaM2: 812.5, totalAreaM2: 812.5 }, counted: 2,
      }, 201, { 'access-control-allow-origin': '*' });
    });

    await page.goto('/lens.html');
    await page.locator('#lc-service-url').fill('http://lens-member.test');
    await page.locator('#lc-service-load').click();
    await expect(page.locator('#lc-directory')).toContainText('Test Lens');
    await expect(page.locator('#lc-status')).toContainText('notary');
    await expect(page.locator('#lc-attestations .lc-item')).toHaveCount(2);
    // The kinds a member issues: ownership, the decisions of agreements and market evidence.
    expect(await page.locator('#lc-filter-kind option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
      .toEqual(['', 'ownership', 'decision', 'evidence']);
    await selectNativeOption(page.locator('#lc-filter-kind'), 'ownership');
    await page.locator('#lc-filter-parcel').fill('parcel-1');
    await page.locator('#lc-attestations-load').click();
    await expect(page.locator('#lc-attestations .lc-item')).toHaveCount(1);
    await expect(page.locator('#lc-attestations')).toContainText('parcel-1');
    expect(attestationRequests.some(query => query.includes('kind=ownership') && query.includes('parcelUid=parcel-1'))).toBe(true);
    // An agreement's decision names the agreement and the decision.
    await selectNativeOption(page.locator('#lc-filter-kind'), 'decision');
    await page.locator('#lc-filter-parcel').fill('');
    await page.locator('#lc-attestations-load').click();
    const decisions = page.locator('#lc-attestations .lc-item');
    await expect(decisions).toHaveCount(1);
    await expect(decisions.first()).toContainText(OTHER_AGREEMENT_CID);
    await expect(decisions.first()).toContainText('Decision');
    await expect(decisions.first()).toContainText('satisfied');

    await page.locator('#lc-wallet-connect').click();
    await expect(page.locator('#lc-wallet')).toContainText('No Solana wallet found');

    // The operator asks the member for the decision of an agreement: the CID in the path, the token in
    // its header, no body (the member counts the relayed owner decisions itself).
    await page.locator('#lc-decision-cid').fill(AGREEMENT_CID);
    await page.locator('#lc-decision-token').fill('operator-token-for-test');
    await page.locator('#lc-decision-submit').click();
    const result = page.locator('#lc-decision-result');
    await expect(result).toHaveAttribute('data-outcome', 'issued', { timeout: 15_000 });
    await expect(result).toHaveAttribute('data-code', '');
    await expect(result).toContainText('Decision attested.');
    await expect(result.locator('a.cb-link--external')).toHaveText('attestation-new-decision');
    await expect(result).toContainText('Decision rule');
    await expect(result).toContainText('met');
    await expect(result).toContainText('2 of 2 accepted');
    await expect(result).toContainText('812.5 m² of 812.5 m²');
    await expect(result).toContainText('Owner decisions counted');
    expect(decisionRequest).toEqual({
      method: 'POST', path: `/lens/agreements/${AGREEMENT_CID}/decision`, token: 'operator-token-for-test', body: null,
    });
    // The token is never kept, and the issued decision is listed with the member's others.
    await expect(page.locator('#lc-decision-token')).toHaveValue('');
    await expect(decisions).toHaveCount(2);
    await expect(page.locator('#lc-attestations')).toContainText(AGREEMENT_CID);
  });

  test('pitch deck advances through its real slide controls and roadmap links reach each horizon', async ({ mockApi: page }) => {
    await page.route('**/docs/agents.json', route => json(route, { x402: { priceOracleFact: '0.05 USDC' } }));
    await page.route('**/oracle/public-records/summary', route => json(route, { attestations: 3, v2: { attestations: 2 } }));
    await page.route('**/hackathon/proof.json', route => json(route, { hackathonPrograms: ['program-1'] }));
    await page.route('**/oracle/markets/prospective/status', route => json(route, { state: 'open', market: 'market-1' }));
    // A smooth scroll is an animation the slide observer re-reads mid-flight (js/hackathon-deck.js), and
    // an agent's browser may not paint its frames: with reduced motion each control jumps, and its
    // end state is what is asserted.
    await page.emulateMedia({ reducedMotion: 'reduce' });

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
      '/docs/agents.json': { x402: { priceOracleFact: '0.05 USDC' }, mcp: { tools: [] } },
      '/agent/discovery': { state: 'listed' },
      '/oracle/events': { events: [] },
      '/oracle/public-records/summary': { attestations: 0, v2: { attestations: 0 } },
      '/oracle/markets/prospective/status': { state: 'open', market: 'market-1' },
      '/hackathon/proof.json': { publicProof: { canonicalCase: 'http://localhost:3000/hackathon/cases/test-case' } },
      '/hackathon/cases/test-case': { id: AGREEMENT_CID, state: 'pending', agreement: { name: 'Evidence case', status: 'active' }, parcelSet: { parcelCount: 1 }, progress: { complete: 0, total: 3 }, activity: [] },
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
    await expect(page.locator('#hackathon-demo')).toContainText('Two agreements, followed end to end');
    const evidenceCase = page.locator('.hd-case').filter({ hasText: 'Evidence case' });
    await expect(evidenceCase.locator('.hd-pill')).toHaveText('pending');
    await expect(page.locator('#judge-path')).not.toContainText('Every stage is recorded on Solana devnet.');
    await expect(page.locator('#hackathon-demo')).toContainText('Activity → Simulation');
    await expect(page.locator('#hackathon-demo')).not.toContainText('expand Game');
    // A case is an agreement: its card is named by it and every action deep-links into the explorer by its CID.
    // Its lifecycle is the agreement's status.
    await expect(evidenceCase).toContainText('active · 1 cadastral parcel · outcome proof incomplete');
    await expect(evidenceCase.getByRole('link', { name: 'Every action in the explorer' }))
      .toHaveAttribute('href', `/?activity=${encodeURIComponent(`agreement:${AGREEMENT_CID}`)}`);
    const beforeRetry = calls.get('/agent/activity') || 0;
    await page.getByRole('button', { name: 'Refresh live data' }).click();
    await expect.poll(() => calls.get('/agent/activity') || 0).toBeGreaterThan(beforeRetry);
    await expect(page.locator('#hackathon-demo')).toContainText('Running now');
  });
});
