import { test, expect } from '../helpers/fixtures';
import { stubBasemapTiles } from '../helpers/runtime';

test('an apartment picker finds both kinds of offers and keeps the exact unit through wallet connection and review', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await stubBasemapTiles(page);
  const cid = 'bafkrei' + 'a'.repeat(52);
  const previousLens = 'AmAqM6xM43JxHv3npeWWNhz3X7Xuj246TedcRPa1HWj7';
  const offerLens = 'H37sgaQuqcbs5GAP3WkurghsnPuMkFYcs2BSR6By2B2E';
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: previousLens, name: 'First lens' }, { key: offerLens, name: 'Apartment lens' }
  ] } }));
  await page.route('**/agreements/apartment-offers?**', route => route.fulfill({ json: { offers: [
    { cid, city: 'new_york', title: 'Courtyard', unitId: 'a-101', label: 'A-101', depositUsdcAtomic: '12500000' }
  ] } }));
  await page.route('**/property-offers?**', route => route.fulfill({ json: { propertyOffers: [
    { cid, content: { direction: 'buy', title: 'First bid', priceLamports: '1250000000' } }
  ] } }));
  await page.goto('/?city=new_york&at=40.7143,-74.0085,19&lang=en', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/js/three-apartment-panel.js' });
  await page.waitForFunction(() => Boolean((window as any).PropertyOfferDialog));
  await page.evaluate(() => {
    const w = window as any;
    const address = 'DqyLaEh7Kso3LtVpmWM8f8dpyWHXG7C1TkKwKoKiaFn5';
    let connected = false;
    w.solanaWalletManager = {
      getState: () => ({ status: connected ? 'connected' : 'disconnected', accounts: connected ? [address] : [] }),
      getProvider: () => connected ? { publicKey: { toBase58: () => address } } : null
    };
    w.walletManager = { openConnectorModal: () => { connected = true; return { dialog: { closed: Promise.resolve() } }; } };
    // Keep the reviewed working copy on this device. The transaction suites exercise mint and the lens.
    w.PropertyOfferSync = { ...w.PropertyOfferSync, mint: async (record: any) => record };
    const unit = { key: '1::A-101', level: 1, ordinal: 1 };
    const ui = w.ThreeApartmentPanel.create({ translate: (_: string, fallback: string) => fallback,
      onChoose: () => {}, onClose: () => {},
      linkFor: () => location.origin + '/?city=new_york&xrayBuilding=new_york%3A%3Abuildings%3A%3Atower-1&unit=1%3A%3AA-101&at=40.7143,-74.0085,19' });
    ui.show([unit], unit, false, true);
  });
  const picker = page.locator('.three-apartment-panel:visible').last();
  await picker.getByRole('button', { name: 'Find apartment offers' }).press('Enter');
  await expect(picker.getByRole('link', { name: /Courtyard.*12.5 USDC/ })).toHaveAttribute('href', /act=reserve/);
  await expect(picker.getByRole('link', { name: /1.25 SOL.*First bid/ })).toHaveAttribute('href', /property-offers\//);
  for (const direction of ['buy', 'sell']) {
    await picker.getByRole('button', { name: 'Offer to ' + direction + ' apartment' }).press('Enter');
    const form = page.locator('.property-offer-dialog[role=dialog]:visible');
    await expect(form).toContainText('1::A-101');
    const price = form.getByRole('textbox', { name: 'Total price (SOL)', exact: true });
    await price.fill('1.25');
    if (direction === 'buy') {
      await form.getByRole('button', { name: /Connect wallet/i }).press('Enter');
      await expect(price).toHaveValue('1.25');
    }
    const lensField = form.getByPlaceholder('Solana lens member address');
    await lensField.fill(previousLens);
    const defaults = await page.evaluate(() => (window as any).LensPicker.getEntries());
    await form.getByRole('button', { name: 'Choose lens' }).press('Enter');
    const directory = page.getByRole('dialog', { name: 'Choose lens' });
    const selected = directory.getByRole('radio', { name: /Apartment lens/ });
    await selected.press('Space');
    await expect(selected).toBeFocused();
    await directory.getByRole('button', { name: 'Done' }).press('Enter');
    await expect(lensField).toHaveValue(offerLens);
    expect(await page.evaluate(() => (window as any).LensPicker.getEntries())).toEqual(defaults);
    if (direction === 'sell') await form.getByRole('textbox', { name: 'SOL amount' }).fill('1.25');
    await form.getByRole('button', { name: /Mint offer/i }).press('Enter');
    const viewed = page.getByRole('dialog').filter({ has: page.locator('.property-offer-panel') });
    await expect(viewed.getByRole('link', { name: /apartment in X-ray/i })).toHaveAttribute('href', /unit=1%3A%3AA-101/);
    const record = await page.evaluate(() => (window as any).PropertyOfferStore.list()[0]);
    expect(record.content).toMatchObject({ direction, priceLamports: '1250000000', lens: offerLens,
      apartment: { xrayBuilding: 'new_york::buildings::tower-1', unit: '1::A-101' } });
    expect(record.content.parcels).toBeUndefined();
    await page.keyboard.press('Escape');
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as any).PropertyOfferStore));
  const restored = await page.evaluate(async () => {
    const w = window as any; await w.PersistentStorage.ready;
    return w.PropertyOfferStore.list().map((r: any) => [r.content.direction, r.content.apartment.unit, r.content.lens]);
  });
  expect(restored).toEqual([['sell', '1::A-101', offerLens], ['buy', '1::A-101', offerLens]]);
});
