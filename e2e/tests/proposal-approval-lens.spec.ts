// Purpose: owners decide a proposed agreement through its decision card (plan-design-agreement.md,
// M2: the agreement panel's "Owner decisions", proposals/approval-panel.js). Four owners across three
// parcels accept only for themselves, through a real lens member process (backend/lens/run.mjs
// --rights) and wallet signatures over the agreement's CID; their receipts are relayed at
// /agreements/<cid>/decisions and still count after a reload. Parcel C is co-owned, so its area counts
// only once both owners accept. Two browsers share decisions through the relay's real handlers
// (backend/agreements/decisions.js), which verify every receipt before storing it.
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { cidOfObject, pageIndex } from '../helpers/mocks/shared-server';
import { openCity } from '../helpers/runtime';
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

// The ownership snapshot every scenario's rule carries: A and B have one owner each, C is co-owned by
// Owners C and D.
const RIGHTS = {
  schema: 'parcel-rights/v1', source: { provider: 'upload', reference: 'register-2026-10' }, parcels: [
    { parcelId: PARCELS.a, complete: true, areaM2: 100, owners: [{ ownerId: 'owner-a', share: '1/1' }] },
    { parcelId: PARCELS.b, complete: true, areaM2: 50, owners: [{ ownerId: 'owner-b', share: '1/1' }] },
    { parcelId: PARCELS.c, complete: true, areaM2: 25, owners: [{ ownerId: 'owner-c', share: '1/2' }, { ownerId: 'owner-d', share: '1/2' }] }
  ]
};
const UNANIMOUS = { schema: 'proposal-approval/v1', rights: RIGHTS, policy: { type: 'unanimous' } };

type ProposedAgreement = { id: string; cid: string };

// A proposed agreement over one design on parcels A, B and C, decided by their owners under
// `approvalConfig` through the lens members named. It is stored on this device as published and
// filed in the page's index as GET /agreements/:cid answers it (status active), so the agreement
// panel shows its decision card. Fixed dates and author make the same agreement, with the same CID,
// on every browser that seeds it.
async function proposeOwnerAgreement(page: Page, memberKeys: string[], approvalConfig: Record<string, unknown> = UNANIMOUS): Promise<ProposedAgreement> {
  const seeded = await page.evaluate(({ parcels, members, approvalConfig }) => {
    const w = window as any;
    const createdAt = '2026-10-20T08:00:00.000Z';
    const designId = w.proposalStorage.addProposal({
      proposalId: 'lens-agreement-design', title: 'Lens-backed design', goal: 'as-is', lifecycleStatus: 'Active',
      author: 'Lens approval fixture', createdAt, cadastreParcelIds: [parcels.a, parcels.b, parcels.c],
      geometry: { type: 'Polygon', coordinates: [[[15.98205, 45.8002], [15.98235, 45.8002], [15.98235, 45.80025], [15.98205, 45.80025], [15.98205, 45.8002]]] }
    });
    const design = w.proposalStorage.getProposal(designId);
    const designCid = w.DesignRecord.cidOf(design);
    const planContent = w.PlanRecord.create('Lens-backed owner agreement', [designCid], w.MapShare.capture(w));
    const plan = { cid: w.Cid.cidOfObject(planContent), content: planContent };
    const record = {
      schema: 'agreement/v1', id: 'ag-0123456789abcdef0123456789abcdef', title: 'Lens-backed owner agreement',
      city: w.CityConfigManager.getCurrentCityId(), createdAt,
      plan,
      designs: [{ proposalId: designId, title: design.title, goal: design.goal, cid: designCid }],
      // Input parcels are abstract parties; their owners are in approvalConfig's rights snapshot.
      inputs: { parcels: [
        { parcelId: parcels.a, areaM2: 100 },
        { parcelId: parcels.b, areaM2: 50 },
        { parcelId: parcels.c, areaM2: 25 }
      ], openGroundM2: 0 },
      outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
      rule: { electorate: 'owners', binding: true, approvalConfig, lens: members },
      deadline: '2030-12-31T00:00:00.000Z'
    };
    const content = w.AgreementRecord.published({ ...record, author: 'Lens approval fixture', sponsor: null },
      (id: string) => (id === designId ? designCid : null));
    const cid = w.Cid.cidOfObject(content);
    const saved = w.AgreementStore.save({ ...record, published: { cid, publishedAt: createdAt, apiBase: w.DesignSync.apiBase() } });
    return { id: saved.id, cid, content, plan };
  }, { parcels: PARCELS, members: memberKeys, approvalConfig });
  // The browser's CID is the CID of the object's canonical bytes (node's own computation).
  expect(cidOfObject(seeded.content)).toBe(seeded.cid);
  const index = pageIndex(page);
  index.plans.set(seeded.plan.cid, seeded.plan);
  index.agreements.set(seeded.cid, agreementRow(index, seeded.cid, seeded.content));
  return { id: seeded.id, cid: seeded.cid };
}

// The index row of a proposed agreement (backend/routes/agreements.js serializeAgreementRow).
function agreementRow(index: ReturnType<typeof pageIndex>, cid: string, content: Record<string, any>): Record<string, any> {
  const plan = index.plans.get(content.planCid);
  if (!plan || plan.cid !== content.planCid || cidOfObject(plan.content) !== content.planCid) throw new Error('Agreement fixture needs its verified plan snapshot.');
  return {
    cid, city: content.city, title: content.title, author: content.author,
    planCid: plan.cid, designCids: [...plan.content.designCids],
    inputParcelIds: content.inputs.parcels.map((parcel: any) => parcel.parcelId),
    parcelSourceId: null, deadline: content.deadline, status: 'active', content, onchain: null,
    screenshotUrl: null, screenshotBeforeUrl: null, screenshotPairUrl: null, createdAt: content.createdAt
  };
}

// The agreement panel on the right dock, with its owners' decision card.
async function openAgreement(page: Page, agreement: ProposedAgreement): Promise<void> {
  await page.evaluate(id => (window as any).AgreementPanel.open(id), agreement.id);
  await expect(page.locator('section#agreement-panel')).toBeVisible();
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
}

// The receipts the relay holds for an agreement, in the order they were sent.
const relayed = (page: Page, agreement: ProposedAgreement) => pageIndex(page).decisions.get(agreement.cid) || [];
const signedDecisions = (page: Page) => page.evaluate(() => (window as any).__e2eWallet.signed
  .filter((entry: any) => entry.text.startsWith('Urban Game Theory owner decision')));

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

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

const card = (page: Page) => page.locator('section#agreement-panel [data-approval-card]');
const dialog = (page: Page) => page.locator('#proposal-approval-dialog .cb-dialog');

// Verify the connected wallet with the lens member, then review and accept for the one owner it acts for.
async function verifyAndAccept(page: Page, owner: string, testInfo?: TestInfo, shared: 'yes' | 'no' = 'yes'): Promise<void> {
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
  await expect(dialog(page).locator(`[data-approval-receipt-shared="${shared}"]`)).toBeVisible();
  if (testInfo) await screenshot(page, testInfo, `receipt-owner-${owner}`);
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('#proposal-approval-dialog')).toHaveCount(0);
}

const TILE = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eee"/></svg>';
const tiles = (page: Page) => page.route(/https:\/\/[^/]*tile\.openstreetmap\.org\//, route => route.fulfill({ contentType: 'image/svg+xml', body: TILE }));

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
  }, { timeout: 20_000, message: `${args.join(' ')} did not start:\n${log.join('')}` }).toBe(200);
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
  await tiles(page);
  await installSwitchableWallet(page, wallets);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const agreement = await proposeOwnerAgreement(page, [first.memberKey, second.memberKey]);

  await useWallet(page, wallets.a.address);
  await openAgreement(page, agreement);
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
  // The receipt went to the relay, through the second member's evidence.
  await expect.poll(() => relayed(page, agreement).length).toBe(1);
  expect(relayed(page, agreement)[0]).toMatchObject({ ownerId: 'owner-a', actorId: wallets.a.address, decision: 'approve',
    evidence: { authority: { member: second.memberKey, ownerId: 'owner-a' } } });
});

test('four owners across three parcels accept only for themselves through a lens member', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(180_000);
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet(), stranger: wallet() };
  const { memberKey, serviceUrl } = await startMember(testInfo, (['a', 'b', 'c', 'd'] as const).map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })));
  const status = await (await fetch(`${serviceUrl}/lens/status`)).json();
  expect(status.approval).toMatchObject({ enabled: true, parcels: 3, owners: 4, signers: 4 });

  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }
  ] } }));
  await tiles(page);
  await installSwitchableWallet(page, wallets);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const agreement = await proposeOwnerAgreement(page, [memberKey]);

  await openAgreement(page, agreement);
  await expect(card(page)).toContainText('Configured approval rules not met');
  await expect(card(page)).toContainText('Configured approval rules require every owner to accept.');
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('0 of 4 accepted');
  await expect(card(page).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner A, Owner B, Owner C, Owner D');
  await expect(card(page).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('Owner C, Owner D have all accepted (0 of 2 so far)');
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'card-before');

  // Owner A: the lens member confirms the wallet first; the card then offers that owner's review,
  // and the review always comes before any signature.
  await useWallet(page, wallets.a.address);
  await card(page).locator('[data-approval-action="verify"]').click();
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await expect(dialog(page).locator('[data-approval-verified]')).toHaveAttribute('data-approval-verified', 'owner-a');
  await screenshot(page, testInfo, 'verified-owner-a');
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Close', exact: true }).click();
  await card(page).locator('[data-approval-action="review"][data-owner-id="owner-a"]').click();
  await expect(dialog(page)).toHaveAttribute('data-approval-review', 'owner-a');
  await expect(dialog(page).locator(`[data-approval-contribution="${PARCELS.a}"]`)).toContainText('Your share 1/1');
  await expect(dialog(page)).toContainText('Declared rights source: upload · register-2026-10');
  await expect(dialog(page)).toContainText('Your wallet signs this agreement’s identity (its CID)');
  await screenshot(page, testInfo, 'review-owner-a');
  expect(await signedDecisions(page), 'nothing is signed before the review').toHaveLength(0);
  await dialog(page).locator('[data-approval-accept="owner-a"]').click();
  await expect(dialog(page)).toHaveAttribute('data-approval-receipt', 'owner-a');
  await expect(dialog(page).locator('[data-approval-receipt-progress]')).toContainText('1 of 4 owners');
  await expect(dialog(page).locator('[data-approval-receipt-shared="yes"]')).toHaveText('Shared: other browsers can verify and count this decision.');
  await screenshot(page, testInfo, 'receipt-owner-a');
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('1 of 4 accepted');
  await expect(card(page).locator('[data-approval-accepted="owner-a"]')).toBeVisible();
  await expect(card(page).locator('[data-approval-action="withdraw"][data-owner-id="owner-a"]')).toBeVisible();

  // Owner C can act only for C: no review for D on the card, and D's deal opened from the card
  // offers no Accept until a lens member confirms a wallet for D.
  await useWallet(page, wallets.c.address);
  await verifyAndAccept(page, 'c');
  await expect(card(page).locator('[data-approval-action="review"][data-owner-id="owner-d"]')).toHaveCount(0);
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('100');
  await expect(card(page).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('(1 of 2 so far)');
  await card(page).locator('[data-approval-deals] [data-approval-action="inspect"][data-owner-id="owner-d"]').click();
  await dialog(page).locator('[data-approval-deal-accept="owner-d"]').click();
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
  await expect(dialog(page).locator('.approval-dialog__status')).toHaveText('This lens member does not recognize this wallet as acting for any owner of this design.');
  await dialog(page).locator('.close-circle-btn').click();
  await expect(page.locator('#proposal-approval-dialog')).toHaveCount(0);

  await useWallet(page, wallets.d.address);
  await verifyAndAccept(page, 'd');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('125');
  await expect(card(page).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('(2 of 2 so far)');

  await useWallet(page, wallets.b.address);
  await verifyAndAccept(page, 'b');
  await expect(card(page)).toContainText('Configured approval rules met');
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
  await expect(card(page)).toContainText('Configured approval rules not met');
  await expect(card(page).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner B');
  await card(page).locator('[data-approval-action="review"][data-owner-id="owner-b"]').click();
  await dialog(page).locator('[data-approval-accept="owner-b"]').click();
  await expect(dialog(page)).toHaveAttribute('data-approval-receipt', 'owner-b');
  await expect(dialog(page)).toContainText('The verified decisions meet this agreement’s rule.');
  await dialog(page).locator('.cb-dialog__footer').getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page)).toContainText('Configured approval rules met');

  // Every decision reached the relay, signed by the wallet the lens member confirmed for its owner.
  const receipts = relayed(page, agreement);
  expect(receipts.map((receipt: any) => [receipt.ownerId, receipt.decision])).toEqual([
    ['owner-a', 'approve'], ['owner-c', 'approve'], ['owner-d', 'approve'],
    ['owner-b', 'approve'], ['owner-b', 'withdraw'], ['owner-b', 'approve']]);
  for (const receipt of receipts) {
    const id = String(receipt.ownerId).replace('owner-', '') as 'a' | 'b' | 'c' | 'd';
    expect(receipt).toMatchObject({
      actorId: wallets[id].address, providerId: 'lens-wallet', decisionProof: { scheme: 'ed25519-wallet/v1' },
      evidence: { rights: { member: memberKey }, authority: { member: memberKey, ownerId: receipt.ownerId, actorId: wallets[id].address } }
    });
  }
  const decisions = await signedDecisions(page);
  expect(decisions.map((entry: any) => entry.address)).toEqual([wallets.a.address, wallets.c.address, wallets.d.address,
    wallets.b.address, wallets.b.address, wallets.b.address]);
  expect(decisions[4].text).toContain('Withdraw the acceptance of the agreement as owner owner-b.');
  expect(decisions[4].text).toContain(`Agreement: ${agreement.cid}`);

  // Reload with no wallet connected and no evidence cache: every receipt comes back from the relay
  // and verifies from its signatures.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).AgreementPanel && !!(window as any).ProposalApprovalPanel && !!(window as any).AgreementStore);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openAgreement(page, agreement);
  await expect(card(page)).toContainText('Configured approval rules met', { timeout: 30_000 });
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('4 of 4 accepted');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    '390px viewport must not scroll horizontally').toBe(false);
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'card-after-reload-390');
});

test('the review shows what an owner contributes and signs, on a phone', async ({ mockApi: page }, testInfo) => {
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
  const agreement = await proposeOwnerAgreement(page, [memberKey]);
  await openAgreement(page, agreement);
  await useWallet(page, wallets.c.address);
  await card(page).locator('[data-approval-action="verify"]').click();
  await dialog(page).locator('[data-approval-verify-submit]').click();
  await dialog(page).getByRole('button', { name: 'Review and accept as Owner C' }).click();

  const review = dialog(page);
  await expect(review.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('Your share 1/2');
  await expect(review.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('co-owned with Owner D');
  await expect(review).toContainText('Declared rights source: upload · register-2026-10');
  await expect(review).toContainText('Selected verification lens: Test notary');
  await expect(review).toContainText('Your wallet signs this agreement’s identity (its CID)');
  await expect(review.locator('[data-approval-progress-with]')).toContainText('1 of 4 owners');
  await expect(review).toContainText('Further decisions would still be needed under the configured approval rules.');
  const bounds = await review.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  await screenshot(page, testInfo, 'review-owner-c-390');

  // Cancelling leaves nothing signed and nothing relayed.
  await review.locator('.cb-dialog__footer').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(relayed(page, agreement)).toEqual([]);
  expect(await signedDecisions(page)).toHaveLength(0);

  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(async () => {
    const w = window as any;
    await w.i18n.setLanguage('es');
    w.ProposalApprovalPanel.renderCards();
  });
  // The language change re-renders the agreement panel as well, which can replace the card mid-scroll.
  await expect(async () => {
    await card(page).scrollIntoViewIfNeeded({ timeout: 2_000 });
    expect(await card(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1),
      'localized approval status must fit a 320px viewport').toBe(true);
  }).toPass();
  await screenshot(page, testInfo, 'approval-status-es-320');
});

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
  await tiles(page);
  await installSwitchableWallet(page, wallets);
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const version = await page.evaluate(() => (window as any).ProposalApprovalRegimes.latest('es-ct-basic').version);
  const agreement = await proposeOwnerAgreement(page, [memberKey], {
    schema: 'proposal-approval/v1',
    rights: RIGHTS,
    policy: { type: 'rules', tests: [{ measure: 'area', of: 'owners', scope: 'all', numerator: 1, denominator: 2, strict: true }], authorities: [{ authorityId: 'ajuntament' }] },
    regime: { id: 'es-ct-basic', version }
  });

  await openAgreement(page, agreement);
  await expect(card(page).locator('[data-approval-regime="es-ct-basic"]')).toContainText('Catalonia — basic compensation');
  await expect(card(page).locator('.approval-card__rule')).toHaveText('Configured approval rules require more than 1/2 of the area and the municipality’s approval of the compensation project. For area tests, a parcel or lease counts only after all its counted co-holders approve.');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('Needs more than 87.5');
  // Heads are not a test here: owners are shown, not counted.
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('Heard, not counted');
  await expect(card(page).locator('[data-approval-authority="ajuntament"]')).toHaveAttribute('data-approval-authority-state', 'pending');
  await expect(card(page)).toContainText('Configured approval rules not met');
  await screenshot(page, testInfo, 'scheme-card-before');

  // Owner A alone holds 100 of 175 m²: the area test is met and only the authority is missing.
  await useWallet(page, wallets.a.address);
  await verifyAndAccept(page, 'a');
  await expect(card(page).locator('[data-approval-meter="area"]')).toContainText('100');
  await expect(card(page).locator('[data-approval-awaiting-authority]')).toHaveText('Required authority decision pending');
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
  await expect(card(page)).toContainText('Configured approval rules met');
  await expect(card(page).locator('[data-approval-authority="ajuntament"]')).toHaveAttribute('data-approval-authority-state', 'approved');
  await screenshot(page, testInfo, 'scheme-card-passed');

  expect(relayed(page, agreement).find((receipt: any) => receipt.ownerId === 'ajuntament')).toMatchObject({
    ownerId: 'ajuntament', actorId: wallets.city.address, decision: 'approve',
    evidence: { authority: { member: memberKey, ownerId: 'ajuntament' } } });
  expect(await page.evaluate(id => (window as any).AgreementStore.get(id).rule.approvalConfig.regime, agreement.id))
    .toEqual({ id: 'es-ct-basic', version });
});

// Anyone can read each owner's deal from the card: no wallet, no lens member, nothing signed. The
// owner (or whoever acts for them) goes on from there to the signing review.
test('each owner\'s deal is readable by anyone from the Owner decisions card', async ({ mockApi: page }, testInfo) => {
  test.setTimeout(60_000);
  const member = wallet().address;
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: member, kind: 'owner-consent', name: 'Test notary' }
  ] } }));
  await openCity(page);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await establishLocalProfile(page);
  const agreement = await proposeOwnerAgreement(page, [member]);
  await openAgreement(page, agreement);

  const owners = card(page).locator('[data-approval-deals] [data-approval-action="inspect"]');
  await expect(owners).toHaveText(['Owner A', 'Owner B', 'Owner C', 'Owner D']);
  await owners.filter({ hasText: 'Owner D' }).click();

  const deal = dialog(page);
  await expect(deal.locator('.cb-dialog__title')).toHaveText('Owner D’s deal');
  await expect(deal).toContainText('Proposed contribution from Owner D');
  await expect(deal.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('Share 1/2');
  await expect(deal.locator(`[data-approval-contribution="${PARCELS.c}"]`)).toContainText('co-owned with Owner C');
  await expect(deal.locator('[data-approval-progress-with]')).toContainText('With Owner D’s acceptance: 1 of 4 owners');
  await expect(deal).toContainText('Selected verification lens: Test notary');
  await expect(deal).toContainText('Declared rights source:');
  await expect(deal).not.toContainText('is attested by');
  // Read-only: nothing here signs.
  await expect(deal).not.toContainText('Your wallet signs');
  await screenshot(page, testInfo, 'deal-owner-d');

  await deal.locator('[data-approval-deal-accept="owner-d"]').click();
  const review = dialog(page);
  await expect(review.locator('.cb-dialog__title')).toHaveText('Accept as Owner D');
  await expect(review).toContainText('Your share 1/2');
  await expect(review).toContainText('Your proposed contribution');
  await expect(review).toContainText('Selected verification lens: Test notary');
  await expect(review).not.toContainText('are attested by');
  await expect(review.locator('[data-approval-review-status]')).toContainText('first confirm with a lens member');
  expect(relayed(page, agreement)).toEqual([]);
});

// The relay's real handlers (backend/agreements/decisions.js) over the in-memory store, serving the
// decisions on the indexed agreement written to `file`: every receipt is verified before it is kept.
const RELAY_SCRIPT = `
import express from 'express';
import { readFileSync } from 'node:fs';
import { createAgreementDecisionHandlers, createMemoryAgreementDecisionStore } from './agreements/decisions.js';
const handlers = createAgreementDecisionHandlers({ store: createMemoryAgreementDecisionStore(), async loadAgreement(cid) {
  const agreement = JSON.parse(readFileSync(process.env.RELAY_AGREEMENT_FILE, 'utf8'));
  return cid === agreement.cid ? agreement : null;
} });
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/agreements/:cid/decisions', handlers.get);
app.post('/agreements/:cid/decisions', handlers.post);
app.listen(Number(process.env.RELAY_PORT), '127.0.0.1');
`;
async function startRelay(testInfo: TestInfo): Promise<{ url: string; file: string }> {
  const file = testInfo.outputPath('indexed-agreement.json');
  writeFileSync(file, '{}');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  await startBackendProcess(['--input-type=module', '-e', RELAY_SCRIPT], `${url}/health`, { RELAY_AGREEMENT_FILE: file, RELAY_PORT: String(port) });
  return { url, file };
}

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
  test.setTimeout(240_000);
  const wallets = { a: wallet(), b: wallet(), c: wallet(), d: wallet() };
  const { memberKey, serviceUrl } = await startMember(testInfo, (['a', 'b', 'c', 'd'] as const).map(id => ({ ownerId: `owner-${id}`, wallet: wallets[id].address })));
  const relay = await startRelay(testInfo);
  const agreements: ProposedAgreement[] = [];
  const setup = async (target: Page) => {
    await target.route('**/lenses/members', route => route.fulfill({ json: { members: [
      { key: memberKey, kind: 'owner-consent', name: 'Test notary', serviceUrl }
    ] } }));
    // Registered after the API mocks, so the relay's real handlers answer the decisions route.
    await target.route(/\/agreements\/[^/]+\/decisions(\?.*)?$/, async route => route.fulfill({
      response: await route.fetch({ url: `${relay.url}${new URL(route.request().url()).pathname}` })
    }));
    await installSwitchableWallet(target, wallets);
    await openCity(target);
    await target.evaluate(() => (window as any).i18n.setLanguage('en'));
    await establishLocalProfile(target);
    agreements.push(await proposeOwnerAgreement(target, [memberKey]));
  };
  await setup(page);
  const agreement = agreements[0];
  // What the index serves for the proposed agreement: the relay checks decisions against it.
  writeFileSync(relay.file, JSON.stringify(pageIndex(page).agreements.get(agreement.cid)));

  // Browser 1: Owners A and C accept; each receipt says it was shared.
  await openAgreement(page, agreement);
  await useWallet(page, wallets.a.address);
  await verifyAndAccept(page, 'a', testInfo, 'yes');
  await useWallet(page, wallets.c.address);
  await verifyAndAccept(page, 'c', undefined, 'yes');
  await expect(dialog(page)).toHaveCount(0);
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted');

  // Browser 2 holds the same agreement (the same CID): both acceptances arrive and count after its
  // own verification.
  const second = await secondBrowser(browser, baseURL, setup);
  try {
    const other = second.page;
    expect(agreements[1].cid).toBe(agreement.cid);
    await openAgreement(other, agreements[1]);
    await expect(card(other).locator('[data-approval-meter="owners"]')).toContainText('2 of 4 accepted', { timeout: 30_000 });
    await expect(card(other).locator(`[data-approval-co-owned="${PARCELS.c}"]`)).toContainText('(1 of 2 so far)');
    await expect(card(other).locator('[data-approval-outstanding]')).toHaveText('Still to accept: Owner B, Owner D');
    await card(other).scrollIntoViewIfNeeded();
    await screenshot(other, testInfo, 'second-browser-synced');
    // Owners D and B accept there; parcel C now counts.
    await useWallet(other, wallets.d.address);
    await verifyAndAccept(other, 'd', undefined, 'yes');
    await useWallet(other, wallets.b.address);
    await verifyAndAccept(other, 'b', undefined, 'yes');
    await expect(card(other)).toContainText('Configured approval rules met');
    await expect(card(other).locator('[data-approval-meter="owners"]')).toContainText('4 of 4 accepted');
    expect(second.errors).toEqual([]);
  } finally {
    await second.context.close();
  }

  // The relay holds exactly the four signed decisions.
  const kept = await (await fetch(`${relay.url}/agreements/${agreement.cid}/decisions`)).json();
  expect(kept.decisions.map((row: any) => row.ownerId)).toEqual(['owner-a', 'owner-c', 'owner-d', 'owner-b']);

  // Browser 1 returns later and catches up from the relay.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).AgreementPanel && !!(window as any).ProposalApprovalPanel && !!(window as any).AgreementStore);
  await page.evaluate(() => (window as any).i18n.setLanguage('en'));
  await openAgreement(page, agreement);
  await expect(card(page)).toContainText('Configured approval rules met', { timeout: 30_000 });
  await expect(card(page).locator('[data-approval-meter="owners"]')).toContainText('4 of 4 accepted');
  await card(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'first-browser-caught-up');
});
