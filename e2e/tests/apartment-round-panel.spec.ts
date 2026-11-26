// The X-ray apartment panel with a crowdfunding round offering the building's apartments: each
// choice names its reservation state, the chosen apartment shows its terms, round, buyer and the
// round's Reserve apartment review, and the round's stats fold under a one-line summary.
import { test, expect } from '../helpers/fixtures';
import { stubBasemapTiles } from '../helpers/runtime';

// The mocked New York parcel register fails, and its recovery offer would open as a modal over the
// panel on this phone viewport (js/parcels/ground-fallback.js): dismiss it for the session up front.
test.beforeEach(async ({ mockApi: page }) => {
  // Only the app's own document: sandboxed frames have no sessionStorage.
  await page.addInitScript(() => {
    if (window === window.top) sessionStorage.setItem('cb_ground_fallback_dismissed:new_york', '1');
  });
});

test('an X-ray building offered in a crowdfunding round shows each apartment’s reservation state and the round stats', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await stubBasemapTiles(page);
  await page.goto('/?city=new_york&at=40.7143,-74.0085,19&lang=en', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: '/js/apartment-round.js' });
  await page.addScriptTag({ url: '/js/three-apartment-panel.js' });
  await page.waitForFunction(() => Boolean((window as any).ApprovalLink && (window as any).AgreementRecord && (window as any).AgreementBridge));
  await page.evaluate(() => {
    const w = window as any;
    const building = 'new_york::buildings::tower-1';
    const cid = 'bafkrei' + 'a'.repeat(52);
    const offered = (unitId: string, unit: string) => ({ unitId, label: `Apartment ${unitId.toUpperCase()}`, xrayBuilding: building, unit,
      at: '40.7143,-74.0085,19', priceUsdcAtomic: '250000000', depositUsdcAtomic: '12500000' });
    const funding = { targetUsdcAtomic: '25000000', apartments: { projectId: 'garden-court', units: [
      offered('a-101', '1::A-101'), offered('a-102', '1::A-102'), offered('b-201', '2::B-201')] } };
    const buyer = 'DqyLaEh7Kso3LtVpmWM8f8dpyWHXG7C1TkKwKoKiaFn5';
    const view = w.ApartmentRound.model.roundView({ cid, title: 'Courtyard homes', city: 'new_york', funding, accepting: true, inventory: [
      { unitId: 'a-101', status: 'reserved', buyer }, { unitId: 'a-102', status: 'available' }, { unitId: 'b-201', status: 'unlisted' }] });
    const entry = { status: 'ready', rounds: [view], failed: 0, error: null, readAt: 1 };
    const roundData = { entry, states: w.ApartmentRound.model.buildingStates([view], building) };
    const units = ['1::A-101', '1::A-102', '1::A-103', '2::B-201'].map((key, i) => ({ key, level: Number(key[0]), ordinal: i + 1 }));
    let chosen = units[0];
    const ui = w.ThreeApartmentPanel.create({ translate: (_: string, fallback: string, params: any = {}) =>
      String(fallback).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => (name in params ? params[name] : match)),
    onChoose: (key: string) => { chosen = units.find(unit => unit.key === key)!; ui.show(units, chosen, false, true, roundData); },
    onClose: () => {}, linkFor: () => null });
    ui.show(units, chosen, false, true, roundData);
  });
  const panel = page.locator('.three-apartment-panel:visible').last();
  const picker = panel.getByRole('combobox');
  await expect(picker.locator('option[value="1::A-101"]')).toHaveText('Floor 1 · Apartment 1 · Apartment A-101 · Reserved');
  await expect(picker.locator('option[value="1::A-103"]')).toHaveText('Floor 1 · Apartment 3');
  await expect(picker.locator('option[value="2::B-201"]')).toHaveText('Floor 2 · Apartment 4 · Apartment B-201 · Awaiting developer listing');

  const card = panel.locator('.three-apartment-round-unit');
  await expect(card).toContainText('Apartment A-101');
  await expect(card.locator('[data-apartment-state="reserved"]')).toHaveText('Reserved');
  await expect(card).toContainText('Price 250 USDC · Reservation deposit 12.5 USDC');
  await expect(card.getByRole('link', { name: /Reserved by · DqyLaEh7Kso3LtVpmWM8f8dpyWHXG7C1TkKwKoKiaFn5/ })).toHaveAttribute('href', /explorer\.solana\.com\/address\/DqyL.*cluster=devnet/);
  await expect(card.getByRole('link', { name: 'Reserve apartment' })).toHaveCount(0);
  await expect(panel.getByRole('list', { name: 'Apartment states' })).toContainText('Not offered');

  // The same choice from the picker as from the model: the available unit offers the round's review.
  await picker.selectOption('1::A-102');
  await expect(card.locator('[data-apartment-state="available"]')).toHaveText('Available');
  await expect(card.getByRole('link', { name: 'Reserve apartment' })).toHaveAttribute('href', /\/agreements\/bafkrei.*act=reserve.*unitId=a-102/);
  await picker.selectOption('1::A-103');
  await expect(card).toHaveCount(0);
  await expect(panel).toContainText('This apartment is not offered in a crowdfunding round.');

  const summary = panel.locator('.three-apartment-round > summary');
  await expect(summary).toHaveText('Courtyard homes: 1 of 3 reserved · 50% of the target');
  const stats = panel.getByRole('region', { name: 'Courtyard homes' });
  await expect(stats).toBeHidden();
  await summary.press('Enter');
  await expect(stats).toBeVisible();
  await expect(stats).toContainText('Reserved deposits: 12.5 of 25 devnet USDC (50% of the target)');
  await expect(stats.locator('dl')).toContainText(/Offered\s*3\s*Reserved\s*1\s*Available\s*1\s*Not available\s*1/);
  await stats.getByText('By floor').click();
  await expect(stats.getByRole('row', { name: /Floor 1/ })).toContainText(/2\s*1\s*1/);
  // The open stats survive a redraw with a newer read.
  await picker.selectOption('1::A-101');
  await expect(panel.getByRole('region', { name: 'Courtyard homes' })).toBeVisible();

  // The Building overview: every apartment of the building, the top floor first, each cell in its
  // state and named with its floor, apartment and state; the chosen apartment is marked.
  const overview = panel.getByRole('region', { name: 'Building overview' });
  await expect(overview).toBeVisible();
  const floors = overview.getByRole('group');
  await expect(floors).toHaveCount(2);
  await expect(floors.nth(0)).toHaveAccessibleName('Floor 2');
  await expect(floors.nth(1)).toHaveAccessibleName('Floor 1');
  const cell = (key: string) => overview.locator(`[data-apartment-overview-cell="${key}"]`);
  await expect(floors.nth(1).getByRole('button')).toHaveText(['1', '2', '3']);
  await expect(cell('1::A-101')).toHaveAccessibleName('Floor 1 · Apartment 1 · Apartment A-101 · Reserved');
  await expect(cell('1::A-101')).toHaveAttribute('data-apartment-state', 'reserved');
  await expect(cell('1::A-102')).toHaveAttribute('data-apartment-state', 'available');
  await expect(cell('1::A-103')).toHaveAccessibleName('Floor 1 · Apartment 3 · Not offered');
  await expect(cell('2::B-201')).toHaveAccessibleName('Floor 2 · Apartment 4 · Apartment B-201 · Awaiting developer listing');
  await expect(cell('2::B-201')).toHaveAttribute('data-apartment-state', 'unavailable');
  await expect(cell('1::A-101')).toHaveAttribute('aria-current', 'true');
  await expect(cell('1::A-101')).toHaveAttribute('tabindex', '0');
  // A cell chooses its apartment as the picker does; the redraw keeps focus on the cell.
  await cell('1::A-102').click();
  await expect(picker).toHaveValue('1::A-102');
  await expect(card.locator('[data-apartment-state="available"]')).toHaveText('Available');
  await expect(cell('1::A-102')).toHaveAttribute('aria-current', 'true');
  await expect(cell('1::A-101')).not.toHaveAttribute('aria-current', 'true');
  await expect(cell('1::A-102')).toBeFocused();
  // Arrow keys move between cells (up to the floor above); Enter chooses.
  await page.keyboard.press('ArrowUp');
  await expect(cell('2::B-201')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveValue('2::B-201');
  await expect(card.locator('[data-apartment-state="unavailable"]')).toHaveText('Awaiting developer listing');
  await expect(cell('2::B-201')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(cell('1::A-103')).toBeFocused();
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});

test('the funding section’s Building overview shows the round by floor and brings a pressed apartment’s row into view', async ({ mockApi: page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await stubBasemapTiles(page);
  await page.goto('/?city=new_york&at=40.7143,-74.0085,19&lang=en', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as any).AgreementPanel?.loadFundingScripts && (window as any).AgreementBridge && (window as any).BuildingUnitLinks));
  await page.evaluate(async () => {
    const w = window as any;
    await w.AgreementPanel.loadFundingScripts();
    const building = 'new_york::buildings::tower-1';
    const sponsor = 'H37sgaQuqcbs5GAP3WkurghsnPuMkFYcs2BSR6By2B2E', buyer = 'DqyLaEh7Kso3LtVpmWM8f8dpyWHXG7C1TkKwKoKiaFn5';
    const offered = (unitId: string, unit: string) => ({ unitId, label: `Apartment ${unitId.toUpperCase()}`, xrayBuilding: building, unit,
      at: '40.7143,-74.0085,19', priceUsdcAtomic: '250000000', depositUsdcAtomic: '12500000',
      drawing: { name: `${unitId}.pdf`, mediaType: 'application/pdf', data: btoa('%PDF-1.7') } });
    const units = [offered('a-101', '1::A-101'), offered('a-102', '1::A-102'), offered('b-201', '2::B-201'), offered('b-202', '2::B-202')];
    const states: Record<string, string> = { 'a-101': 'reserved', 'a-102': 'available', 'b-201': 'unlisted', 'b-202': 'available' };
    const agreement = { title: 'Courtyard homes', published: { cid: 'bafkrei' + 'a'.repeat(52), sponsor }, sponsor, city: 'new_york',
      deadline: new Date(Date.now() + 30 * 86400000).toISOString(), rule: { electorate: 'investors', lens: [sponsor] },
      funding: { targetUsdcAtomic: '25000000', contract: { name: 'terms.pdf', mediaType: 'application/pdf', data: btoa('%PDF-1.7') },
        apartments: { projectId: 'garden-court', units } },
      onchain: { chain: 'solana', cluster: 'devnet', account: 'Fixture1111111111111111111111111111111111111' } };
    w.AgreementBridge = { ...w.AgreementBridge, donations: async () => ({ escrow: { totalDonated: '12500000', totalRefunded: '0', donorCount: 1, released: false }, mine: [] }),
      apartmentInventory: async () => units.map(unit => ({ unitId: unit.unitId, deposit: unit.depositUsdcAtomic, status: states[unit.unitId],
        buyer: states[unit.unitId] === 'reserved' ? buyer : null })) };
    const slot = document.createElement('div');
    slot.className = 'agreement-funding-fixture';
    document.body.append(slot);
    w.AgreementBoost.mount(slot, { agreement, chainStatus: 'Active' });
  });
  const slot = page.locator('.agreement-funding-fixture');
  const overview = slot.getByRole('region', { name: 'Building overview' });
  await expect(overview).toBeVisible();
  const floors = overview.getByRole('group');
  await expect(floors).toHaveCount(2);
  await expect(floors.nth(0)).toHaveAccessibleName('Floor 2');
  await expect(floors.nth(0).getByRole('button')).toHaveText(['B-201', 'B-202']);
  await expect(floors.nth(1).getByRole('button')).toHaveText(['A-101', 'A-102']);
  const cell = (key: string) => overview.locator(`[data-apartment-overview-cell="${key}"]`);
  await expect(cell('1::A-101')).toHaveAccessibleName('Floor 1 · Apartment A-101 · Reserved');
  await expect(cell('1::A-101')).toHaveAttribute('data-apartment-state', 'reserved');
  await expect(cell('2::B-201')).toHaveAccessibleName('Floor 2 · Apartment B-201 · Awaiting developer listing');
  await expect(cell('2::B-202')).toHaveAttribute('data-apartment-state', 'available');
  // The round's own legend has no Not offered.
  await expect(slot.getByRole('list', { name: 'Apartment states' })).not.toContainText('Not offered');
  // A cell clears a search that hides its row, then focuses the row.
  await slot.getByLabel('Find an apartment').fill('A-101');
  const row = slot.locator('[data-agreement-apartment-unit="b-202"]');
  await expect(row).toBeHidden();
  await cell('2::B-202').click();
  await expect(slot.getByLabel('Find an apartment')).toHaveValue('');
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});
