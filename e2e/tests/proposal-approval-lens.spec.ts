// Purpose: four owners across three parcels accept a land readjustment only for themselves, through a
// real lens member process (backend/lens/run.mjs --rights) and wallet signatures, and their receipts
// still count after a reload. Parcel C is co-owned, so its area counts only once both owners accept.
// For a published proposal, two browsers share decisions through the relay's real handlers.
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { openCity, proposalState, showProposal } from '../helpers/runtime';
import { selectNativeOption } from '../helpers/controls';

const BACKEND = path.resolve(__dirname, '../../backend');
const PARCELS = { a: 'HR-335754-1234', b: 'HR-335754-1235', c: 'HR-335754-1236' };
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

type Wallet = { address: string; privateKey: KeyObject };
function wallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { address: base58(new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url'))), privateKey };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

// One plot per owner; the third is jointly owned by C and D. The plots tile the readjustment pool.
const strip = (x0: number, x1: number) => ({ type: 'Polygon', coordinates: [[[x0, 45.8], [x1, 45.8], [x1, 45.8002], [x0, 45.8002], [x0, 45.8]]] });
const POOL = strip(15.9819, 15.9821);

async function seedReadjustment(page: Page, memberKeys: string | string[], extra: Record<string, unknown> = {}): Promise<string> {
  return page.evaluate(({ parcels, pool, plots, member, extra }) => {
    const w = window as any;
    return w.proposalStorage.addProposal({
      title: 'Lens-backed readjustment',
      goal: 'reparcellization',
      lifecycleStatus: 'Active',
      funded: false,
      cadastreParcelIds: [parcels.a, parcels.b, parcels.c],
      acceptedParcelIds: [],
      approvalConfig: {
        schema: 'proposal-approval/v1',
        rights: { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'register-2026-10' }, parcels: [
          { parcelId: parcels.a, complete: true, areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
          { parcelId: parcels.b, complete: true, areaM2: 50, owners: [{ ownerId: 'owner-b', share: '1/1' }] },
          { parcelId: parcels.c, complete: true, areaM2: 25, owners: [{ ownerId: 'owner-c', share: '1/2' }, { ownerId: 'owner-d', share: '1/2' }] }
        ] },
        policy: { type: 'unanimous' }
      },
      lens: Array.isArray(member) ? member : [member],
      offer: 25,
      offerCurrency: 'EUR',
      isConditional: true,
      reparcellization: {
        poolGeometry: pool,
        poolSource: 'site',
        contributionBasis: 'area',
        polygons: [
          { geometry: plots[0], jointPool: false, owners: [{ ownerKey: 'owner-a', share: 1 }] },
          { geometry: plots[1], jointPool: false, owners: [{ ownerKey: 'owner-b', share: 1 }] },
          { geometry: plots[2], jointPool: true, owners: [{ ownerKey: 'owner-c', share: 0.5 }, { ownerKey: 'owner-d', share: 0.5 }] }
        ],
        ownerShares: [
          // Owner A pays for land beyond its entitlement; the sponsor covers the rest (20.00).
          { ownerKey: 'owner-a', cashOffer: 0, cashPayment: 5, contributedArea: 100 },
          { ownerKey: 'owner-b', cashOffer: 10, contributedArea: 50 },
          { ownerKey: 'owner-c', cashOffer: 7.5, contributedArea: 12.5 },
          { ownerKey: 'owner-d', cashOffer: 7.5, contributedArea: 12.5 }
        ]
      },
      // Last, so a scenario can replace the approval setup (a scheme with an authority).
      ...extra
    });
  }, { parcels: PARCELS, pool: POOL, plots: [strip(15.9819, 15.98197), strip(15.98197, 15.98204), strip(15.98204, 15.9821)], member: memberKeys, extra });
}

async function establishLocalProfile(page: Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Lens approval fixture');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

// A Phantom-shaped provider whose account the test switches; signatures come from keys held here.
async function installSwitchableWallet(page: Page, wallets: Record<string, Wallet>): Promise<void> {
  const keyOf = (address: string) => {
    const owner = Object.values(wallets).find(entry => entry.address === address);
    if (!owner) throw new Error(`No test key for ${address}`);
    return owner.privateKey;
  };
  await page.exposeFunction('__e2eWalletSign', (address: string, text: string) => [...sign(null, Buffer.from(text, 'utf8'), keyOf(address))]);
  await page.exposeFunction('__e2eWalletSignBytes', (address: string, bytes: number[]) => [...sign(null, Buffer.from(bytes), keyOf(address))]);
  await page.addInitScript(() => {
    const w = window as any;
    w.__e2eWallet = { current: null as string | null, signed: [] as Array<{ address: string; text: string }> };
    const key = (value: string) => ({ toString: () => value, toBase58: () => value });
    w.solana = {
      isPhantom: true,
      get publicKey() { return w.__e2eWallet.current ? key(w.__e2eWallet.current) : null; },
      connect: async (options?: { onlyIfTrusted?: boolean }) => {
        if (options?.onlyIfTrusted || !w.__e2eWallet.current) throw new Error('Not connected');
        return { publicKey: key(w.__e2eWallet.current) };
      },
      disconnect: async () => {},
      signMessage: async (bytes: Uint8Array) => {
        const text = new TextDecoder().decode(bytes);
        w.__e2eWallet.signed.push({ address: w.__e2eWallet.current, text });
        return { signature: Uint8Array.from(await w.__e2eWalletSign(w.__e2eWallet.current, text)) };
      },
      // Signs a web3.js Transaction as the fee payer, like a real wallet would.
      signTransaction: async (transaction: any) => {
        const message = [...transaction.serializeMessage()];
        transaction.addSignature(transaction.feePayer, Uint8Array.from(await w.__e2eWalletSignBytes(w.__e2eWallet.current, message)));
        return transaction;
      },
      on: () => {},
      off: () => {}
    };
  });
}

async function useWallet(page: Page, address: string): Promise<void> {
  await page.evaluate(async next => {
    const w = window as any;
    await w.solanaWalletManager.disconnect();
    w.__e2eWallet.current = next;
    await w.solanaWalletManager.connect('solana-phantom');
  }, address);
}

async function openLand(page: Page, proposalId: string): Promise<void> {
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  const land = panel.locator('details[data-proposal-section="land"]');
  if (!(await land.evaluate(element => (element as HTMLDetailsElement).open))) await land.locator(':scope > summary').click();
  await expect(panel.locator('[data-approval-card]')).toBeVisible();
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

const card = (page: Page) => page.locator('#proposal-details-panel [data-approval-card]');
const dialog = (page: Page) => page.locator('#proposal-approval-dialog .cb-dialog');

// Verify the connected wallet with the lens member, then review and accept for the one owner it acts for.
async function verifyAndAccept(page: Page, owner: string, testInfo?: TestInfo, shared?: 'yes' | 'no'): Promise<void> {
  await card(page).locator('[data-approval-action="verify"]').click();
  await expect(dialog(page).locator('[data-approval-member]')).toHaveValue(/.+/);
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await expect(dialog(page).locator('[data-approval-verified]')).toHaveAttribute('data-approval-verified', `owner-${owner}`);
  await expect(dialog(page)).toContainText(`can act for Owner ${owner.toUpperCase()}.`);
  await dialog(page).getByRole('button', { name: `Review and accept as Owner ${owner.toUpperCase()}` }).click();
  await expect(dialog(page)).toHaveAttribute('data-approval-review', `owner-${owner}`);
  if (testInfo) await screenshot(page, testInfo, `review-owner-${owner}`);
  await dialog(page).locator(`[data-approval-accept="owner-${owner}"]`).click();
  await expect(dialog(page)).toHaveAttribute('data-approval-receipt', `owner-${owner}`);
  await expect(dialog(page).locator('.cb-dialog__title')).toHaveText(`Accepted as Owner ${owner.toUpperCase()}`);
  if (shared) await expect(dialog(page).locator(`[data-approval-receipt-shared="${shared}"]`)).toBeVisible();
  if (testInfo) await screenshot(page, testInfo, `receipt-owner-${owner}`);
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('#proposal-approval-dialog')).toHaveCount(0);
}

const children: ChildProcess[] = [];
test.afterEach(async () => {
  await Promise.all(children.splice(0).filter(child => child.exitCode === null).map(child => {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    return stopped;
  }));
});

// Starts a node process from backend/ and waits until `url` answers 200.
async function startBackendProcess(args: string[], url: string, env: Record<string, string> = {}): Promise<void> {
  const log: string[] = [];
  const child = spawn(process.execPath, args, { cwd: BACKEND, env: { ...process.env, ...env } });
  children.push(child);
  child.stdout!.on('data', chunk => log.push(String(chunk)));
  child.stderr!.on('data', chunk => log.push(String(chunk)));
  await expect.poll(async () => {
    try { return (await fetch(url)).status; } catch { return 0; }
  }, { timeout: 20_000, message: () => `${args.join(' ')} did not start:\n${log.join('')}` }).toBe(200);
}

type Signer = { ownerId: string; wallet: string };
type Authority = { authorityId: string; parcelIds: string[] };
// A dry-run lens member with this rights registry (and the authorities it knows); returns its key and service URL.
async function startMember(testInfo: TestInfo, signers: Signer[], name = 'lens-member', authorities: Authority[] = []): Promise<{ memberKey: string; serviceUrl: string }> {
  const dir = testInfo.outputPath(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'owners.json'), '[]');
  writeFileSync(path.join(dir, 'rights.json'), JSON.stringify({
    schema: 'lens-rights-registry/v1',
    parcels: [
      { parcelId: PARCELS.a, areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
      { parcelId: PARCELS.b, areaM2: 50, owners: [{ ownerId: 'owner-b', share: '1/1' }] },
      { parcelId: PARCELS.c, areaM2: 25, owners: [{ ownerId: 'owner-c', share: '1/2' }, { ownerId: 'owner-d', share: '1/2' }] }
    ],
    ...(authorities.length ? { authorities } : {}),
    signers
  }));
  const port = await freePort();
  const serviceUrl = `http://127.0.0.1:${port}`;
  await startBackendProcess(['lens/run.mjs', '--dry-run', '--owners', path.join(dir, 'owners.json'),
    '--rights', path.join(dir, 'rights.json'), '--port', String(port)], `${serviceUrl}/lens/status`);
  return { memberKey: (await (await fetch(`${serviceUrl}/lens/status`)).json()).key, serviceUrl };
}

test('choosing the second approval member verifies and records an owner receipt through that member', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(120_000);
  const wallets = { a: wallet(), stranger: wallet() };
  // Both members know Owner A, but only the second recognizes the connected wallet.
  const first = await startMember(testInfo, [{ ownerId: 'owner-a', wallet: wallets.stranger.address }], 'lens-member-first');
  const second = await startMember(testInfo, [{ ownerId: 'owner-a', wallet: wallets.a.address }], 'lens-member-second');
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: first.memberKey, kind: 'owner-consent', name: 'First notary', serviceUrl: first.serviceUrl },
    { key: second.memberKey, kind: 'owner-consent', name: 'Second notary', serviceUrl: second.serviceUrl },
  ] } }));
  await page.route(`${first.serviceUrl}/lens/approval/**`, route => {
    firstCalls.push(new URL(route.request().url()).pathname);
    return route.continue();
  });
  await page.route(`${second.serviceUrl}/lens/approval/**`, route => {
    secondCalls.push(new URL(route.request().url()).pathname);
    return route.continue();
  });
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>'
  }));
  await installSwitchableWallet(page, wallets);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const proposalId = await seedReadjustment(page, [first.memberKey, second.memberKey]);
  expect(await page.evaluate(id => {
    const w = window as any;
    return !!w.currentConsentBindingHash(w.proposalStorage.getProposal(id));
  }, proposalId), 'the seeded readjustment must be valid for both lens members').toBe(true);

  await useWallet(page, wallets.a.address);
  await openLand(page, proposalId);
  await card(page).locator('[data-approval-action="verify"]').click();
  const memberSelect = dialog(page).locator('[data-approval-member]');
  await expect(memberSelect.locator('option')).toHaveCount(2);
  const memberKeys = await memberSelect.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  const selectedBefore = await memberSelect.inputValue();
  expect(memberKeys).toContain(second.memberKey);
  const firstChange = selectedBefore === second.memberKey
    ? memberKeys.find(memberKey => memberKey !== second.memberKey)!
    : second.memberKey;
  // Force a genuine first selection change even if directory ordering selected the second service
  // by default, then finish on the service whose receipt is asserted below.
  await selectNativeOption(memberSelect, firstChange);
  await expect(memberSelect).toHaveValue(firstChange);
  if (firstChange !== second.memberKey) await selectNativeOption(memberSelect, second.memberKey);
  await expect(memberSelect).toHaveValue(second.memberKey);
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await expect(dialog(page).locator('[data-approval-verified]')).toHaveAttribute('data-approval-verified', 'owner-a');
  expect(firstCalls).toEqual([]);
  expect(secondCalls).toEqual(['/lens/approval/challenge', '/lens/approval/authority']);

  await dialog(page).getByRole('button', { name: 'Review and accept as Owner A' }).click();
  await expect(dialog(page)).toHaveAttribute('data-approval-review', 'owner-a');
  await dialog(page).locator('[data-approval-accept="owner-a"]').click();
  await expect(dialog(page)).toHaveAttribute('data-approval-receipt', 'owner-a');
  await expect(dialog(page).locator('.cb-dialog__title')).toHaveText('Accepted as Owner A');
});

// The relay's real handlers (backend/proposals/owner-decisions.js) over the in-memory store, serving
// the published proposal written to `file`.
const RELAY_SCRIPT = `
import express from 'express';
import { readFileSync } from 'node:fs';
import { createMemoryOwnerDecisionStore, createOwnerDecisionHandlers } from './proposals/owner-decisions.js';
import { createHash } from 'node:crypto';
// Pinned bundles, served back at /ipfs/:cid as a public gateway would.
const pins = new Map();
const handlers = createOwnerDecisionHandlers({ store: createMemoryOwnerDecisionStore(), async loadProposal(id) {
  const proposal = JSON.parse(readFileSync(process.env.RELAY_PROPOSAL_FILE, 'utf8'));
  return id === proposal.serverProposalId ? proposal : null;
}, async pinJson(bundle) {
  const cid = 'bafke2e' + createHash('sha256').update(JSON.stringify(bundle)).digest('hex').slice(0, 40);
  pins.set(cid, bundle);
  return 'ipfs://' + cid;
} });
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/ipfs/:cid', (req, res) => (pins.has(req.params.cid) ? res.json(pins.get(req.params.cid)) : res.status(404).end()));
app.get('/proposals/:id/owner-decisions', handlers.get);
app.post('/proposals/:id/owner-decisions', handlers.post);
app.post('/proposals/:id/owner-decisions/bundle', handlers.bundle);
app.listen(Number(process.env.RELAY_PORT), '127.0.0.1');
`;
async function startRelay(testInfo: TestInfo): Promise<{ url: string; file: string }> {
  const file = testInfo.outputPath('published-proposal.json');
  writeFileSync(file, '{}');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  await startBackendProcess(['--input-type=module', '-e', RELAY_SCRIPT], `${url}/health`, { RELAY_PROPOSAL_FILE: file, RELAY_PORT: String(port) });
  return { url, file };
}

test('four owners across three parcels accept only for themselves through a lens member', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(120_000);
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet(), stranger: wallet() };
  const { memberKey, serviceUrl } = await startMember(testInfo, (['a', 'b', 'c', 'd'] as const).map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })));
  const status = await (await fetch(`${serviceUrl}/lens/status`)).json();
  expect(status.approval).toMatchObject({ enabled: true, parcels: 3, owners: 4, signers: 4 });

  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }
  ] } }));
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>'
  }));
  await installSwitchableWallet(page, wallets);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const proposalId = await seedReadjustment(page, memberKey);
  expect(await page.evaluate(id => {
    const w = window as any;
    return !!w.currentConsentBindingHash(w.proposalStorage.getProposal(id));
  }, proposalId), 'the seeded readjustment must be valid').toBe(true);

  await openLand(page, proposalId);
  await expect(card(page)).toContainText('Not enough yet');
  await expect(card(page)).toContainText('Every owner must accept.');
  await expect(card(page).locator('[data-approval-local-only]')).toHaveText('Acceptances stay in this browser until the proposal is published.');
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('0 of 4 accepted');
  await expect(card(page).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner A, Owner B, Owner C, Owner D');
  await expect(card(page).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('Owner C, Owner D have all accepted (0 of 2 so far)');
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'card-before');

  // Owner A, through the per-parcel Accept button: the review always comes before any signature.
  await useWallet(page, wallets.a.address);
  const rowA = page.locator(`#proposal-details-panel .proposal-parcel-item[data-parcel-id="${PARCELS.a}"] .owner-acceptance-row[data-owner-key="owner-a"]`);
  await expect(rowA).toBeVisible();
  await expect(rowA.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await card(page).locator('[data-approval-action="verify"]').click();
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await expect(dialog(page).locator('[data-approval-verified]')).toHaveAttribute('data-approval-verified', 'owner-a');
  await screenshot(page, testInfo, 'verified-owner-a');
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Close', exact: true }).click();
  await rowA.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(dialog(page)).toHaveAttribute('data-approval-review', 'owner-a');
  await expect(dialog(page).locator(`[data-approval-contribution="${PARCELS.a}"]`)).toContainText('Your share 1/1');
  await expect(dialog(page).locator('[data-approval-plot="1"]')).toContainText('100%');
  await expect(dialog(page).locator('[data-approval-cash="pays"]')).toContainText('Cash you pay');
  await expect(dialog(page).locator('[data-approval-cash="pays"]')).toContainText('5.00');
  await expect(dialog(page)).toContainText(/Owners receive 25\.00\sEUR and pay 5\.00\sEUR in total\./);
  await expect(dialog(page)).toContainText(/The sponsor pays 20\.00\sEUR\./);
  await screenshot(page, testInfo, 'review-owner-a');
  expect(await page.evaluate(() => (window as any).__e2eWallet.signed.filter((entry: any) =>
    entry.text.startsWith('Urban Game Theory owner decision')).length), 'nothing is signed before the review').toBe(0);
  await dialog(page).locator('[data-approval-accept="owner-a"]').click();
  await expect(dialog(page)).toHaveAttribute('data-approval-receipt', 'owner-a');
  await expect(dialog(page).locator('[data-approval-receipt-progress]')).toContainText('1 of 4 owners');
  await expect(dialog(page).locator('[data-approval-receipt-shared="no"]')).toHaveText('Saved in this browser only: the proposal is not published yet.');
  await screenshot(page, testInfo, 'receipt-owner-a');
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('1 of 4 accepted');
  await expect(rowA.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();

  // Owner C can act only for C: no button for D, and the direct handler offers no Accept for D.
  await useWallet(page, wallets.c.address);
  await verifyAndAccept(page, 'c');
  await expect(card(page).locator('[data-approval-action="review"][data-owner-id="owner-d"]')).toHaveCount(0);
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('100');
  await expect(card(page).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('(1 of 2 so far)');
  await page.evaluate(({ id, parcel }) => (window as any).acceptProposalFromParcelInfo(id, parcel, 'owner-d', { skipParcelPanelFocus: true }),
    { id: proposalId, parcel: PARCELS.c });
  await expect(dialog(page)).toHaveAttribute('data-approval-review', 'owner-d');
  await expect(dialog(page).locator('[data-approval-review-status]')).toContainText('first confirm with a lens member');
  await expect(dialog(page).locator('[data-approval-accept]')).toHaveCount(0);
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Act for an owner', exact: true }).click();
  await expect(dialog(page).locator('[data-approval-verify-submit]')).toBeVisible();
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#proposal-approval-dialog')).toHaveCount(0);

  // A wallet the member does not know learns nothing and can accept for nobody.
  await useWallet(page, wallets.stranger.address);
  await card(page).locator('[data-approval-action="verify"]').click();
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await expect(dialog(page).locator('.approval-dialog__status')).toHaveText('This lens member does not recognize this wallet as acting for any owner of this proposal.');
  await dialog(page).locator('.close-circle-btn').click();
  await expect(page.locator('#proposal-approval-dialog')).toHaveCount(0);

  await useWallet(page, wallets.d.address);
  await verifyAndAccept(page, 'd');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('125');
  await expect(card(page).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('(2 of 2 so far)');

  await useWallet(page, wallets.b.address);
  await verifyAndAccept(page, 'b');
  await expect(card(page)).toContainText('Enough to pass');
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('4 of 4 accepted');
  await expect(card(page).locator('[data-approval-outstanding]')).toHaveText('Every owner has accepted.');
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'card-passed');

  // The same wallet withdraws (a signed withdrawal), then accepts again; outside debug mode too.
  await page.evaluate(() => document.body.classList.remove('debug-mode'));
  const withdraw = card(page).locator('[data-approval-action="withdraw"][data-owner-id="owner-b"]');
  await expect(withdraw).toBeVisible();
  await withdraw.click();
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('3 of 4 accepted');
  await expect(card(page)).toContainText('Not enough yet');
  await expect(card(page).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner B');
  await card(page).locator('[data-approval-action="review"][data-owner-id="owner-b"]').click();
  await dialog(page).locator('[data-approval-accept="owner-b"]').click();
  await expect(dialog(page)).toHaveAttribute('data-approval-receipt', 'owner-b');
  await expect(dialog(page)).toContainText('The proposal now has enough acceptances to pass.');
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page)).toContainText('Enough to pass');

  const stored = await proposalState(page, proposalId);
  for (const id of ['a', 'b', 'c', 'd'] as const) {
    expect(stored.ownerApprovals[`owner-${id}`]).toMatchObject({
      ownerId: `owner-${id}`, actorId: wallets[id].address, providerId: 'lens-wallet', decision: 'approve',
      decisionProof: { scheme: 'ed25519-wallet/v1' },
      evidence: { rights: { member: memberKey }, authority: { member: memberKey, ownerId: `owner-${id}`, actorId: wallets[id].address } }
    });
  }
  expect(stored.lifecycleStatus).toBe('Active'); // Passed, but the unfunded cash keeps it from executing.
  expect(stored.ownerApprovalHistory.map((receipt: any) => [receipt.ownerId, receipt.decision]))
    .toEqual([['owner-b', 'approve'], ['owner-b', 'withdraw']]);
  const signed = await page.evaluate(() => (window as any).__e2eWallet.signed);
  const decisions = signed.filter((entry: any) => entry.text.startsWith('Urban Game Theory owner decision'));
  expect(decisions.map((entry: any) => entry.address)).toEqual([wallets.a.address, wallets.c.address, wallets.d.address,
    wallets.b.address, wallets.b.address, wallets.b.address]);
  expect(decisions[4].text).toContain(`Withdraw the acceptance of proposal ${proposalId} as owner owner-b.`);

  // Reload with no wallet connected and no evidence cache: every receipt verifies from its signatures.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).proposalStorage && !!(window as any).ProposalApprovalPanel);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openLand(page, proposalId);
  await expect(card(page)).toContainText('Enough to pass');
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('4 of 4 accepted');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    '390px viewport must not scroll horizontally').toBe(false);
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'card-after-reload-390');
});

test('the review shows what an owner contributes, gets back and signs, on a phone', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(90_000);
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet() };
  const { memberKey, serviceUrl } = await startMember(testInfo, [{ ownerId: 'owner-c', wallet: wallets.c.address }]);
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }
  ] } }));
  await installSwitchableWallet(page, wallets);
  await page.setViewportSize({ width: 390, height: 844 });
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const proposalId = await seedReadjustment(page, memberKey);
  await openLand(page, proposalId);
  await useWallet(page, wallets.c.address);
  await card(page).locator('[data-approval-action="verify"]').click();
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await dialog(page).getByRole('button', { name: 'Review and accept as Owner C' }).click();

  const review = dialog(page);
  await expect(review.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('Your share 1/2');
  await expect(review.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('co-owned with Owner D');
  await expect(review.locator('[data-approval-plot="3"]')).toContainText('50%');
  await expect(review.locator('[data-approval-plot="3"]')).toContainText('shared with Owner D');
  await expect(review.locator('[data-approval-cash="receives"]')).toContainText('7.50');
  await expect(review).toContainText('All owners must accept before payout');
  await expect(review).toContainText('The cash is not funded yet');
  await expect(review).toContainText('attested by: Test notary');
  await expect(review.locator('[data-approval-progress-with]')).toContainText('1 of 4 owners');
  await expect(review).toContainText('More owners must accept after you before it passes.');
  const bounds = await review.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await screenshot(page, testInfo, 'review-owner-c-390');

  // Cancelling leaves nothing signed and nothing recorded.
  await review.locator('.cb-dialog__footer').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await proposalState(page, proposalId)).ownerApprovals || {}).toEqual({});
  expect(await page.evaluate(() => (window as any).__e2eWallet.signed.filter((entry: any) => entry.text.startsWith('Urban Game Theory owner decision')).length)).toBe(0);
});

// Anyone can read each owner's deal from the card: no wallet, no lens member, nothing signed. The
// owner (or whoever acts for them) goes on from there to the signing review.
// A real scheme (land-readjustmend.md §23): Catalonia's basic compensation needs more than half the
// area, then the municipality's approval. Owners are counted by area only, the authority decides
// through the same lens-backed wallet path, and the card says which of the two is still missing.
test('a scheme with an authority: owner support by area, then the municipality approves through the lens', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(120_000);
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet(), city: wallet() };
  const { memberKey, serviceUrl } = await startMember(testInfo, [
    ...(['a', 'b', 'c', 'd'] as const).map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })),
    { ownerId: 'ajuntament', wallet: wallets.city.address }
  ], 'lens-member', [{ authorityId: 'ajuntament', parcelIds: [PARCELS.a, PARCELS.b, PARCELS.c] }]);
  expect((await (await fetch(`${serviceUrl}/lens/status`)).json()).approval).toMatchObject({ parcels: 3, owners: 4, authorities: 1, signers: 5 });
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [{ key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }] } }));
  await page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>'
  }));
  await installSwitchableWallet(page, wallets);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const version = await page.evaluate(() => (window as any).ProposalApprovalRegimes.latest('es-ct-basic').version);
  const proposalId = await seedReadjustment(page, memberKey, {
    approvalConfig: {
      schema: 'proposal-approval/v1',
      rights: { schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'register-2026-10' }, parcels: [
        { parcelId: PARCELS.a, complete: true, areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
        { parcelId: PARCELS.b, complete: true, areaM2: 50, owners: [{ ownerId: 'owner-b', share: '1/1' }] },
        { parcelId: PARCELS.c, complete: true, areaM2: 25, owners: [{ ownerId: 'owner-c', share: '1/2' }, { ownerId: 'owner-d', share: '1/2' }] }
      ] },
      policy: { type: 'rules', tests: [{ measure: 'area', of: 'owners', scope: 'all', numerator: 1, denominator: 2, strict: true }], authorities: [{ authorityId: 'ajuntament' }] },
      regime: { id: 'es-ct-basic', version }
    }
  });

  await openLand(page, proposalId);
  await expect(card(page).locator('[data-approval-regime="es-ct-basic"]')).toContainText('Catalonia — basic compensation');
  await expect(card(page).locator('[data-approval-regime="es-ct-basic"]')).toContainText('Research template');
  await expect(card(page).locator('.approval-card__rule')).toHaveText('Passes with more than 1/2 of the area, and needs the municipality’s approval of the compensation project.');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('Needs more than 87.5');
  // Heads are not a test here: owners are shown, not counted.
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('Heard, not counted');
  await expect(card(page).locator('[data-approval-authority="ajuntament"]')).toHaveAttribute('data-approval-authority-state', 'pending');
  await expect(card(page)).toContainText('Not enough yet');
  await screenshot(page, testInfo, 'scheme-card-before');

  // Owner A alone holds 100 of 175 m²: the area test is met and only the authority is missing.
  await useWallet(page, wallets.a.address);
  await verifyAndAccept(page, 'a');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('100');
  await expect(card(page).locator('[data-approval-awaiting-authority]')).toHaveText('Awaiting the authority');
  await expect(card(page).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner B, Owner C, Owner D');

  // The municipality's wallet is confirmed by the same lens member and approves the whole plan.
  await useWallet(page, wallets.city.address);
  await card(page).locator('[data-approval-action="verify"]').click();
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await expect(dialog(page).locator('[data-approval-verified]')).toHaveAttribute('data-approval-verified', 'ajuntament');
  await expect(dialog(page)).toContainText('can act for Authority.');
  await dialog(page).getByRole('button', { name: 'Review and accept as Authority' }).click();
  await expect(dialog(page)).toHaveAttribute('data-approval-review', 'ajuntament');
  await expect(dialog(page).locator('.cb-dialog__title')).toHaveText('Approve as Authority');
  await expect(dialog(page).locator('[data-approval-plan]')).toContainText('Parcels');
  await expect(dialog(page)).toContainText('Catalonia — basic compensation');
  await screenshot(page, testInfo, 'scheme-review-authority');
  await dialog(page).locator('[data-approval-accept="ajuntament"]').click();
  await expect(dialog(page)).toHaveAttribute('data-approval-receipt', 'ajuntament');
  await expect(dialog(page).locator('.cb-dialog__title')).toHaveText('Accepted as Authority');
  await expect(dialog(page).locator('[data-approval-receipt-progress]')).toContainText('authority approved');
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page)).toContainText('Enough to pass');
  await expect(card(page).locator('[data-approval-authority="ajuntament"]')).toHaveAttribute('data-approval-authority-state', 'approved');
  await screenshot(page, testInfo, 'scheme-card-passed');

  const stored = await proposalState(page, proposalId);
  expect(stored.ownerApprovals.ajuntament).toMatchObject({ ownerId: 'ajuntament', actorId: wallets.city.address, decision: 'approve',
    evidence: { authority: { member: memberKey, ownerId: 'ajuntament' } } });
  expect(stored.approvalConfig.regime).toEqual({ id: 'es-ct-basic', version });
});

test('each owner\'s deal is readable by anyone from the Owner acceptance card', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(60_000);
  const member = wallet().address;
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: member, kind: 'owner-consent', name: 'Test notary' }
  ] } }));
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const proposalId = await seedReadjustment(page, member);
  await openLand(page, proposalId);

  const owners = card(page).locator('[data-approval-deals] [data-approval-action="inspect"]');
  await expect(owners).toHaveText(['Owner A', 'Owner B', 'Owner C', 'Owner D']);
  await owners.filter({ hasText: 'Owner D' }).click();

  const deal = dialog(page);
  await expect(deal.locator('.cb-dialog__title')).toHaveText('Owner D’s deal');
  await expect(deal).toContainText('Proposed contribution from Owner D');
  await expect(deal.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('Share 1/2');
  await expect(deal.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('co-owned with Owner C');
  await expect(deal).toContainText('Proposed allocation to Owner D');
  await expect(deal.locator('[data-approval-plot="3"]')).toContainText('shared with Owner C');
  await expect(deal.locator('[data-approval-cash="receives"]')).toContainText('Cash offered');
  await expect(deal.locator('[data-approval-cash="receives"]')).toContainText('7.50');
  await expect(deal.locator('[data-approval-progress-with]')).toContainText('With Owner D’s acceptance: 1 of 4 owners');
  await expect(deal).toContainText('Selected verification lens: Test notary');
  await expect(deal).toContainText('Declared rights source:');
  await expect(deal).not.toContainText('is attested by');
  // Read-only: nothing here signs.
  await expect(deal).not.toContainText('Your wallet signs these exact terms');
  await screenshot(page, testInfo, 'deal-owner-d');

  await deal.locator('[data-approval-deal-accept="owner-d"]').click();
  const review = dialog(page);
  await expect(review.locator('.cb-dialog__title')).toHaveText('Accept as Owner D');
  await expect(review).toContainText('Your share 1/2');
  await expect(review).toContainText('Your proposed allocation');
  await expect(review).toContainText('Selected verification lens: Test notary');
  await expect(review).not.toContainText('are attested by');
  await expect(review.locator('[data-approval-review-status]')).toContainText('first confirm with a lens member');
  expect((await proposalState(page, proposalId)).ownerApprovals || {}).toEqual({});
});

// Where the readjustment stands on the map, an owner's deal shows that owner's land on the
// before/after divider: their parcels before, their plots after.
test('an owner\'s deal on an applied readjustment shows that owner\'s land on the before/after divider', async ({ mockApi: page }) => {
  test.setTimeout(60_000);
  const member = wallet().address;
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: member, kind: 'owner-consent', name: 'Test notary' }
  ] } }));
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const proposalId = await seedReadjustment(page, member);
  await page.evaluate((id: string) => (window as any).ProposalManager.applyProposal(id), proposalId);
  await expect.poll(() => page.evaluate((id: string) => (window as any).isProposalCurrentlyApplied((window as any).getProposalByIdOrHash(id)), proposalId), { timeout: 30_000 }).toBe(true);
  await openLand(page, proposalId);

  await card(page).locator('[data-approval-deals] [data-approval-action="inspect"]').filter({ hasText: 'Owner D' }).click();
  const deal = dialog(page);
  await expect(deal.locator('.cb-dialog__title')).toHaveText('Owner D’s deal');
  await deal.locator('[data-approval-show-map="owner-d"]').click();
  await expect(deal).toHaveCount(0);
  await expect(page.locator('#map .map-compare__before')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as any).ProposalBeforeAfter.activeFocus())).toBe('owner:owner-d');
  expect(await page.evaluate(() => (window as any).ProposalBeforeAfter.activeKey())).toBe(proposalId);
});

// A second device: its own browser context, the same mocked API, lens member, relay and wallets.
async function secondBrowser(browser: Browser, baseURL: string | undefined, setup: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try { localStorage.setItem('cb_site_intro_seen_v1', '1'); } catch (_) { /* opaque origin */ }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockAllApiRoutes(page);
  await setup(page);
  return { context, page, errors };
}

test('two browsers share owner decisions through the relay, and each verifies them', async ({ mockApi: page, browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet() };
  const { memberKey, serviceUrl } = await startMember(testInfo, (['a', 'b', 'c', 'd'] as const).map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })));
  const relay = await startRelay(testInfo);
  const published = { proposalId: 'lr-relay-e2e', serverProposalId: '41' };
  const setup = async (target: Page) => {
    await target.route('**/lenses/members', route => route.fulfill({ json: { members: [
      { key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }
    ] } }));
    // Registered after the API mocks, so the relay's real handlers answer these two routes.
    await target.route(/\/proposals\/41\/owner-decisions(\?.*)?$/, async route => route.fulfill({
      response: await route.fetch({ url: `${relay.url}/proposals/41/owner-decisions` })
    }));
    await installSwitchableWallet(target, wallets);
    await openCity(target);
    await target.evaluate(() => (window as any).i18n.setLanguage('en'));
    await establishLocalProfile(target);
    expect(await seedReadjustment(target, memberKey, published)).toBe(published.proposalId);
  };
  await setup(page);
  // What the server would serve for the published record.
  const record = await proposalState(page, published.proposalId);
  writeFileSync(relay.file, JSON.stringify({ ...published, lifecycleStatus: 'Active', cadastreParcelIds: record.cadastreParcelIds,
    approvalConfig: record.approvalConfig, lens: record.lens }));

  // Browser 1: Owners A and C accept; each receipt says it was shared.
  await openLand(page, published.proposalId);
  await expect(card(page).locator('[data-approval-local-only]')).toHaveCount(0);
  await useWallet(page, wallets.a.address);
  await verifyAndAccept(page, 'a', testInfo, 'yes');
  await useWallet(page, wallets.c.address);
  await verifyAndAccept(page, 'c', undefined, 'yes');
  await expect(dialog(page)).toHaveCount(0);
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted');

  // Browser 2 opens the same proposal: both acceptances arrive and count after its own verification.
  const second = await secondBrowser(browser, baseURL, setup);
  try {
    const other = second.page;
    await openLand(other, published.proposalId);
    await expect(card(other).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted');
    await expect(card(other).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('(1 of 2 so far)');
    await expect(card(other).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner B, Owner D');
    await card(other).scrollIntoViewIfNeeded();
    await screenshot(other, testInfo, 'second-browser-synced');
    const synced = await proposalState(other, published.proposalId);
    expect(Object.keys(synced.ownerApprovals).sort()).toEqual(['owner-a', 'owner-c']);
    expect(synced.ownerApprovals['owner-c'].actorId).toBe(wallets.c.address);
    // Owners D and B accept there; parcel C now counts.
    await useWallet(other, wallets.d.address);
    await verifyAndAccept(other, 'd', undefined, 'yes');
    await useWallet(other, wallets.b.address);
    await verifyAndAccept(other, 'b', undefined, 'yes');
    await expect(card(other)).toContainText('Enough to pass');
    await expect(card(other).locator('[data-approval-meter="owners"]')).toContainText('4 of 4 accepted');
    expect(second.errors).toEqual([]);
  } finally {
    await second.context.close();
  }

  // The relay holds exactly the four signed decisions.
  const relayed = await (await fetch(`${relay.url}/proposals/41/owner-decisions`)).json();
  expect(relayed.decisions.map((row: any) => row.ownerId)).toEqual(['owner-a', 'owner-c', 'owner-d', 'owner-b']);

  // Browser 1 returns later and catches up from the relay.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).proposalStorage && !!(window as any).ProposalApprovalPanel);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openLand(page, published.proposalId);
  await expect(card(page)).toContainText('Enough to pass');
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('4 of 4 accepted');
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'first-browser-caught-up');
});

// Sends real devnet transactions (a funding transfer and one memo), so it runs only on request:
// E2E_DEVNET=1, paid from SOLANA_KEYPAIR (default: the Solana CLI keypair).
test('a minted proposal anchors its owner decisions on chain, and a browser without the relay recovers them', async ({ mockApi: page, browser, baseURL }, testInfo) => {
  test.skip(!process.env.E2E_DEVNET, 'set E2E_DEVNET=1 to send devnet transactions');
  test.setTimeout(240_000);
  const web3 = createRequire(`${BACKEND}/`)('@solana/web3.js');
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet() };
  const funder = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(
    process.env.SOLANA_KEYPAIR || path.join(os.homedir(), '.config', 'solana', 'id.json'), 'utf8'))));
  const devnet = new web3.Connection('https://api.devnet.solana.com', 'confirmed');
  await web3.sendAndConfirmTransaction(devnet, new web3.Transaction().add(web3.SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: new web3.PublicKey(wallets.a.address), lamports: 10_000_000
  })), [funder]);

  const { memberKey, serviceUrl } = await startMember(testInfo, (['a', 'b', 'c', 'd'] as const).map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })));
  const relay = await startRelay(testInfo);
  const program = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
  const account = web3.Keypair.generate().publicKey.toBase58();
  const published = {
    proposalId: 'lr-anchor-e2e', serverProposalId: '42',
    onchain: { chainId: 'solana-devnet', proposalId: account, contractAddress: program },
    nft: { chain: 'solana-devnet', contract: program, tokenId: account }
  };
  const setup = (withRelay: boolean) => async (target: Page) => {
    await target.route('**/lenses/members', route => route.fulfill({ json: { members: [
      { key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }
    ] } }));
    // Public IPFS gateways answer from the bundles the relay pinned.
    await target.route(/^https:\/\/(gateway\.pinata\.cloud|ipfs\.io)\/ipfs\//, async route => route.fulfill({
      response: await route.fetch({ url: `${relay.url}/ipfs/${route.request().url().split('/ipfs/')[1]}` })
    }));
    await target.route(/\/proposals\/42\/owner-decisions(\/bundle)?(\?.*)?$/, async route => (withRelay
      ? route.fulfill({ response: await route.fetch({ url: `${relay.url}${new URL(route.request().url()).pathname}` }) })
      : route.fulfill({ status: 503, json: { error: 'relay unavailable' } })));
    await installSwitchableWallet(target, wallets);
    await openCity(target);
    await target.evaluate(() => (window as any).i18n.setLanguage('en'));
    await establishLocalProfile(target);
    expect(await seedReadjustment(target, memberKey, published)).toBe(published.proposalId);
  };
  await setup(true)(page);
  const record = await proposalState(page, published.proposalId);
  writeFileSync(relay.file, JSON.stringify({ proposalId: published.proposalId, serverProposalId: '42', onchain: published.onchain,
    lifecycleStatus: 'Active', cadastreParcelIds: record.cadastreParcelIds, approvalConfig: record.approvalConfig, lens: record.lens }));

  await openLand(page, published.proposalId);
  await expect(card(page).locator('[data-approval-chain-line]')).toHaveText('On chain: 0 of 0 decisions anchored.', { timeout: 30_000 });
  // The contract never executes an approval setup, so nothing here settles on it.
  await expect(page.locator('#proposal-details-panel [data-proposal-support-actions], #proposal-details-panel .proposal-pledge-summary, #proposal-details-panel .proposal-market-summary')).toHaveCount(0);
  await useWallet(page, wallets.a.address);
  await verifyAndAccept(page, 'a', undefined, 'yes');
  await useWallet(page, wallets.c.address);
  await verifyAndAccept(page, 'c', undefined, 'yes');
  const decisions = await page.evaluate(() => (window as any).__e2eWallet.signed.filter((entry: any) => entry.text.startsWith('Urban Game Theory owner decision')));
  expect(decisions[0].text).toContain(`Accept proposal solana:devnet:${account} as owner owner-a.`);
  await expect(card(page).locator('[data-approval-chain-line]')).toHaveText('On chain: 0 of 2 decisions anchored.');

  // Owner A's (funded) wallet pins the decisions and records the pointer with one memo transaction.
  await useWallet(page, wallets.a.address);
  await card(page).locator('[data-approval-action="anchor"]').click();
  await expect(card(page).locator('[data-approval-chain-line]')).toHaveText('On chain: 2 of 2 decisions anchored.', { timeout: 90_000 });
  await expect(card(page).locator('[data-approval-chain-status]')).toHaveText('Anchored 2 decisions.');
  await expect(card(page).locator('[data-approval-action="anchor"]')).toHaveCount(0);
  const explorer = await card(page).locator('[data-approval-chain-tx]').getAttribute('href');
  expect(explorer).toMatch(/^https:\/\/explorer\.solana\.com\/tx\/[1-9A-HJ-NP-Za-km-z]+\?cluster=devnet$/);
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'anchored-on-chain');

  // A second browser whose relay is down recovers both acceptances from chain + IPFS and counts them.
  const second = await secondBrowser(browser, baseURL, setup(false));
  try {
    const other = second.page;
    await openLand(other, published.proposalId);
    await expect(card(other).locator('[data-approval-chain-line]')).toHaveText('On chain: 2 of 2 decisions anchored.', { timeout: 60_000 });
    await expect(card(other).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted');
    await expect(card(other).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner B, Owner D');
    await card(other).scrollIntoViewIfNeeded();
    await screenshot(other, testInfo, 'recovered-from-chain');
    expect(second.errors).toEqual([]);
  } finally {
    await second.context.close();
  }
});

// Offline counterpart of the explicitly opt-in devnet integration case.
test('a mocked Solana anchor records signed owner decisions and recovers them without the relay', async ({ mockApi: page, browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const web3 = createRequire(`${BACKEND}/`)('@solana/web3.js');
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet() };
  // Only the Solana transport is simulated. The wallet signs a real web3 Transaction, the
  // relay pins its real verified bundle, and the second browser verifies chain + bundle content.
  const chainRows: Array<{ signature: string; memo: string; err: null }> = [];
  const transactions: Array<{ signature: string; memo: string; program: string; lookup: string }> = [];
  const rpcEvents: string[] = [];
  const { memberKey, serviceUrl } = await startMember(testInfo, (['a', 'b', 'c', 'd'] as const).map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })));
  const relay = await startRelay(testInfo);
  const program = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
  const account = web3.Keypair.generate().publicKey.toBase58();
  const published = {
    proposalId: 'lr-anchor-e2e', serverProposalId: '42',
    onchain: { chainId: 'solana-devnet', proposalId: account, contractAddress: program },
    nft: { chain: 'solana-devnet', contract: program, tokenId: account }
  };
  const setup = (withRelay: boolean) => async (target: Page) => {
    await target.exposeFunction('__anchorReadFixture', () => chainRows);
    await target.exposeFunction('__anchorSendFixture', (bytes: number[]) => {
      const transaction = web3.Transaction.from(Uint8Array.from(bytes));
      expect(transaction.verifySignatures()).toBe(true);
      expect(transaction.instructions).toHaveLength(1);
      const instruction = transaction.instructions[0];
      const memo = new TextDecoder().decode(instruction.data);
      const signature = base58(transaction.signature);
      transactions.push({ signature, memo, program: instruction.programId.toBase58(), lookup: instruction.keys[0].pubkey.toBase58() });
      chainRows.push({ signature, memo: `[${Buffer.byteLength(memo)}] ${memo}`, err: null });
      rpcEvents.push('send');
      return signature;
    });
    await target.exposeFunction('__anchorConfirmFixture', () => { rpcEvents.push('confirm'); });
    await target.route('**/lenses/members', route => route.fulfill({ json: { members: [
      { key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }
    ] } }));
    // Public IPFS gateways answer from the bundles the relay pinned.
    await target.route(/^https:\/\/(gateway\.pinata\.cloud|ipfs\.io)\/ipfs\//, async route => route.fulfill({
      response: await route.fetch({ url: `${relay.url}/ipfs/${route.request().url().split('/ipfs/')[1]}` })
    }));
    await target.route(/\/proposals\/42\/owner-decisions(\/bundle)?(\?.*)?$/, async route => (withRelay
      ? route.fulfill({ response: await route.fetch({ url: `${relay.url}${new URL(route.request().url()).pathname}` }) })
      : route.fulfill({ status: 503, json: { error: 'relay unavailable' } })));
    await installSwitchableWallet(target, wallets);
    await openCity(target);
    await target.evaluate(async () => {
      const w = window as any;
      await w.ensureWalletVendors();
      const connection = {
        getSignaturesForAddress: async () => w.__anchorReadFixture(),
        getLatestBlockhash: async () => ({ blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 99 }),
        simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
        sendRawTransaction: async (bytes: Uint8Array) => w.__anchorSendFixture(Array.from(bytes)),
        confirmTransaction: async () => { await w.__anchorConfirmFixture(); return { value: { err: null } }; },
      };
      w.SolanaChainDataLoader.getConnection = () => connection;
    });
    await target.evaluate(() => (window as any).i18n.setLanguage('en'));
    await establishLocalProfile(target);
    expect(await seedReadjustment(target, memberKey, published)).toBe(published.proposalId);
  };
  await setup(true)(page);
  const record = await proposalState(page, published.proposalId);
  writeFileSync(relay.file, JSON.stringify({ proposalId: published.proposalId, serverProposalId: '42', onchain: published.onchain,
    lifecycleStatus: 'Active', cadastreParcelIds: record.cadastreParcelIds, approvalConfig: record.approvalConfig, lens: record.lens }));

  await openLand(page, published.proposalId);
  await expect(card(page).locator('[data-approval-chain-line]')).toHaveText('On chain: 0 of 0 decisions anchored.', { timeout: 30_000 });
  // The contract never executes an approval setup, so nothing here settles on it.
  await expect(page.locator('#proposal-details-panel [data-proposal-support-actions], #proposal-details-panel .proposal-pledge-summary, #proposal-details-panel .proposal-market-summary')).toHaveCount(0);
  await useWallet(page, wallets.a.address);
  await verifyAndAccept(page, 'a', undefined, 'yes');
  await useWallet(page, wallets.c.address);
  await verifyAndAccept(page, 'c', undefined, 'yes');
  const decisions = await page.evaluate(() => (window as any).__e2eWallet.signed.filter((entry: any) => entry.text.startsWith('Urban Game Theory owner decision')));
  expect(decisions[0].text).toContain(`Accept proposal solana:devnet:${account} as owner owner-a.`);
  await expect(card(page).locator('[data-approval-chain-line]')).toHaveText('On chain: 0 of 2 decisions anchored.');

  // Owner A signs the pointer; the mocked RPC confirms that exact signed memo.
  await useWallet(page, wallets.a.address);
  await card(page).locator('[data-approval-action="anchor"]').click();
  await expect(card(page).locator('[data-approval-chain-line]')).toHaveText('On chain: 2 of 2 decisions anchored.', { timeout: 90_000 });
  await expect(card(page).locator('[data-approval-chain-status]')).toHaveText('Anchored 2 decisions.');
  await expect(card(page).locator('[data-approval-action="anchor"]')).toHaveCount(0);
  expect(rpcEvents).toEqual(['send', 'confirm']);
  expect(transactions).toHaveLength(1);
  expect(transactions[0].program).toBe('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo');
  expect(transactions[0].memo).toContain(`ugt-owner-decisions/1 solana:devnet:${account} ipfs://`);
  const expectedInbox = web3.PublicKey.findProgramAddressSync([
    Buffer.from('ugt-owner-decisions'), new web3.PublicKey(account).toBytes(),
  ], new web3.PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo'))[0].toBase58();
  expect(transactions[0].lookup).toBe(expectedInbox);
  const explorer = await card(page).locator('[data-approval-chain-tx]').getAttribute('href');
  expect(explorer).toBe(`https://explorer.solana.com/tx/${transactions[0].signature}?cluster=devnet`);
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'anchored-on-chain');

  // A second browser whose relay is down recovers both acceptances from chain + IPFS and counts them.
  const second = await secondBrowser(browser, baseURL, setup(false));
  try {
    const other = second.page;
    await openLand(other, published.proposalId);
    await expect(card(other).locator('[data-approval-chain-line]')).toHaveText('On chain: 2 of 2 decisions anchored.', { timeout: 60_000 });
    await expect(card(other).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted');
    await expect(card(other).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner B, Owner D');
    await card(other).scrollIntoViewIfNeeded();
    await screenshot(other, testInfo, 'recovered-from-chain');
    expect(second.errors).toEqual([]);
  } finally {
    await second.context.close();
  }
});
