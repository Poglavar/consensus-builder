// Purpose: an agreement on chain from its panel (plan-design-agreement.md, "M3 notes"; vocabulary.md,
// "M3 state: browser side"): only a binding owners' agreement has a chain section. Proposed without a
// sponsor wallet it is proposed again with one; its sponsor's wallet mints it (the mint's terms are
// asked and checked; the placeholder program is not on devnet, so nothing is recorded). Once the index
// records its account the panel reads the account itself: status, decision and escrow, the sponsor's
// Fund and Cancel, Record decision once its lens lists the decision, Execute when satisfied and funded,
// Expire after the deadline, open the dated-betting inspector, and the Lists panel's published agreements. A vote is never minted.
// Wallet transactions themselves are out of scope: the chain is the mocked RPC of helpers/agreement-chain.ts.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { chooseProfileName, openOnAnotherDevice, PARCEL_GEOMETRY, stubBasemapTiles } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet } from '../helpers/blockchain';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedIndex, E2E_LENS_MEMBER_KEY, fileAgreement, fileDesign, filePlan, pageIndex, SharedIndex } from '../helpers/mocks/shared-server';
import { agreementAccountAddress, encodeAgreementAccount, serveAgreementAccounts, DECISION, AgreementAccount } from '../helpers/agreement-chain';
import {
  applyLayout, agreementPanel, storedAgreements, createFromPlan, openStackAgreement, openAgreementsList, agreementListItem, openListedAgreement, closeAgreementPanel,
  panelStatus, editorSave, editorClosed, openAgreementDecision, openAgreementActions,
} from '../helpers/agreements';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
  // Agreement chain fixtures are land-free, but the app still bootstraps the selected city’s
  // parcel register. Keep this setup local and deterministic so an external registry 502 cannot
  // open the blocking “parcel source unavailable” sheet and steal focus from funding dialogs.
  await page.route('**/parcel-sources/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
  }));
  await page.route('http://localhost:3000/parcel-nyc**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: [] }),
  }));
});

const SPONSOR = '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9';
const ATTESTATION = 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os';
const TITLE = 'Binding block';
const AUTHOR = 'Chain author';
const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;
const SOL = 1_000_000_000n;

// A new agreement over a saved plan of the applied layout: owners or a community vote, a title, and
// for owners an explicit Binding tick (a new agreement is a non-binding vote, 58ede10da) and the lens
// member the rule names (the member a mint names), saved; its panel current.
async function saveAgreement(page: Page, layoutId: string, { community = false, walletConnected = false } = {}): Promise<Locator> {
  const editor = await createFromPlan(page, layoutId);
  await editor.getByRole('tab', { name: 'Rules', exact: true }).click();
  await editor.locator('[data-agreement-title]').fill(TITLE);
  if (community) await editor.locator('input[name="agreement-electorate"][value="community"]').check();
  else {
    const binding = editor.locator('[data-agreement-binding]');
    await expect(binding).not.toBeChecked();
    await binding.check();
    // The rule's lens is edited in the lens dialog; the agreement keeps its own snapshot of it. With
    // a Solana wallet connected the dialog lists the lens directory's members to tick; without one
    // it takes typed addresses.
    await editor.locator('[data-agreement-action="lens"]').click();
    const lens = page.locator('.lens-modal');
    if (walletConnected) await lens.getByRole('checkbox', { name: new RegExp(E2E_LENS_MEMBER_KEY) }).check();
    else {
      // The member is the lens's only entry: the default entries go.
      const addresses = lens.locator('.lens-address-input');
      await addresses.first().fill(E2E_LENS_MEMBER_KEY);
      for (let count = await addresses.count(); count > 1; count -= 1) {
        await lens.locator('.lens-remove-btn').last().click();
        await expect(addresses).toHaveCount(count - 1);
      }
    }
    await lens.locator('.lens-close-btn').click();
    await expect(lens).toHaveCount(0);
  }
  await editorSave(editor).click();
  await editorClosed(page);
  return openStackAgreement(page);
}

// Propose on the panel, a guest naming a profile first; resolves once the panel shows the CID.
async function propose(page: Page, panel: Locator): Promise<void> {
  await panel.locator('[data-agreement-action="propose"]').click();
  await chooseProfileName(page, AUTHOR);
  await panel.locator('[data-agreement-action="propose"]').click();
  await openAgreementDecision(page);
  await expect(panel.locator('code.agreement-panel-cid')).toBeVisible({ timeout: 30_000 });
}

// Close the panel and open the agreement again from the Agreements list: it reads the index and the
// chain afresh.
async function reopen(page: Page, id: string): Promise<void> {
  await closeAgreementPanel(page);
  const list = await openAgreementsList(page);
  await openListedAgreement(list, id);
  await panelStatus(page, 'current');
  await openAgreementDecision(page);
}

// Another device, reading this device's index and the same chain, opening `url`.
async function openDevice(browser: Browser, url: string, index: SharedIndex, accounts: Map<string, Buffer>, baseURL: string | undefined): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('cb_current_city', 'new_york');
      localStorage.setItem('cb_site_intro_seen_v1', '1');
    } catch (_) { /* opaque origin */ }
  });
  const page = await context.newPage();
  await mockAllApiRoutes(page);
  await attachSharedIndex(page, index);
  await serveAgreementAccounts(page, accounts);
  await stubBasemapTiles(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForMapReady(page);
  return { context, page };
}

test.describe('Agreements on chain @core', () => {
  test('an investor opens committed terms and must manually confirm a USDC contribution', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await injectMockSolanaWallet(page, { publicKey: SPONSOR, providerName: 'phantom' });
    const index = pageIndex(page);
    const city = 'new_york', view = { at: '40.7143,-74.0085,16', mode: '2d', city, language: 'en' };
    const design = fileDesign(index, { schema: 'design/v1', goal: 'park', title: 'Local park', description: null, author: null, city, site: PARCEL_GEOMETRY,
      toleranceM: null, geometry: null, origin: null, authoredAt: null, structureProposal: { kind: 'park', blockName: null, geometry: PARCEL_GEOMETRY } });
    const planCid = filePlan(index, require('../../frontend/js/plan-record.js').create('Park plan', [design], view));
    const deadline = '2030-12-31T23:59:59.000Z';
    await page.clock.install({ time: new Date(Date.parse(deadline) - 55_000) });
    const cid = fileAgreement(index, { schema: 'agreement/v1', title: 'Investor round', author: null, sponsor: SPONSOR, city, planCid, createdAt: null, deadline,
      inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'USD', lines: [] }, valuation: null, consultation: null,
      rule: { electorate: 'investors', binding: true, approvalConfig: null, settlement: null, lens: [E2E_LENS_MEMBER_KEY] },
      funding: { targetUsdcAtomic: '12500000', contract: { name: 'return-terms.txt', mediaType: 'text/plain', data: Buffer.from('Quarterly investor reports.').toString('base64') } } });
    const account = agreementAccountAddress(cid, SPONSOR);
    const accounts = new Map([[account, encodeAgreementAccount({ cid, authority: SPONSOR, lenses: [E2E_LENS_MEMBER_KEY], payout: SPONSOR, deadline: Date.parse(deadline) / 1000, requiredLamports: 0n,
      fundingMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', requiredFunding: 12_500_000n })]]);
    await serveAgreementAccounts(page, accounts);
    index.agreements.get(cid)!.onchain = { chain: 'solana', cluster: 'devnet', account, sponsor: SPONSOR, status: 'active', decision: 'pending' };
    await page.goto(`/agreements/${cid}?city=${city}&at=${view.at}&act=donate&amount=1.25&lang=en`, { waitUntil: 'domcontentloaded' });
    const panel = agreementPanel(page);
    const fundingGoal = panel.locator('[data-agreement-funding-goal]');
    await expect(fundingGoal).toContainText('0 of 12.5 devnet USDC');
    const fundingBar = panel.getByRole('progressbar', { name: 'Contributions', exact: true });
    const timeBar = panel.getByRole('progressbar', { name: 'Time remaining · Final 10 days' });
    await expect(fundingBar).toHaveAttribute('max', '12.5');
    await expect(fundingBar).toHaveAttribute('value', '0');
    await expect(timeBar).toHaveAttribute('max', '864000');
    await expect(timeBar).toHaveAttribute('aria-valuetext', /^\d+ seconds$/);
    const deadlineDate = panel.locator('.agreement-funding-meter time');
    await expect(deadlineDate).toHaveAttribute('datetime', deadline);
    await expect(deadlineDate).toContainText(await page.evaluate(value => (window as any).CbFormat.formatDateTime(value), deadline));
    const contribution = panel.locator('[data-agreement-boost-action="boost"]');
    await expect(panel.locator('[data-agreement-chain="minted"]')).toHaveCount(1);
    await expect(panel.locator('[data-agreement-action="fund"], [data-agreement-action="bet"]')).toHaveCount(0);
    const download = page.waitForEvent('download');
    await panel.locator('[data-agreement-action="contract"]').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('return-terms.txt');
    // An approval/deep link may focus the contribution affordance, but cannot send or open a wallet
    // prompt by itself.  This active round has no automatic transfer in the fixture.
    await expect(page.locator('.cb-dialog--prompt')).toHaveCount(0);
    await expect(contribution).toBeVisible({ timeout: 30_000 });
    await contribution.focus();
    await page.keyboard.press('Enter');
    const prompt = page.locator('.cb-dialog--prompt');
    await expect(prompt).toContainText('How much devnet USDC will you contribute');
    const amount = prompt.getByRole('textbox', { name: /How much devnet USDC/ });
    await expect(amount).toHaveValue('1.25');
    await expect(amount).toBeFocused();
    const clockInBackground = panel.locator('[data-agreement-funding-time-meter]');
    const initialTime = Number(await clockInBackground.getAttribute('value'));
    expect(initialTime).toBeGreaterThan(0);
    await expect.poll(async () => Number(await clockInBackground.getAttribute('value'))).toBeLessThan(initialTime);
    await expect(amount).toBeFocused();
    await prompt.getByRole('button', { name: 'Cancel' }).press('Enter');
    await expect(prompt).toHaveCount(0);
    await expect(panel.locator('[data-agreement-boost-status]')).not.toContainText('Contributed');
    expect(await storedAgreements(page)).toHaveLength(0);
    await contribution.press('Enter');
    await amount.fill('0.10');
    const connect = prompt.getByRole('button', { name: 'Connect wallet', exact: true });
    await expect(connect).toBeVisible();
    await page.evaluate(() => {
      const provider = (window as any).solana;
      (window as any).__signCalls = 0;
      const signTransaction = provider.signTransaction.bind(provider);
      provider.signTransaction = async (transaction: unknown) => {
        (window as any).__signCalls += 1;
        return signTransaction(transaction);
      };
    });

    // The amount form opens a Solana-only picker. Escape cancels that picker and returns focus to
    // the same action without changing the amount or starting a signature request.
    await connect.click();
    const wallet = page.locator('.wallet-modal-overlay');
    await expect(wallet).toBeVisible();
    await expect(wallet.locator('[data-wallet-connector="solana-phantom"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(wallet).toHaveCount(0);
    await expect(prompt).toBeVisible();
    await expect(amount).toHaveValue('0.10');
    await expect(connect).toBeFocused();

    // Exercise a declined signature, a pending transaction and confirmation before a slow escrow read.
    await connect.click();
    await expect(page.locator('.wallet-modal-overlay')).toBeVisible();
    await page.locator('[data-wallet-connector="solana-phantom"]').click();
    await expect(page.locator('.wallet-modal-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__signCalls)).toBe(0);
    await expect(prompt.getByRole('button', { name: 'Contribute', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const root = window as any;
      let calls = 0;
      let escrow = { totalDonated: 0n, totalRefunded: 0n, donorCount: 0n, released: false };
      root.__contributionCalls = () => calls;
      const confirmed = new Promise<void>(resolve => { root.__confirmContribution = resolve; });
      const reread = new Promise<void>(resolve => { root.__finishEscrowRead = resolve; });
      root.AgreementBridge = { ...root.AgreementBridge,
        donations: async () => {
          if (escrow.totalDonated > 0n) await reread;
          return { escrow, mine: [] };
        },
        donate: async ({ amountAtomic, onStatus }: { amountAtomic: bigint; onStatus: (status: { state: string }) => void }) => {
          if (amountAtomic !== 100000n) throw new Error('Unexpected contribution amount.');
          calls += 1;
          if (calls === 1) throw new Error('Transaction declined by wallet.');
          onStatus({ state: 'submitted' });
          await confirmed;
          escrow = { ...escrow, totalDonated: amountAtomic, donorCount: 1n };
        }
      };
    });
    const contribute = prompt.getByRole('button', { name: 'Contribute', exact: true });
    await contribute.click();
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('Transaction declined by wallet.');
    await expect(amount).toHaveValue('0.10');
    await expect.poll(() => page.evaluate(() => (window as any).__contributionCalls())).toBe(1);
    const receipt = page.getByRole('alertdialog', { name: 'Contribution confirmed' });
    await expect(receipt).toHaveCount(0);
    await contribute.press('Enter');
    await expect(prompt).toContainText('Waiting for confirmation');
    await expect(receipt).toHaveCount(0);
    await page.evaluate(() => (window as any).__confirmContribution());
    await expect(prompt).toHaveCount(0);
    await expect(receipt).toContainText('Contributed 0.1 devnet USDC.');
    const inline = panel.locator('[data-agreement-boost-action="boost"] + [data-agreement-boost-status]');
    await expect(inline).toHaveText('Contributed 0.1 devnet USDC.');
    await page.evaluate(() => (window as any).__finishEscrowRead());
    await expect(fundingGoal).toContainText('0.1 of 12.5 devnet USDC');
    await expect(receipt.getByRole('button', { name: 'OK', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(receipt).toHaveCount(0);
    await expect(contribution).toBeFocused();
    await expect(fundingBar).toHaveAttribute('value', '0.1');
    await expect(inline).toHaveText('Contributed 0.1 devnet USDC.');
    await expect(inline).toHaveClass(/status--success/);
    await expect(inline).toBeInViewport();
    expect(await inline.evaluate(node => {
      const button = node.previousElementSibling!.getBoundingClientRect();
      const line = node.getBoundingClientRect();
      return line.left >= button.right && line.top < button.bottom && line.bottom > button.top;
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__contributionCalls())).toBe(2);
    expect(await storedAgreements(page)).toHaveLength(0);
  });

  test('an apartment inventory round lets a buyer review, reserve and download the exact apartment schedule', async ({ mockApi: page }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    const buyer = ATTESTATION;
    await injectMockSolanaWallet(page, { publicKey: buyer, providerName: 'phantom' });
    const index = pageIndex(page), city = 'new_york', deadline = '2030-12-31T23:59:59.000Z';
    const view = { at: '40.7143,-74.0085,18', mode: '2d', city, language: 'en' };
    const design = fileDesign(index, { schema: 'design/v1', goal: 'park', title: 'Garden court', description: null,
      author: null, city, site: PARCEL_GEOMETRY, toleranceM: null, geometry: null, origin: null, authoredAt: null,
      structureProposal: { kind: 'park', blockName: null, geometry: PARCEL_GEOMETRY } });
    const planCid = filePlan(index, require('../../frontend/js/plan-record.js').create('Courtyard homes', [design], view));
    const unit = { unitId: 'a-101', label: 'Apartment A-101', xrayBuilding: 'new_york::buildings::tower-1', unit: '1::A-101', at: view.at,
      priceUsdcAtomic: '250000000', depositUsdcAtomic: '12500000', drawing: { name: 'tower-floor.pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-1.7\nDrawing').toString('base64') } };
    const funding = { targetUsdcAtomic: '12500000', apartments: { projectId: 'garden-court', units: [unit] },
      contract: { name: 'terms.txt', mediaType: 'text/plain', data: Buffer.from('Reservation deposits are credited to the purchase price.').toString('base64') } };
    const cid = fileAgreement(index, { schema: 'agreement/v1', title: 'Apartment round', author: null, sponsor: SPONSOR, city, planCid, createdAt: null, deadline,
      inputs: { parcels: [], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'USD', lines: [] }, valuation: null, consultation: null,
      rule: { electorate: 'investors', binding: true, approvalConfig: null, settlement: null, lens: [E2E_LENS_MEMBER_KEY] }, funding });
    const account = agreementAccountAddress(cid, SPONSOR);
    await serveAgreementAccounts(page, new Map([[account, encodeAgreementAccount({ cid, authority: SPONSOR, lenses: [E2E_LENS_MEMBER_KEY], payout: SPONSOR, deadline: Date.parse(deadline) / 1000, requiredLamports: 0n,
      fundingMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', requiredFunding: 12_500_000n })]]));
    index.agreements.get(cid)!.onchain = { chain: 'solana', cluster: 'devnet', account, sponsor: SPONSOR, status: 'active', decision: 'pending' };
    await page.goto(`/agreements/${cid}?city=${city}&at=${view.at}&act=reserve&unitId=a-101&lang=en`, { waitUntil: 'domcontentloaded' });
    const panel = agreementPanel(page), row = panel.locator('[data-agreement-apartment-unit="a-101"]');
    await expect(row).toContainText('Awaiting developer listing', { timeout: 30000 });
    await page.evaluate(({ buyer, account }) => {
      const root = window as any;
      let reserved = false;
      const offer = { unitId: 'a-101', account: 'unit-account', termsHash: 'ab'.repeat(32), deposit: '12500000' };
      root.AgreementBridge = { ...root.AgreementBridge,
        apartmentInventory: async () => [{ ...offer, status: reserved ? 'reserved' : 'available', buyer: reserved ? buyer : null, position: reserved ? 'position-account' : null, qualification: reserved ? 'verified-buyer-proof' : null }],
        reserveApartment: async ({ expectedBuyer, onStatus }: { expectedBuyer: string; onStatus: (status: { state: string }) => void }) => {
          if (!root.__buyerQualified) throw Error('Your wallet is awaiting qualification for this apartment.');
          if (reserved || expectedBuyer !== buyer) throw Error('Invalid duplicate or buyer.');
          onStatus({ state: 'submitted' }); reserved = true;
          return { account, signature: 'reservation-signature', position: 'position-account' };
        } };
    }, { buyer, account });
    await panel.locator('[data-agreement-action="refresh-funding"]').click();
    await expect(panel.locator('[data-agreement-funding-disclosure]')).toContainText('lens must qualify your wallet');
    const reserve = row.getByRole('button', { name: 'Reserve apartment', exact: true });
    await expect(reserve).toBeVisible();
    await reserve.press('Enter');
    const review = page.locator('.cb-dialog--prompt');
    await expect(review).toContainText('Apartment A-101');
    await expect(review).toContainText('250 USDC');
    await expect(review).toContainText('12.5 USDC');
    await expect(review.getByRole('link', { name: 'View apartment in X-ray' })).toHaveAttribute('href', /unit=1%3A%3AA-101/);
    await expect(review.getByRole('button', { name: /Download drawing/ })).toBeVisible();
    await review.getByRole('button', { name: 'Connect wallet', exact: true }).press('Enter');
    await page.locator('[data-wallet-connector="solana-phantom"]').click();
    await expect(review).toContainText(buyer);
    await expect(page.getByRole('alertdialog', { name: 'Apartment reserved' })).toHaveCount(0);
    await page.evaluate(() => { const w = window as any; w.copyTextWithFeedback = async (value: string) => { w.__qualificationText = value; return true; }; });
    await review.getByRole('button', { name: 'Copy qualification request' }).press('Enter');
    expect(await page.evaluate(() => JSON.parse((window as any).__qualificationText))).toMatchObject({
      agreement: cid, unitId: unit.unitId, unit: unit.unit, xrayBuilding: unit.xrayBuilding, buyer, developer: SPONSOR, lenses: [E2E_LENS_MEMBER_KEY]
    });
    await review.getByRole('button', { name: 'Reserve apartment', exact: true }).press('Enter');
    await expect(review).toContainText('Your wallet is awaiting qualification');
    await page.evaluate(() => { (window as any).__buyerQualified = true; });
    await review.getByRole('button', { name: 'Reserve apartment', exact: true }).press('Enter');
    const receipt = page.getByRole('alertdialog', { name: 'Apartment reserved' });
    await expect(receipt).toContainText('Apartment A-101');
    await expect(receipt).toContainText('12.5 devnet USDC');
    await receipt.getByRole('button', { name: 'OK' }).press('Enter');
    await expect(row.getByRole('status')).toHaveText('Apartment A-101 reserved. Your deposit was 12.5 devnet USDC.');
    await expect(panel.locator('[data-agreement-funding-goal]')).toContainText('12.5 of 12.5');
    await expect(reserve).toHaveCount(0);
    const download = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download contract schedule' }).press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toBe('apartment-a-101-contract-schedule.json');
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    const schedule = JSON.parse(Buffer.concat(chunks).toString());
    expect(schedule).toMatchObject({ buyer, developer: SPONSOR, unit, projectId: 'garden-court', agreementCid: cid, agreementAccount: account,
      contract: funding.contract, planCid, termsHash: 'ab'.repeat(32), qualification: 'verified-buyer-proof', depositPaidUsdcAtomic: '12500000', position: 'position-account', signature: 'reservation-signature' });
  });

  test('a binding owners’ agreement is minted by its sponsor: proposed without a wallet it is proposed again with one, and Mint asks the mint’s terms', async ({ mockApi: page, browser, baseURL }) => {
    test.setTimeout(300_000);
    await injectMockSolanaWallet(page, { publicKey: SPONSOR, providerName: 'phantom' });
    await serveAgreementAccounts(page, new Map());
    const { layoutId } = await applyLayout(page);
    const index = pageIndex(page);
    const panel = await saveAgreement(page, layoutId);
    const [draft] = await storedAgreements(page);
    expect(draft.rule).toMatchObject({ electorate: 'owners', binding: true, lens: [E2E_LENS_MEMBER_KEY] });
    // Not proposed yet: nothing to mint, nothing to bet on.
    await expect(panel.locator('[data-agreement-chain]')).toHaveCount(0);
    await expect(panel.locator('[data-agreement-action="bet"]')).toHaveCount(0);

    // Proposed without a Solana wallet it has no sponsor, so no chain address: the way on is a new agreement.
    await propose(page, panel);
    const [firstCid] = [...index.agreements.keys()];
    expect(index.agreements.get(firstCid)!.content).toMatchObject({ sponsor: null, rule: { electorate: 'owners', binding: true } });
    const unminted = panel.locator('[data-agreement-chain="unminted"]');
    await expect(unminted).toContainText('Not minted.');
    await expect(unminted).toContainText('It was proposed without a sponsor wallet, so it cannot be minted.');
    const repropose = unminted.locator('[data-agreement-action="repropose"]');
    await expect(repropose).toHaveText('Propose again with this wallet');
    await expect(repropose).toBeDisabled();
    await expect(panel.locator('[data-agreement-action="mint"], [data-agreement-action="bet"]')).toHaveCount(0);

    // A connected wallet proposes it again as the sponsor: a new agreement with its own CID; the first stays.
    await connectWalletByConnectorId(page, 'solana-phantom');
    await expect(repropose).toBeEnabled();
    await repropose.click();
    await expect.poll(() => index.agreements.size, { timeout: 30_000 }).toBe(2);
    await openAgreementDecision(page);
    const secondCid = [...index.agreements.keys()].find(cid => cid !== firstCid)!;
    expect(index.agreements.get(secondCid)!.content).toMatchObject({ sponsor: SPONSOR, title: TITLE, author: AUTHOR, rule: { binding: true, lens: [E2E_LENS_MEMBER_KEY] } });
    await expect(panel.locator('code.agreement-panel-cid')).toHaveAttribute('title', secondCid, { timeout: 30_000 });
    const stored = await storedAgreements(page);
    expect(stored).toHaveLength(2);
    expect(stored.find((agreement: any) => agreement.published?.cid === secondCid).published.sponsor).toBe(SPONSOR);
    expect(stored.find((agreement: any) => agreement.published?.cid === firstCid).published.sponsor).toBeNull();

    // The sponsor's wallet, a lens named by the rule and no deadline: Mint is ready, with nothing to wait for.
    const mint = panel.locator('[data-agreement-chain="unminted"] [data-agreement-action="mint"]');
    await expect(mint).toBeEnabled();
    await expect(panel.locator('[data-agreement-chain="unminted"] .agreement-panel-hint')).toHaveCount(0);
    await expect(panel.locator('[data-agreement-action="bet"]')).toHaveCount(0);

    // Mint asks the escrow execution needs and the payout account and checks them; then the content goes
    // on IPFS and a public gateway must serve it (content-gate.js) before any transaction; the program (a
    // placeholder until deployed) is not on devnet, so nothing is minted or recorded.
    await mint.click();
    const terms = page.locator('.agreement-mint-dialog');
    await expect(terms).toBeVisible();
    await expect(terms).toContainText(short(E2E_LENS_MEMBER_KEY));
    await expect(terms.locator('[data-agreement-mint-required]')).toHaveValue('0');
    await expect(terms.locator('[data-agreement-mint-payout]')).toHaveValue(SPONSOR);
    await terms.locator('[data-agreement-mint-payout]').fill('not-a-solana-address');
    await terms.locator('[data-action-id="mint"]').click();
    await expect(terms.locator('[data-agreement-mint-error]')).toHaveText('The payout account must be a Solana address.');
    await terms.locator('[data-agreement-mint-payout]').fill(SPONSOR);
    await terms.locator('[data-agreement-mint-required]').fill('0.5');
    await terms.locator('[data-action-id="mint"]').click();
    await expect(terms).toHaveCount(0);
    await expect(page.locator('#ephemeral-message-container')).toContainText('The agreement program is not deployed on Solana devnet yet.', { timeout: 30_000 });
    await expect(mint).toBeEnabled({ timeout: 30_000 });
    const pinned = index.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pin'));
    expect(pinned.map(request => request.path)).toEqual([`/agreements/${secondCid}/pin`]);
    const agreementRow = index.agreements.get(secondCid)!;
    expect([...index.pins.keys()].sort()).toEqual([secondCid, agreementRow.content.planCid, ...index.plans.get(agreementRow.content.planCid)!.content.designCids].sort());
    expect(index.requests.filter(request => request.method === 'POST' && request.path.endsWith('/onchain'))).toEqual([]);
    expect((await storedAgreements(page)).map((agreement: any) => agreement.onchain || null)).toEqual([null, null]);
    // Cancel in the terms mints nothing either.
    await mint.click();
    await expect(terms).toBeVisible();
    await terms.locator('[data-action-id="cancel"]').click();
    await expect(terms).toHaveCount(0);

    // On a device without the sponsor's wallet, Mint waits for that wallet.
    const receiver = await openOnAnotherDevice(browser, `/agreements/${secondCid}?city=zg&reduceMotion=1`, index, baseURL);
    try {
      const remote = agreementPanel(receiver.page);
      await expect(remote).toBeVisible({ timeout: 90_000 });
      await openAgreementDecision(receiver.page);
      await expect(remote.locator('code.agreement-panel-cid')).toHaveAttribute('title', secondCid);
      await expect(remote.locator('[data-agreement-chain="unminted"] [data-agreement-action="mint"]')).toBeDisabled();
      await expect(remote.locator('[data-agreement-chain="unminted"]')).toContainText(`Connect the sponsor’s Solana wallet (${short(SPONSOR)}) to mint it.`);
      await expect(remote.locator('[data-agreement-action="bet"]')).toHaveCount(0);
    } finally {
      await receiver.context.close();
    }
  });

  test('a community agreement is never minted: the off-chain line, no chain action and no bet, even with a wallet', async ({ mockApi: page }) => {
    test.setTimeout(240_000);
    await injectMockSolanaWallet(page, { publicKey: SPONSOR, providerName: 'phantom' });
    const { layoutId } = await applyLayout(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    const panel = await saveAgreement(page, layoutId, { community: true });
    await propose(page, panel);
    const index = pageIndex(page);
    const [cid] = [...index.agreements.keys()];
    expect(index.agreements.get(cid)!.content.rule).toMatchObject({ electorate: 'community', binding: false });

    await expect(panel.locator('[data-agreement-chain="non-binding"]')).toHaveText('A vote is not minted; its decisions are counted off-chain.');
    await expect(panel.locator('[data-agreement-chain="unminted"], [data-agreement-chain="minted"]')).toHaveCount(0);
    await expect(panel.locator(['mint', 'repropose', 'fund', 'attest', 'execute', 'cancel', 'expire', 'bet']
      .map(action => `[data-agreement-action="${action}"]`).join(', '))).toHaveCount(0);
  });

  test('a minted agreement reads its account: status, decision and escrow, the sponsor’s actions, its lens’s decision, Bet and the published agreements list', async ({ mockApi: page, browser, baseURL }) => {
    test.setTimeout(300_000);
    await injectMockSolanaWallet(page, { publicKey: SPONSOR, providerName: 'phantom' });
    const accounts = new Map<string, Buffer>();
    await serveAgreementAccounts(page, accounts);
    const { layoutId } = await applyLayout(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    const panel = await saveAgreement(page, layoutId, { walletConnected: true });
    await propose(page, panel);
    const index = pageIndex(page);
    const [cid] = [...index.agreements.keys()];
    expect(index.agreements.get(cid)!.content.sponsor).toBe(SPONSOR);
    const [{ id }] = await storedAgreements(page);
    await expect(panel.locator('[data-agreement-chain="unminted"] [data-agreement-action="mint"]')).toBeEnabled();

    // Minted (by the sponsor, elsewhere): the account is on devnet and the index records it.
    const account = agreementAccountAddress(cid, SPONSOR);
    const base: AgreementAccount = { cid, authority: SPONSOR, lenses: [E2E_LENS_MEMBER_KEY], payout: SPONSOR, requiredLamports: SOL / 2n };
    accounts.set(account, encodeAgreementAccount(base));
    index.agreements.get(cid)!.onchain = { chain: 'solana', cluster: 'devnet', account, sponsor: SPONSOR, status: 'active', decision: 'pending' };
    await reopen(page, id);

    // The device keeps the index's record, and the panel reads the account itself.
    const minted = panel.locator('[data-agreement-chain="minted"]');
    await expect(minted).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await storedAgreements(page))[0].onchain?.account).toBe(account);
    await expect(minted.locator('.agreement-chain-account')).toHaveAttribute('href', `https://explorer.solana.com/address/${account}?cluster=devnet`);
    await expect(minted.locator('[data-agreement-chain-status="Active"]')).toHaveText('Active');
    await expect(minted.locator('[data-agreement-chain-decision="Pending"]')).toHaveText('Pending');
    const escrow = minted.locator('.agreement-panel-facts > div').filter({ has: page.locator('dt', { hasText: 'Escrow' }) }).locator('dd');
    await expect(escrow).toHaveText(/^0\sSOL\sof\s0\.5\sSOL$/);
    // The sponsor funds or cancels; Execute waits for the decision; nothing to record or expire yet.
    await expect(minted.locator('[data-agreement-action="fund"]')).toBeEnabled();
    await expect(minted.locator('[data-agreement-action="cancel"]')).toBeEnabled();
    await expect(minted.locator('[data-agreement-action="execute"]')).toBeDisabled();
    await expect(minted.locator('[data-agreement-action="attest"], [data-agreement-action="expire"]')).toHaveCount(0);
    await expect(minted).toContainText('Waiting for its lens to attest the decision.');
    // Fund proposes what the escrow still lacks and Cancel asks first; dismissed, nothing is sent.
    await minted.locator('[data-agreement-action="fund"]').click();
    const amount = page.locator('.cb-dialog--prompt');
    await expect(amount).toContainText('How much SOL should the escrow receive from the sponsor’s wallet?');
    await expect(amount.locator('.cb-dialog__prompt')).toHaveValue('0.5');
    await amount.locator('.cb-dialog__prompt').fill('0.25');
    await expect(amount.locator('.cb-dialog__prompt')).toHaveValue('0.25');
    await amount.locator('[data-action-id="cancel"]').click();
    await expect(amount).toHaveCount(0);
    await expect(escrow).toHaveText(/^0\sSOL\sof\s0\.5\sSOL$/);
    await minted.locator('[data-agreement-action="cancel"]').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Cancel this agreement on chain? It ends for good and the escrow returns to the sponsor.');
    await confirm.getByRole('button', { name: 'Keep it', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(minted.locator('[data-agreement-chain-busy]')).toHaveCount(0);
    await expect(minted.locator('[data-agreement-chain-status="Active"]')).toBeVisible();
    // Its lens member was asked for the decision on this CID.
    expect(index.requests.some(request => request.path.startsWith('/lens/attestations?')
      && request.path.includes(`agreementCid=${cid}`) && request.path.includes('kind=decision'))).toBe(true);

    // Its lens lists the decision: anyone with a wallet can record it on chain.
    index.lensAttestations.push({
      address: ATTESTATION, kind: 'decision', authority: E2E_LENS_MEMBER_KEY,
      payload: { agreementCid: cid, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: `sha256:${'a'.repeat(64)}`, sourceObservedAt: Math.floor(Date.now() / 1000) - 60 },
      expiry: Math.floor(Date.now() / 1000) + 86_400, issuedAt: new Date().toISOString(),
    });
    await reopen(page, id);
    await expect(minted.locator('[data-agreement-action="attest"]')).toBeEnabled({ timeout: 30_000 });
    await expect(minted).toContainText('A lens member has attested the decision: record it on chain.');

    // Recorded and funded: Execute is the way on, and the sponsor can no longer cancel.
    accounts.set(account, encodeAgreementAccount({ ...base, decision: DECISION.satisfied, escrowLamports: SOL / 2n }));
    await reopen(page, id);
    await expect(minted.locator('[data-agreement-chain-decision="Satisfied"]')).toHaveText('Satisfied', { timeout: 30_000 });
    await expect(minted.locator('[data-agreement-action="execute"]')).toBeEnabled();
    await expect(minted.locator('[data-agreement-action="execute"]')).toHaveClass(/\bbtn-primary\b/);
    await expect(minted.locator('[data-agreement-action="cancel"]')).toBeDisabled();
    await expect(minted.locator('[data-agreement-action="attest"]')).toHaveCount(0);

    // Past its deadline and still pending: anyone can expire it; it is no longer funded.
    accounts.set(account, encodeAgreementAccount({ ...base, deadline: Math.floor(Date.now() / 1000) - 3_600 }));
    await reopen(page, id);
    await expect(minted.locator('[data-agreement-action="expire"]')).toBeEnabled({ timeout: 30_000 });
    await expect(minted.locator('[data-agreement-action="fund"]')).toBeDisabled();
    await expect(minted.locator('[data-agreement-action="execute"]')).toBeDisabled();
    await expect(minted).toContainText('Its deadline has passed: anyone can expire it, which returns the escrow to the sponsor.');

    // Back to active and pending. Bet opens its inspector, but this undated agreement cannot trade.
    accounts.set(account, encodeAgreementAccount(base));
    await reopen(page, id);
    await expect(minted.locator('[data-agreement-chain-decision="Pending"]')).toBeVisible({ timeout: 30_000 });
    await openAgreementActions(page);
    await panel.locator('[data-agreement-action="bet"]').click();
    const bet = page.locator('#proposalMarketOverlay');
    await expect(bet.locator('.cb-dialog__title')).toHaveText(`Will ${TITLE} execute on-chain?`, { timeout: 30_000 });
    await expect(bet).toContainText('No deadline set; this agreement cannot have an open market.');
    await expect(bet.getByRole('button', { name: 'Seed USDC market', exact: true })).toHaveCount(0);
    await expect(bet.locator('[data-market-submit]')).toHaveCount(0);
    await bet.locator('.close-circle-btn').click();
    await expect(bet).toHaveCount(0);

    // The Lists panel's agreements: the city's agreements from the index, the minted one (this
    // browser's, so under its local id) with its chain status, opening its panel.
    await closeAgreementPanel(page);
    const list = await openAgreementsList(page);
    const row = agreementListItem(list, id);
    await expect(row).toContainText(TITLE);
    await expect(row.locator('.cb-badge', { hasText: 'Active' })).toBeVisible();
    expect(index.requests.some(request => request.method === 'GET' && /^\/agreements\?.*city=/.test(request.path))).toBe(true);
    await openListedAgreement(list, id);
    await expect(list).toBeHidden();
    await panelStatus(page, 'current');
    await openAgreementDecision(page);
    await expect(page.locator('#agreement-panel-title')).toHaveText(TITLE);

    // Without a wallet (another device): no Fund or Cancel, and Execute and Record decision wait for one.
    const receiver = await openDevice(browser, `/agreements/${cid}?city=zg&reduceMotion=1`, index, accounts, baseURL);
    try {
      await openAgreementDecision(receiver.page);
      const remote = agreementPanel(receiver.page).locator('[data-agreement-chain="minted"]');
      await expect(remote).toBeVisible({ timeout: 90_000 });
      await expect(remote.locator('[data-agreement-chain-status="Active"]')).toBeVisible();
      await expect(remote.locator('[data-agreement-action="attest"]')).toBeDisabled({ timeout: 30_000 });
      await expect(remote.locator('[data-agreement-action="execute"]')).toBeDisabled();
      await expect(remote.locator('[data-agreement-action="fund"], [data-agreement-action="cancel"]')).toHaveCount(0);
      await expect(remote).toContainText('Connect a Solana wallet to act on it.');
    } finally {
      await receiver.context.close();
    }
  });
});
