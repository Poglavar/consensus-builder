import { test, expect } from '../helpers/fixtures';
import { cidOfObject } from '../../frontend/js/cid.js';

const content = { schema: 'agreement/v1', title: 'Library by the lake' };
const cid = cidOfObject(content);
const issuer = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const other = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
const address = '7sS9tUj78sj1ZZzv7B23jscazXAdNKDWhNsqjLEcAmSw';
const service = 'https://lens-a.e2e.invalid';
const otherService = 'https://lens-b.e2e.invalid';
const place = { backend: 'http://localhost:3099', city: 'alatau', at: '43.610624,77.025837,14' };
const members = [{ key: issuer, name: 'Lens A', serviceUrl: service }, { key: other, name: 'Lens B', serviceUrl: otherService }];
const decision = { address, kind: 'decision', authority: issuer, issuedAt: '2026-11-19T12:05:31.000Z',
  payload: { agreementCid: cid, sponsor: issuer, decision: 'satisfied', evidenceRef: 'case-1', sourceObservedAt: 1790000000 } };

const url = (params: Record<string, string>) => '/lens.html?' + new URLSearchParams({ ...place, ...params });

test('opens an issuer’s exact statement and retains the agreement and map context', async ({ mockApi: page }) => {
  await page.route('**/lenses/members', route => route.fulfill({ json: { members } }));
  await page.route(`**/agreements/${cid}`, route => route.fulfill({ json: { cid, content } }));
  await page.route(`${service}/lens/status`, route => route.fulfill({ json: { key: issuer, counts: { decision: 1 } } }));
  const requests: URL[] = [];
  await page.route(`${service}/lens/attestations**`, route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { attestations: [decision, { ...decision, authority: other }, { ...decision, authority: null }] } });
  });
  await page.goto(url({ member: issuer }));
  const feed = page.locator('#lc-attestations');
  await expect(feed.locator('.lc-item')).toHaveCount(1);
  await expect(feed).toContainText('The agreement’s approval rule was met.');
  const direct = feed.getByRole('link', { name: 'Open this statement' });
  const exact = new URL(await direct.getAttribute('href') as string, page.url());
  expect(Object.fromEntries(exact.searchParams)).toMatchObject({ ...place, member: issuer, attestation: address, subject: cid });
  await direct.click();
  await expect(feed.locator('.lc-item')).toHaveCount(1);
  await expect(feed).toContainText('case-1');
  await expect(feed.getByRole('link', { name: /Follow this agreement/ })).toContainText(content.title);
  await expect(feed.locator('time').first()).toHaveAttribute('datetime', decision.issuedAt);
  expect(requests.at(-1)?.searchParams.get('address')).toBe(address);
  expect(requests.at(-1)?.searchParams.get('agreementCid')).toBe(cid);
  const summary = feed.getByText('Statement details', { exact: true });
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(feed.getByText('case-1', { exact: true })).toBeHidden();
  const back = new URL(await feed.getByRole('link', { name: 'Follow this agreement' }).getAttribute('href') as string, page.url());
  expect(Object.fromEntries(back.searchParams)).toMatchObject({ ...place, agreement: cid });
});

test('keeps a slow member response out of another member’s results', async ({ mockApi: page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/lenses/members', route => route.fulfill({ json: { members } }));
  await page.route(`${service}/lens/status`, async route => { await gate; await route.fulfill({ json: { key: issuer } }); });
  await page.route(`${otherService}/lens/status`, route => route.fulfill({ status: 503, json: { message: 'offline' } }));
  await page.route(`${service}/lens/attestations**`, route => route.fulfill({ json: { attestations: [decision] } }));
  const firstRead = page.waitForRequest(`${service}/lens/status`);
  await page.goto(url({ view: 'members' })); await firstRead;
  await page.locator('#lc-directory').selectOption(otherService);
  const feed = page.locator('#lc-attestations');
  await expect(feed).toContainText('503');
  const staleRead = page.waitForResponse(`${service}/lens/status`);
  release(); await staleRead;
  await expect(feed).toContainText('503');
  await expect(feed.locator('.lc-item')).toHaveCount(0);
});

test('explains ownership, market observations and property qualifications in the issuer’s feed', async ({ mockApi: page }) => {
  await page.route('**/lenses/members', route => route.fulfill({ json: { members } }));
  await page.route(`${service}/lens/status`, route => route.fulfill({ json: { key: issuer, dryRun: true } }));
  const records = [
    { kind: 'ownership', address: issuer, payload: { owner: other, parcelUid: 'Alatau-17' } },
    { kind: 'evidence', address: other, payload: { subject: 'Planning decision', value: 'adopted' } },
    { kind: 'propertyOffer', address, payload: { cid, counterpartyQualified: 1 } }
  ].map(row => ({ ...row, authority: issuer }));
  await page.route(`${service}/lens/attestations**`, route => route.fulfill({ json: { attestations: records } }));
  await page.goto(url({ member: issuer }));
  const feed = page.locator('#lc-attestations');
  await expect(feed.locator('.lc-claim')).toHaveText([
    `${other} holds ownership rights on parcel Alatau-17.`,
    'Planning decision was reported as adopted.',
    `The counterparty qualified for offer ${cid}.`
  ]);
  await expect(feed.getByText('Simulated statement')).toHaveCount(3);
  await expect(feed.locator('a[href*="explorer.solana.com"]')).toHaveCount(0);
});

test('does not lend a listed lens member’s name to statements from an unlisted service', async ({ mockApi: page }) => {
  const rogue = 'https://rogue.e2e.invalid';
  await page.route('**/lenses/members', route => route.fulfill({ json: { members } }));
  await page.route(`${rogue}/lens/status`, route => route.fulfill({ json: { key: issuer, counts: { decision: 1 } } }));
  await page.route(`${rogue}/lens/attestations**`, route => route.fulfill({ json: { attestations: [decision] } }));
  await page.goto(url({ service: rogue }));
  const feed = page.locator('#lc-attestations');
  await expect(feed.locator('.lc-item')).toHaveCount(1);
  await expect(feed.locator('.lc-item')).toContainText(issuer);
  await expect(feed.locator('.lc-item')).not.toContainText('Lens A');
  await expect(feed.locator('.lc-item')).toContainText('Open the attestation on Solana to check it');
});
