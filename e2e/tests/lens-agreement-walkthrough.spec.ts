// The lens walkthrough's checklist in a browser: lens members of an N-of-M lens, an agreement minted
// under a retired program, a lens-free funding round and a stale response. The chain reader is
// replaced by canned account states (its byte checks are unit-tested in lens-agreement-evidence).
import { test, expect } from '../helpers/fixtures';
import { cidOfObject } from '../../frontend/js/cid.js';
import { AGREEMENT_PROGRAM_ID } from '../helpers/mocks/shared-server';

const SPONSOR = 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os';
const A = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const B = '5x8hiYo9V6kWpG8eVoyXZf4BHXnKSoCP3r7r3PyMBg4z';
const C = 'm8gLfyPspP6ABSNA4ZMFYCzzRGjNLBmrKKwKrGqbUfR';
const PROGRAM = AGREEMENT_PROGRAM_ID;
const BACKEND = encodeURIComponent('http://localhost:3099');

function agreement(title: string, { lens = [A], electorate = 'owners', onchain = null as Record<string, unknown> | null } = {}) {
  const content = {
    schema: 'agreement/v1', title, author: 'Walkthrough fixture', sponsor: SPONSOR,
    city: 'alatau', createdAt: '2026-11-01T00:00:00.000Z', planCid: cidOfObject({ schema: 'plan/v1', title }),
    inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
    rule: { electorate, binding: true, approvalConfig: null, lens }, deadline: null,
  };
  return { cid: cidOfObject(content), content, title, city: 'alatau', onchain };
}

async function serve(page, records, chains: Record<string, unknown>, directory: unknown[], feeds: Record<string, unknown[]> = {}) {
  await page.addInitScript(states => { (window as any).__chainStates = states; }, chains);
  await page.route('**/js/solana/chain-data-loader.js*', route => route.fulfill({
    contentType: 'application/javascript', body: 'window.SolanaChainDataLoader = { async getVerifiedConnection() { return {}; } };'
  }));
  await page.route('**/js/lens-agreement-evidence.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: 'window.LensAgreementEvidence = { async readChain({ record }) { const s = window.__chainStates[record.cid]; if (s === "throw") throw new Error("RPC unavailable"); return s || { account: null, statement: null }; } };'
  }));
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: directory } }));
  await page.route('**/agreements?**', route => route.fulfill({ json: { agreements: records } }));
  for (const record of records) {
    await page.route(`**/agreements/${record.cid}`, route => route.fulfill({ json: record }));
    await page.route(`**/agreements/${record.cid}/decisions`, route => route.fulfill({ json: { agreementCid: record.cid, decisions: [] } }));
  }
  await page.route('https://*.e2e.invalid/lens/attestations**', route => {
    const host = new URL(route.request().url()).host;
    return route.fulfill({ json: { attestations: feeds[host] || [] } });
  });
}
const open = (page, cid: string) => page.goto(`/lens.html?backend=${BACKEND}&city=alatau&at=43.610624,77.025837,14&agreement=${cid}`);

test.describe('lens agreement walkthrough', () => {
  test('shows each lens member of a 2-of-3 lens with what Solana recorded and what its service reports', async ({ mockApi: page }) => {
    const record = agreement('Two of three', { lens: [A, B, C], onchain: { cluster: 'devnet', programId: PROGRAM, status: 'active', lenses: [A, B, C], lensThreshold: 2, lensConfirmed: [] } });
    const account = { address: 'Acct1111111111111111111111111111111111111111', status: 'Active', lenses: [A, B, C], lensThreshold: 2, lensConfirmed: [B], decisionCode: 0, decisionAttestation: null, requiredFunding: 0, fundingMet: false };
    const statement = { authority: C, kind: 'decision', address: '7sS9tUj78sj1ZZzv7B23jscazXAdNKDWhNsqjLEcAmSw', issuedAt: '2026-11-20T10:00:00.000Z',
      payload: { agreementCid: record.cid, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: 'sha256:abc', sourceObservedAt: 1_790_000_000 } };
    await serve(page, [record], { [record.cid]: { account, statement: null } },
      [{ key: A, name: 'notary-01' }, { key: B, name: 'court-01', serviceUrl: 'https://b.e2e.invalid' }, { key: C, name: 'lifecycle-01', serviceUrl: 'https://c.e2e.invalid' }],
      { 'c.e2e.invalid': [statement] });
    await open(page, record.cid);

    const lensCheck = page.locator('.lc-check', { hasText: 'Lens members confirm the rule was met' });
    await expect(lensCheck).toContainText('1 of 2 required confirmations recorded on Solana');
    await expect(lensCheck).toHaveClass(/lc-check--waiting/);
    await expect(page.locator(`#lc-lens-${B}`)).toContainText('Confirmed on Solana');
    await expect(page.locator(`#lc-lens-${C}`)).toContainText('Statement issued, not yet recorded on Solana');
    await expect(page.locator(`#lc-lens-${C}`)).toContainText('As its statement service reports it');
    await expect(page.locator(`#lc-lens-${A}`)).toContainText('Lists no statement service');
    await expect(page.locator('#lc-roles')).toContainText('2 of 3 must confirm');
    await expect(page.locator('#lc-retry')).toBeHidden();
    // Every lens member is called one: no bare "member" anywhere in the walkthrough.
    expect(await page.locator('#lc-walkthrough').innerText()).not.toMatch(/(?<!lens )\bmembers?\b/i);
  });

  test('reads an agreement minted under a retired program as not on Solana, without an error or retry', async ({ mockApi: page }) => {
    const record = agreement('Retired program', { onchain: { cluster: 'devnet', programId: 'GtdgeRH89fRetiredProgram1111111111111111111', status: 'executed', decision: 'satisfied' } });
    await serve(page, [record], { [record.cid]: 'throw' }, [{ key: A, name: 'lifecycle-01' }]);
    await open(page, record.cid);
    const execution = page.locator('.lc-check', { hasText: 'The agreement executes on Solana' });
    await expect(execution).toContainText('retired version of the agreement program');
    await expect(page.locator('#lc-walkthrough')).not.toContainText('could not be read');
    await expect(page.locator('#lc-retry')).toBeHidden();
  });

  test('says a lens-free funding round has no lens and shows its funding progress', async ({ mockApi: page }) => {
    const record = agreement('Funding round', { lens: [], electorate: 'investors', onchain: { cluster: 'devnet', programId: PROGRAM, status: 'active', lenses: [], lensThreshold: 0, requiredFunding: '5000000' } });
    const account = { address: 'Acct2222222222222222222222222222222222222222', status: 'Active', lenses: [], lensThreshold: 0, lensConfirmed: [], decisionCode: 0, decisionAttestation: null, requiredFunding: 5_000_000, fundingObserved: 2_000_000, fundingMet: false };
    await serve(page, [record], { [record.cid]: { account, statement: null } }, []);
    await open(page, record.cid);
    await expect(page.locator('.lc-check', { hasText: 'The funding target is reached' })).toContainText('2 of 5 USDC');
    await expect(page.locator('.lc-check', { hasText: 'Lens members confirm' })).toContainText('No lens: the program checks the funding target itself.');
    await expect(page.locator('#lc-walkthrough')).not.toContainText('Awaiting');
  });

  test('shows an unminted agreement as waiting, and an unreadable chain with a retry', async ({ mockApi: page }) => {
    const pending = agreement('Pending agreement');
    const broken = agreement('Broken RPC', { onchain: { cluster: 'devnet', programId: PROGRAM, status: 'active', lenses: [A], lensThreshold: 1, lensConfirmed: [] } });
    await serve(page, [pending, broken], { [broken.cid]: 'throw' }, [{ key: A, name: 'lifecycle-01', serviceUrl: 'https://a.e2e.invalid' }]);
    await open(page, pending.cid);
    await expect(page.locator('.lc-check', { hasText: 'Owners approve' })).toContainText('No owner approvals have been relayed yet.');
    await expect(page.locator('.lc-check', { hasText: 'The agreement executes on Solana' })).toContainText('Not on Solana yet');
    await expect(page.locator(`#lc-lens-${A}`)).toContainText('No statement yet');

    await page.locator('#lc-agreement').selectOption(broken.cid);
    await expect(page.locator('.lc-check', { hasText: 'The agreement executes on Solana' })).toContainText('The Solana account could not be read');
    await expect(page.locator('#lc-retry')).toBeVisible();
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
    await open(page, a.cid);
    await page.locator('#lc-agreement').selectOption(b.cid);
    await expect(page.locator('#lc-subject')).toHaveText('Fast B');
    const stale = page.waitForResponse(response => response.url().endsWith(a.cid));
    release(); await stale;
    await expect(page.locator('#lc-subject')).toHaveText('Fast B');
  });
});
