import { test, expect } from '../helpers/fixtures';
import { cidOfObject } from '../../frontend/js/cid.js';

const SPONSOR = 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os';
const LENS = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';

function agreement(title: string, minted = false) {
  const content = {
    schema: 'agreement/v1', title, author: 'Walkthrough fixture', sponsor: minted ? SPONSOR : null,
    city: 'alatau', createdAt: '2026-11-01T00:00:00.000Z', planCid: cidOfObject({ schema: 'plan/v1', title }),
    inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
    rule: { electorate: 'owners', binding: true, approvalConfig: null, lens: [LENS] }, deadline: null,
  };
  return { cid: cidOfObject(content), content, title, city: 'alatau', onchain: minted ? {
    chain: 'solana', cluster: 'devnet', account: '11111111111111111111111111111111', sponsor: SPONSOR, lens: LENS,
    status: 'executed', decision: 'satisfied',
  } : null };
}

test.describe('lens agreement walkthrough', () => {
  test('shows pending owner decisions and an unavailable chain stage distinctly from execution', async ({ mockApi: page }) => {
    const pending = agreement('Pending Alatau agreement');
    const executed = agreement('Executed Alatau agreement', true);
    await page.route('**/js/solana/chain-data-loader.js', route => route.fulfill({
      contentType: 'application/javascript', body: 'window.SolanaChainDataLoader = { async getVerifiedConnection() { throw new Error("RPC unavailable"); } };'
    }));
    await page.route('**/lenses/members', route => route.fulfill({ json: { members: [{ key: LENS, name: 'Reference lens', serviceUrl: 'https://lens-walk.e2e.invalid' }] } }));
    await page.route('**/agreements?**', route => route.fulfill({ json: { agreements: [pending, executed] } }));
    await page.route(`**/agreements/${pending.cid}`, route => route.fulfill({ json: pending }));
    await page.route(`**/agreements/${executed.cid}`, route => route.fulfill({ json: executed }));
    await page.route(`**/agreements/${pending.cid}/decisions`, route => route.fulfill({ json: { agreementCid: pending.cid, decisions: [] } }));
    await page.route(`**/agreements/${executed.cid}/decisions`, route => route.fulfill({ json: { agreementCid: executed.cid, decisions: [] } }));
    await page.route('https://lens-walk.e2e.invalid/lens/attestations**', route => route.fulfill({ json: { attestations: [] } }));
    await page.goto(`/lens.html?backend=${encodeURIComponent('http://localhost:3099')}&city=alatau&at=43.610624,77.025837,14&agreement=${pending.cid}`);
    await expect(page.locator('#lc-agreement')).toHaveValue(pending.cid);
    await expect(page.locator('#lc-story')).toBeVisible();
    await expect(page.locator('#lc-receipts')).toContainText('No owner decisions');
    await expect(page.locator('#lc-execution')).toContainText('This agreement has no indexed Solana account');

    await page.locator('#lc-agreement').selectOption(executed.cid);
    await expect(page.locator('#lc-story')).toBeVisible();
    await expect(page.locator('#lc-execution')).toContainText('live Solana account could not be read');
    await expect(page.locator('#lc-execution')).toContainText('Last indexed outcome · Executed');
    await expect(page.locator('#lc-statement')).not.toContainText('Verified against the agreement');
  });

  test('does not let a delayed record A response overwrite selected record B', async ({ mockApi: page }) => {
    const a = agreement('Slow A');
    const b = agreement('Fast B');
    await page.route('**/lenses/members', route => route.fulfill({ json: { members: [] } }));
    await page.route('**/agreements?**', route => route.fulfill({ json: { agreements: [a, b] } }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/agreements/${a.cid}`, async route => { await gate; await route.fulfill({ json: a }); });
    await page.route(`**/agreements/${b.cid}`, route => route.fulfill({ json: b }));
    await page.route('**/agreements/*/decisions', route => route.fulfill({ json: { agreementCid: b.cid, decisions: [] } }));
    await page.goto(`/lens.html?backend=${encodeURIComponent('http://localhost:3099')}&city=alatau&at=43.610624,77.025837,14&agreement=${a.cid}`);
    await page.locator('#lc-agreement').selectOption(b.cid);
    await expect(page.locator('#lc-subject')).toHaveText('Fast B');
    const stale = page.waitForResponse(response => response.url().endsWith(a.cid));
    release(); await stale;
    await expect(page.locator('#lc-subject')).toHaveText('Fast B');
  });
});
