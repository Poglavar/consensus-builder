// Worldwide publication and city routing (projections.md §3, §10 M8, location-first.md phase 4;
// plan-design-agreement.md M2, M3): a publish sends the design with the parcel source its city binds
// with, a design or an agreement opened from another city asks and then opens in its own city's
// store, the address bar follows the map, and the read-only guard for a second tab applies per city.
import { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady, panMap } from '../helpers/app';
import { openCity, createSpace, showProposal } from '../helpers/runtime';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedIndex, fileAgreement, pageIndex, SharedIndex } from '../helpers/mocks/shared-server';

async function personalizeProfile(page: Page, name: string): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill(name);
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const w = window as any;
    return w.GuestPolicy.check('publish', { isGuest: w.getCurrentUserAgent?.()?.isGuest }).allowed;
  })).toBe(true);
}

// A park authored in Zagreb and published through its details' Share. Resolves its CID.
async function publishPark(page: Page): Promise<string> {
  await openCity(page);
  await personalizeProfile(page, 'City author');
  const proposalId = await createSpace(page, 'park');
  await showProposal(page, proposalId);
  await page.locator('#proposal-details-panel .btn-share-proposal').click();
  const index = pageIndex(page);
  await expect.poll(() => index.designs.size, { timeout: 30_000 }).toBe(1);
  return [...index.designs.keys()][0];
}

// Another device whose stored city is `cityId`, reading the same index.
async function deviceIn(browser: Browser, index: SharedIndex, cityId: string, baseURL: string): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript((id) => {
    try {
      localStorage.setItem('cb_current_city', id);
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* opaque origin */ }
  }, cityId);
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedIndex(page, index);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}

// The "This proposal is in …" prompt a link from outside gets: answer "Open in <city>", then the
// page reloads into that city on the proposal's address.
async function followToCity(page: Page, cityId: string, cityLabel: string): Promise<void> {
  const fallback = page.locator('.ground-fallback-overlay');
  if (await fallback.isVisible()) {
    await fallback.getByRole('button', { name: 'Not now' }).click();
    await expect(fallback).toBeHidden();
  }
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
  test('a publish pins the design and indexes it with the parcel source of its city', async ({ mockApi: page }) => {
    const cid = await publishPark(page);
    const posts = pageIndex(page).requests.filter(request => request.method === 'POST');
    expect(posts.map(request => request.path)).toEqual(['/pins', '/designs']);
    const indexed = posts[1].body;
    expect(indexed.cid).toBe(cid);
    expect(indexed.content.city).toBe('zagreb');
    // The client-selected parcel source is a binding parameter, never part of the design: the CID
    // commits to the drawing only.
    const selectedSource = await page.evaluate(() => (window as any).CityConfigManager.getDataContext(null, 'zagreb').parcelSourceId);
    expect(selectedSource).toEqual(expect.any(String));
    expect(selectedSource).not.toBe('');
    expect(indexed).toHaveProperty('parcelSourceId', selectedSource);
    expect(indexed.content).not.toHaveProperty('parcelSourceId');
  });

  test('a design opened from another city asks, then opens in its own city', async ({ mockApi: author, browser }) => {
    // one publish and a device booting twice (the wrong city, then the right one)
    test.setTimeout(180_000);
    const cid = await publishPark(author);
    const baseURL = new URL(author.url()).origin;

    // the feed/search route: ?focusProposal=<cid> in New York for a Zagreb design
    const device = await deviceIn(browser, pageIndex(author), 'new_york', baseURL);
    try {
      await device.page.goto(`/?city=new_york&reduceMotion=1&focusProposal=${cid}`);
      await followToCity(device.page, 'zagreb', 'Zagreb');
      expect(new URL(device.page.url()).searchParams.get('focusProposal')).toBe(cid);
      await expect.poll(() => storedIn(device.page, `design-${cid}`), { timeout: 30_000 }).toEqual({ city: 'zagreb', stored: true });
      expect(device.errors).toEqual([]);
    } finally {
      await device.context.close();
    }
  });

  test('an agreement opened from another city asks, then opens in its own city', async ({ mockApi: author, browser }) => {
    test.setTimeout(180_000);
    // A community agreement over the published park, proposed in Zagreb.
    const designCid = await publishPark(author);
    const index = pageIndex(author);
    const design = index.designs.get(designCid)!;
    const title = 'Zagreb park agreement';
    const cid = fileAgreement(index, {
      schema: 'agreement/v1', title, author: 'City author', sponsor: null, city: 'zagreb', createdAt: '2026-10-21T08:00:00.000Z',
      designs: [{ cid: designCid, goal: design.goal, title: design.title }],
      inputs: { parcels: [{ parcelId: 'HR-335754-1234', areaM2: 100, holders: [] }], openGroundM2: 0 },
      outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
      rule: { electorate: 'community', binding: false, approvalConfig: null, lens: [] }, deadline: null,
    });
    expect(index.agreements.get(cid)!.city).toBe('zagreb');
    const baseURL = new URL(author.url()).origin;

    // Its link opened on a device whose city is New York.
    const device = await deviceIn(browser, index, 'new_york', baseURL);
    try {
      await device.page.goto(`/agreements/${cid}?city=new_york&reduceMotion=1`);
      await followToCity(device.page, 'zagreb', 'Zagreb');
      expect(new URL(device.page.url()).pathname).toBe(`/agreements/${cid}`);
      const panel = device.page.locator('section#agreement-panel');
      await expect(panel).toBeVisible({ timeout: 60_000 });
      await expect(device.page.locator('#agreement-panel-title')).toHaveText(title);
      await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', cid);
      // Kept in Zagreb's store, with its design applied there.
      expect(await device.page.evaluate(cid => {
        const w = window as any;
        const agreement = w.AgreementStore.list().find((item: any) => item.published && item.published.cid === cid);
        return {
          city: w.CityConfigManager.getCurrentCityId(),
          designs: agreement ? agreement.designs.map((entry: any) => entry.proposalId) : null,
          applied: agreement ? agreement.designs.every((entry: any) => !!w.isApplied(w.proposalStorage.getProposal(entry.proposalId))) : false,
        };
      }, cid)).toEqual({ city: 'zagreb', designs: [`design-${designCid}`], applied: true });
      expect(device.errors).toEqual([]);
    } finally {
      await device.context.close();
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
    // a plain location: ?at= decides the city on reload, so the ?city= the boot came with is gone
    expect(new URL(page.url()).searchParams.get('city')).toBeNull();

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
    // Four full app loads: 30 s is not enough on a busy machine.
    test.setTimeout(90_000);
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

    await banner(second).getByRole('button', { name: 'Close' }).click();
    await expect(banner(second)).toHaveCount(0);
    // Dismiss only hides the warning; the secondary tab remains read-only.
    expect(await readOnly(second)).toBe(true);
  });
});
