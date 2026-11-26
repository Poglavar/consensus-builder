// The X-ray apartment panel with a crowdfunding round offering the building's apartments: each
// choice names its reservation state, the chosen apartment shows its terms, round, buyer and the
// round's Reserve apartment review, and the round's stats fold under a one-line summary.
import { test, expect } from '../helpers/fixtures';
import { stubBasemapTiles } from '../helpers/runtime';

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
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
