// Worldwide publication and city routing (projections.md §3, §10 M8): a publish presents the
// server's signed preparation and its artifact, a site in another city's cadastre is refused by name,
// every proposal opens in its own city's store (a record without a city by its parcels), the address
// bar follows the map, and the read-only guard for a second tab applies per city.
import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, panMap } from '../helpers/app';
import { openCity, createSpace, showProposal } from '../helpers/runtime';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedProposalServer, createSharedProposalServer, SharedProposalServer } from '../helpers/mocks/shared-server';

async function personalizeProfile(page: Page, name: string): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill(name);
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.GuestPolicy.check('share', { isGuest: w.getCurrentUserAgent?.()?.isGuest }).allowed;
  })).toBe(true);
}

// A park authored in Zagreb through the real share dialog's Upload. Resolves the published record.
async function publishPark(page: Page, server: SharedProposalServer): Promise<Record<string, any>> {
  await openCity(page);
  await personalizeProfile(page, 'City author');
  const proposalId = await createSpace(page, 'park');
  await showProposal(page, proposalId);
  await page.locator('.btn-share-proposal').click();
  await page.locator('.share-modal-overlay').getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.locator('.share-modal-overlay .share-modal-link').first()).toHaveValue(/\/proposals\/\d+\?/);
  expect(server.records.size).toBe(1);
  return server.records.values().next().value as Record<string, any>;
}

// Another device whose stored city is New York, sharing the same proposal server.
async function deviceIn(browser: Browser, server: SharedProposalServer, cityId: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:8080' });
  await context.addInitScript((id) => {
    try {
      localStorage.setItem('cb_current_city', id);
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* opaque origin */ }
  }, cityId);
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedProposalServer(page, server);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}

// The "This proposal is in …" prompt a link from outside gets: answer "Open in <city>", then the
// page reloads into that city on the proposal's address.
async function followToCity(page: Page, cityId: string, cityLabel: string): Promise<void> {
  const dialog = page.locator('.city-switch-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText(cityLabel);
  await Promise.all([
    page.waitForURL(url => url.searchParams.get('city') === cityId, { timeout: 30_000 }),
    dialog.getByRole('button', { name: `Open in ${cityLabel}` }).click(),
  ]);
  await waitForMapReady(page);
}

async function storedIn(page: Page, proposalId: string): Promise<{ city: string; stored: boolean }> {
  return page.evaluate((id) => {
    const w = window as any;
    return {
      city: w.CityConfigManager.getCurrentCityId(),
      stored: w.proposalStorage.getAllProposals().some((p: any) => String(p.proposalId) === id),
    };
  }, proposalId);
}

test.describe('Worldwide publication and city routing @core', () => {
  test('a publish presents the signed preparation and the server keeps the artifact beside the record', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    const record = await publishPark(page, server);

    // prepared first, then published with what was prepared
    const posts = server.requests.filter(request => request.method === 'POST').map(request => request.path.replace(/.*\/proposals/, '/proposals'));
    expect(posts).toEqual(['/proposals/prepare', '/proposals']);
    expect(record.preparation).toMatchObject({ id: expect.stringMatching(/^prep_[0-9a-f]{32}$/), digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(record.preparation.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(record.preparation.preparedAt)).not.toBeNaN();
    // the artifact travels with the publish and is stored beside the record, never inside it
    expect(record).not.toHaveProperty('preparedArtifact');
    const issued = server.issued.get(record.preparation.id);
    expect(server.prepared.get(record.preparation.id)).toEqual(issued?.artifact);
    expect(record.city).toBe('zagreb');
  });

  test('a site in another city\'s cadastre is refused with a message naming that city', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    server.prepareRefusal = { status: 422, body: { code: 'site-in-other-city', siteCity: 'split', error: 'The site lies in split.' } };
    await attachSharedProposalServer(page, server);
    await openCity(page);
    await personalizeProfile(page, 'City author');
    const proposalId = await createSpace(page, 'park');
    await showProposal(page, proposalId);
    await page.locator('.btn-share-proposal').click();
    await page.locator('.share-modal-overlay').getByRole('button', { name: 'Upload', exact: true }).click();
    // the upload's failure toast says where the site belongs
    await expect(page.locator('#ephemeral-message-container')).toContainText('This site lies in Split', { timeout: 30_000 });
    expect(server.records.size).toBe(0);
    expect(server.requests.some(request => request.method === 'POST' && /\/proposals$/.test(request.path))).toBe(false);
  });

  test('a proposal opened in the wrong city asks, then opens in its own city; a record without a city goes by its parcels', async ({ mockApi: author, browser }) => {
    // one publish and two devices, each booting twice (the wrong city, then the right one)
    test.setTimeout(180_000);
    const server = createSharedProposalServer();
    await attachSharedProposalServer(author, server);
    const record = await publishPark(author, server);
    const publishedId = String(record.proposalId);

    // the feed/search route: ?focusProposal= in New York for a Zagreb proposal
    const first = await deviceIn(browser, server, 'new_york');
    try {
      await first.page.goto(`/?city=new_york&reduceMotion=1&focusProposal=${record.id}`);
      await followToCity(first.page, 'zagreb', 'Zagreb');
      expect(new URL(first.page.url()).searchParams.get('focusProposal')).toBe(String(record.id));
      await expect.poll(() => storedIn(first.page, publishedId), { timeout: 30_000 }).toEqual({ city: 'zagreb', stored: true });
      expect(first.errors).toEqual([]);
    } finally {
      await first.context.close();
    }

    // an old record that names no city: its Croatian parcels place it in a Croatian city
    const cityless: Record<string, any> = { ...record, id: 7101, proposalId: `${publishedId}-old` };
    delete cityless.city;
    server.records.set('7101', cityless);
    const second = await deviceIn(browser, server, 'new_york');
    try {
      await second.page.goto('/proposals/7101?reduceMotion=1');
      const croatian = await second.page.evaluate(() => {
        const manager = (window as any).CityConfigManager;
        const id = manager.getCitiesByParcelSource('oss-wfs')[0].id;
        return { id, label: manager.getCityLabel(id) };
      });
      await followToCity(second.page, croatian.id, croatian.label);
      expect(new URL(second.page.url()).pathname).toBe('/proposals/7101');
      await expect.poll(() => storedIn(second.page, cityless.proposalId), { timeout: 30_000 }).toEqual({ city: croatian.id, stored: true });
      expect(second.errors).toEqual([]);
    } finally {
      await second.context.close();
    }
  });

  test('the address bar follows the map, and a reload opens where the map was', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).map.setView([45.8105, 15.975], 17, { animate: false }));
    await expect.poll(() => new URL(page.url()).searchParams.get('at')).toBe('45.81050,15.97500,17');
    // a real drag moves it on as well
    await panMap(page, 200, 0);
    await expect.poll(() => new URL(page.url()).searchParams.get('at')).not.toBe('45.81050,15.97500,17');
    const at = new URL(page.url()).searchParams.get('at') as string;
    expect(new URL(page.url()).searchParams.get('city')).toBe('zg');

    await page.reload();
    await waitForMapReady(page);
    const [lat, lon, zoom] = at.split(',').map(Number);
    await expect.poll(() => page.evaluate(() => {
      const map = (window as any).map;
      const center = map.getCenter();
      return { lat: Number(center.lat.toFixed(5)), lon: Number(center.lng.toFixed(5)), zoom: map.getZoom() };
    })).toEqual({ lat, lon, zoom });
  });

  test('a second tab of the same city is read-only, a tab of another city stays editable', async ({ mockApi: first, context }) => {
    await openCity(first);
    const banner = (page: Page) => page.locator('#cb-multitab-banner');
    const readOnly = (page: Page) => page.evaluate(() => !!(window as any).__cbSecondaryTab);

    const second = await context.newPage();
    await mockAllApiRoutes(second);
    await second.goto('/?city=zg&reduceMotion=1');
    await waitForMapReady(second);
    await expect(banner(second)).toBeVisible({ timeout: 15_000 });
    await expect(banner(second)).toContainText('already open in another tab');
    expect(await readOnly(second)).toBe(true);
    await expect(banner(first)).toHaveCount(0);
    expect(await readOnly(first)).toBe(false);

    const other = await context.newPage();
    await mockAllApiRoutes(other);
    await other.goto('/?city=new_york&reduceMotion=1');
    await waitForMapReady(other);
    // "Nobody answered" has no event of its own: a second New York tab going read-only is the proof
    // that this one became New York's editable tab instead of a read-only copy of Zagreb's.
    const otherAgain = await context.newPage();
    await mockAllApiRoutes(otherAgain);
    await otherAgain.goto('/?city=new_york&reduceMotion=1');
    await waitForMapReady(otherAgain);
    await expect(banner(otherAgain)).toBeVisible({ timeout: 15_000 });
    expect(await readOnly(other)).toBe(false);
    await expect(banner(other)).toHaveCount(0);
    expect(await readOnly(first)).toBe(false);
  });
});
