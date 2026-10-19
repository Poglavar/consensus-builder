import { Browser, Page, Request } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { createSpace, openCity, showProposal, chooseTermsForShare } from '../helpers/runtime';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';

const SLUG = 'e2e-hung-ground-plan';
const LOAD_TIMEOUT_MS = 80;

async function delayParcelResponsesPastDeadline(
  page: Page,
  pattern: string | RegExp,
  matches: (request: Request) => boolean = request => {
    const url = new URL(request.url());
    return /\/parcels?(?:\/|$)/i.test(url.pathname)
      || url.pathname.includes('/parcel-sources/')
      || url.hostname === 'oss.uredjenazemlja.hr';
  }
): Promise<() => number> {
  let held = 0;
  await page.route(pattern, async route => {
    const request = route.request();
    if (!matches(request)) {
      await route.fallback();
      return;
    }
    if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') {
      await route.fallback();
      return;
    }
    held += 1;
    // Keep the intercepted response pending past the app's short test deadline. The browser
    // abort may be reported only after Playwright releases the route, so this bounded wait also
    // lets us observe the cancellation without leaving a route handler hanging after the test.
    await new Promise(resolve => setTimeout(resolve, 500));
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    } catch { /* The app's AbortSignal may already have cancelled the intercepted request. */ }
  });
  return () => held;
}

async function setLoadTimeout(page: Page): Promise<void> {
  await page.addInitScript(timeout => {
    (window as any).PARCEL_LOAD_TIMEOUT_MS = timeout;
  }, LOAD_TIMEOUT_MS);
}

async function routePlan(page: Page, serverId: string, city: string): Promise<void> {
  const plan = {
    slug: SLUG,
    name: `${SLUG}.proposals.urbangametheory.eth`,
    title: 'Hung ground plan',
    description: 'A park with its own saved geometry.',
    author: 'Timeout tester',
    place: 'Harbor',
    city,
    proposalRowIds: [serverId],
    memberCount: 1,
    superseded: false,
    proposalAccount: null,
    createdAt: '2026-10-19T10:00:00.000Z',
    supersededBy: [],
    members: [{ proposalRowId: serverId, authoredProposalId: 'p-timeout-park', title: 'Harbor park', type: 'park', goal: 'park', changed: false }]
  };
  await page.route(`**/plans/${SLUG}`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(plan) }));
}

async function createPlanReceiver(
  browser: Browser,
  baseURL: string | undefined,
  server: ReturnType<typeof createSharedProposalServer>,
  serverId: string,
  city: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(({ timeout, city }) => {
    (window as any).PARCEL_LOAD_TIMEOUT_MS = timeout;
    try {
      localStorage.setItem('cb_current_city', city);
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch { /* opaque origin */ }
  }, { timeout: LOAD_TIMEOUT_MS, city });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedProposalServer(page, server);
  await routePlan(page, serverId, city);
  return { page, close: () => context.close() };
}

async function publishPlan(page: Page) {
  const server = createSharedProposalServer();
  await attachSharedProposalServer(page, server);
  await page.route(/\/plans(\?.*)?$/, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plans: [] })
  }));
  await openCity(page);
  const city = await page.evaluate(() => String((window as any).CityConfigManager.getCurrentCityId()));
  await page.locator('#username-display').click();
  await page.locator('#username-input').fill('Timeout tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  const drawingId = await createSpace(page, 'park');
  await showProposal(page, drawingId);
  await page.locator('#proposal-details-panel .btn-share-proposal').click();
  await chooseTermsForShare(page);
  const share = page.locator('.share-modal-overlay');
  await share.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(share.locator('.share-modal-link').first()).toHaveValue(/\/proposals\/\d+\?/);
  const serverId = [...server.records.keys()][0];
  await page.evaluate(() => (window as any).hideProposalDetailsPanel(true));
  return { server, serverId, city };
}

test('a hung viewport parcel request opens the ground fallback and clears the fetch flag', async ({ mockApi: page }) => {
  await setLoadTimeout(page);
  const held = await delayParcelResponsesPastDeadline(page, '**/*');
  await page.goto('/?city=zg&reduceMotion=1', { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  await page.evaluate(() => {
    const w = window as any;
    void w.fetchParcelData(w.map.getBounds()).catch(() => {});
  });

  const dialog = page.locator('.ground-fallback-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.locator('[data-option="without-parcels"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any)._fetchParcelDataInProgress)).toBe(false);
  await expect.poll(() => held()).toBeGreaterThan(0);
});

test('a named plan survives Continue without parcels and applies its saved site geometry', async ({ browser, baseURL, mockApi: author }) => {
  const { server, serverId, city } = await publishPlan(author);
  expect(serverId).toBeTruthy();
  const published = server.records.get(serverId)!;
  const declaredIds = (published.cadastreParcelIds || []).map(String).sort();
  const siteGeometry = published.structureProposal?.geometry;
  expect(declaredIds.length).toBeGreaterThan(0);
  expect(siteGeometry).toBeTruthy();

  const receiver = await createPlanReceiver(browser, baseURL, server, serverId, city);
  try {
    const held = await delayParcelResponsesPastDeadline(receiver.page, '**/*');
    await receiver.page.goto(`/proposals/${SLUG}?city=zg&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
    await waitForMapReady(receiver.page);
    const dialog = receiver.page.locator('.ground-fallback-dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => held()).toBeGreaterThan(0);

    const pathname = await receiver.page.evaluate(() => location.pathname);
    await Promise.all([
      receiver.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      dialog.locator('[data-option="without-parcels"]').click()
    ]);
    await expect.poll(() => receiver.page.evaluate(() => location.pathname)).toBe(pathname);
    await expect.poll(() => receiver.page.evaluate(id => sessionStorage.getItem(`cb_without_parcels:${id}`), city)).toBe('1');
    await expect(receiver.page.locator('#plan-view-panel')).toBeVisible({ timeout: 15_000 });

    const apply = receiver.page.locator('#plan-view-panel [data-plan-action="apply"]');
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect.poll(() => receiver.page.evaluate(id => {
      const w = window as any;
      const member = w.proposalStorage.getAllProposals().find((proposal: any) => String(w.getServerProposalId(proposal)) === id);
      return member && w.isProposalCurrentlyApplied(member);
    }, serverId), { timeout: 30_000 }).toBe(true);

    const applied = await receiver.page.evaluate(id => {
      const w = window as any;
      const member = w.proposalStorage.getAllProposals().find((proposal: any) => String(w.getServerProposalId(proposal)) === id);
      return {
        declaredIds: (member?.cadastreParcelIds || []).map(String).sort(),
        geometry: member?.structureProposal?.geometry,
        cadastralFeatureCount: w.CadastralParcelRepository.snapshot().featureCount
      };
    }, serverId);
    expect(applied.declaredIds).toEqual(declaredIds);
    expect(applied.geometry).toEqual(siteGeometry);
    expect(applied.cadastralFeatureCount).toBe(0);
    expect(await receiver.page.evaluate(() => location.pathname)).toBe(pathname);
  } finally {
    await receiver.close();
  }
});

test('a named-plan metadata timeout releases deep-link parcel suppression and replaces the startup status', async ({ mockApi: page }) => {
  await setLoadTimeout(page);
  const held = await delayParcelResponsesPastDeadline(page, `**/plans/${SLUG}`, request => new URL(request.url()).pathname.endsWith(`/plans/${SLUG}`));
  await page.goto(`/proposals/${SLUG}?city=zg&reduceMotion=1`, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);

  await expect.poll(() => held()).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).skipParcelFetchUntilProposalLoaded)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any)._fetchParcelDataInProgress || false)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).statusLogEntries()
    .some((entry: any) => /linked plan or proposal could not be loaded/i.test(entry.message)))).toBe(true);
  await expect(page.locator('#plan-view-panel')).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.pathname)).toBe(`/proposals/${SLUG}`);
});
