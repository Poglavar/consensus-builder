// A flat in X-ray: its panel opens the flat's holder-and-offers sheet (offers on it from the index)
// and the offer form, which keeps the exact flat through wallet connection and writes a
// property-offer/v2 record (USDC by default, a typed decimal comma, the buyer's lens set).
import { test, expect } from '../helpers/fixtures';
import { stubBasemapTiles } from '../helpers/runtime';

test('a flat’s panel lists its offers and makes a v2 offer for exactly that flat', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await stubBasemapTiles(page);
  const lensKey = 'H37sgaQuqcbs5GAP3WkurghsnPuMkFYcs2BSR6By2B2E';
  const building = 'new_york::buildings::tower-1';
  const listed = { schema: 'property-offer/v2', city: 'new_york', direction: 'sell', currency: 'USDC', price: '250000000',
    asset: { kind: 'flat', xrayBuilding: building, unit: '1::1', at: '40.7143,-74.0085,19' } };
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [{ key: lensKey, name: 'Notary' }] } }));
  const listQueries: string[] = [];
  await page.route('**/property-offers?**', route => { listQueries.push(route.request().url()); return route.fulfill({ json: { propertyOffers: [
    { cid: 'bafkrei' + 'a'.repeat(52), status: 'open', content: listed }
  ], hasMore: false } }); });
  await page.goto('/?city=new_york&at=40.7143,-74.0085,19&lang=en', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/js/three-apartment-panel.js' });
  await page.waitForFunction(() => Boolean((window as any).PropertyOfferDialog && (window as any).PropertyAssetDialog));
  await page.evaluate(({ building, lensKey }) => {
    const w = window as any;
    const address = 'DqyLaEh7Kso3LtVpmWM8f8dpyWHXG7C1TkKwKoKiaFn5';
    let connected = false;
    w.LensPicker.setEntries([{ address: lensKey, name: 'Notary' }]);
    w.PropertyOfferSolanaBridge = { ...w.PropertyOfferSolanaBridge, connectedWallet: () => connected ? address : null,
      lensView: async () => ({ views: [], holder: null, conflict: null, silent: [lensKey], stating: 0 }) };
    w.walletManager = { openConnectorModal: () => { connected = true; return { dialog: { closed: Promise.resolve() } }; } };
    // Keep the reviewed working copy on this device; the chain suites exercise minting.
    w.PropertyOfferSync = { ...w.PropertyOfferSync, mint: async (record: any) => record };
    w.PropertyOfferPanel = { open: () => null };
    const unit = { key: '1::1', level: 1, ordinal: 1, areaM2: 54 };
    const ui = w.ThreeApartmentPanel.create({ translate: (_: string, fallback: string) => fallback, onChoose: () => {}, onClose: () => {},
      linkFor: () => location.origin + `/?city=new_york&xrayBuilding=${encodeURIComponent(building)}&unit=1%3A%3A1&at=40.7143,-74.0085,19` });
    ui.show([unit], unit, true, true);
  }, { building, lensKey });
  const panel = page.locator('.three-apartment-panel:visible').last();
  await expect(panel.getByRole('combobox')).toContainText('54 m²');

  await panel.getByRole('button', { name: 'Who holds it, offers' }).press('Enter');
  const sheet = page.getByRole('dialog').filter({ hasText: 'Offers on it' });
  await expect(sheet).toContainText('For sale · 250 USDC');
  expect(new URL(listQueries[0]).searchParams.get('asset')).toMatch(/^[0-9a-f]{64}$/);
  await page.keyboard.press('Escape');

  await panel.getByRole('button', { name: 'Offer to buy' }).press('Enter');
  const form = page.locator('.property-offer-dialog[role=dialog]:visible');
  await expect(form).toContainText('flat 1');
  await form.getByRole('button', { name: /Connect wallet/i }).press('Enter');
  await form.getByRole('textbox', { name: 'Your price' }).fill('1,25');
  await form.getByRole('button', { name: /escrow/i }).press('Enter');
  const record = await page.evaluate(() => (window as any).PropertyOfferStore.list()[0]);
  expect(record.content).toMatchObject({ schema: 'property-offer/v2', direction: 'buy', currency: 'USDC', price: '1250000',
    lens: { members: [lensKey], threshold: 1 }, asset: { kind: 'flat', xrayBuilding: building, unit: '1::1' } });
  expect(record.content.payouts).toBeUndefined();
});
