// Where people follow property sales: the Market sheet's Sold choice lists settled offers with who
// bought from whom and a link to the exact flat, and an Activity row about an offer opens that offer
// and links the flat it trades.
import { test, expect } from '../helpers/fixtures';
import { openCity } from '../helpers/runtime';

const BUILDING = 'zg::buildings::tower-1';
const FLAT = { kind: 'flat', xrayBuilding: BUILDING, unit: '4::2', at: '45.80025,15.9822,19' };
const OFFER = 'bafkrei' + 'b'.repeat(52);
const BUYER = '5LU4Jvke8A7YCBVT8Wwoo4Lwu2WWoUUGjPbYoMNAEbnP';
const SELLER = '3KcgcFoHeSD7ev64Wq6G1CgmBaec6MRwzHmmqNL4s9o5';
const content = { schema: 'property-offer/v2', city: 'zg', direction: 'sell', currency: 'USDC', price: '2410000', asset: FLAT,
  expiresAt: '2026-11-29T12:00:00.000Z', proposer: SELLER, lens: { members: [], threshold: 0 }, payouts: [{ recipient: SELLER, amount: '2410000' }] };

test('Market lists sold flats with buyer, seller and a link to the flat', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const queries: URLSearchParams[] = [];
  await page.route('**/property-offers?**', route => {
    const query = new URL(route.request().url()).searchParams; queries.push(query);
    const sold = query.get('status') === 'settled';
    return route.fulfill({ json: { hasMore: false, propertyOffers: sold
      ? [{ cid: OFFER, status: 'settled', content, onchain: { status: 'settled', buyer: BUYER, seller: SELLER } }] : [] } });
  });
  await openCity(page);
  await page.locator('#market-button').click();
  const sheet = page.locator('#market-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Sold' }).click();
  const row = sheet.locator('.property-market__row');
  await expect(row).toContainText('Sold');
  await expect(row).toContainText(`Buyer: ${BUYER.slice(0, 4)}…${BUYER.slice(-4)}`);
  await expect(row).toContainText(`Seller: ${SELLER.slice(0, 4)}…${SELLER.slice(-4)}`);
  const link = row.getByRole('link', { name: 'View the flat in X-ray' });
  const href = new URL(await link.getAttribute('href') as string);
  expect([href.searchParams.get('xrayBuilding'), href.searchParams.get('unit')]).toEqual([BUILDING, '4::2']);
  // Sold reads settled offers on either side.
  const last = queries[queries.length - 1];
  expect([last.get('status'), last.get('direction')]).toEqual(['settled', null]);
});

test('an Activity row about an offer opens the offer and links the flat it trades', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const event = { id: 'live:homebuyer-02:1', source: 'live', ok: true, actor: { id: 'homebuyer-02', name: 'homebuyer-02', controller: 'algorithm', wallet: BUYER },
    action: { type: 'take-offer', amount: '2.41' }, entity: { type: 'property-offer', id: OFFER }, asset: FLAT, cityId: 'zg',
    message: 'homebuyer-02 took the listing of Storey 4, flat 2 at 2.41 USDC; the lens member confirms.',
    occurredAt: '2026-11-27T19:55:52.425Z', recordedAt: '2026-11-27T19:55:52.425Z', transaction: 'tx1' };
  await page.route('**/agent/activity**', route => route.fulfill({ json: { events: [event], count: 1, source: 'live' } }));
  await page.route(`**/property-offers/${OFFER}`, route => route.fulfill({ json: { cid: OFFER, status: 'committed', content, onchain: null } }));
  await openCity(page);
  const opened = await page.evaluate(() => { const w = window as any; const calls: string[] = []; w.__openedOffers = calls;
    w.PropertyOfferSync = { ...w.PropertyOfferSync, importOffer: async (cid: string) => { calls.push(cid); return { id: `local-${cid}` }; } };
    w.PropertyOfferPanel = { ...w.PropertyOfferPanel, open: (id: string) => { calls.push(id); return null; } };
    w.openActivityPanel({ view: 'events' }); return true; });
  expect(opened).toBe(true);
  const panel = page.locator('#activity-sheet');
  const row = panel.locator('.activity-entry').filter({ hasText: 'took the listing' });
  const link = row.getByRole('link', { name: 'View the flat in X-ray' });
  const href = new URL(await link.getAttribute('href') as string);
  expect([href.searchParams.get('xrayBuilding'), href.searchParams.get('unit')]).toEqual([BUILDING, '4::2']);
  await row.getByRole('button', { name: 'Open offer' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__openedOffers)).toEqual([OFFER, `local-${OFFER}`]);
});
