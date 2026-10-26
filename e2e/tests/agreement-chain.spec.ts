// Purpose: an agreement on chain from its panel (plan-design-agreement.md, "M3 notes"; vocabulary.md,
// "M3 state: browser side"): only a binding owners' agreement has a chain section. Proposed without a
// sponsor wallet it is proposed again with one; its sponsor's wallet mints it (the mint's terms are
// asked and checked; the placeholder program is not on devnet, so nothing is recorded). Once the index
// records its account the panel reads the account itself: status, decision and escrow, the sponsor's
// Fund and Cancel, Record decision once its lens lists the decision, Execute when satisfied and funded,
// Expire after the deadline, open the dated-betting inspector, and the Minted agreements list. A vote is never minted.
// Wallet transactions themselves are out of scope: the chain is the mocked RPC of helpers/agreement-chain.ts.
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { chooseProfileName, openOnAnotherDevice, stubBasemapTiles } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet } from '../helpers/blockchain';
import { mockAllApiRoutes } from '../helpers/mocks/api-routes';
import { attachSharedIndex, E2E_LENS_MEMBER_KEY, pageIndex, SharedIndex } from '../helpers/mocks/shared-server';
import { agreementAccountAddress, encodeAgreementAccount, serveAgreementAccounts, DECISION, AgreementAccount } from '../helpers/agreement-chain';
import {
  applyLayout, agreementPanel, storedAgreements, createFromDetails, openAgreementsList, openMintedAgreements, panelStatus, editorSave, editorClosed,
} from '../helpers/agreements';

test.beforeEach(async ({ mockApi: page }) => {
  await stubBasemapTiles(page);
});

const SPONSOR = '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9';
const ATTESTATION = 'AoVsGaj8MSJ6xwKxfFxo9iZWH3enC8RRTXKH2fx2F8os';
const TITLE = 'Binding block';
const AUTHOR = 'Chain author';
const short = (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`;
const SOL = 1_000_000_000n;

// A new agreement over the applied layout, from its details: owners or a community vote, a title, and
// for owners the lens member the rule names (the member a mint names), saved; its panel current.
async function saveAgreement(page: Page, layoutId: string, { community = false } = {}): Promise<Locator> {
  const editor = await createFromDetails(page, layoutId);
  await editor.locator('[data-agreement-title]').fill(TITLE);
  if (community) await editor.locator('input[name="agreement-electorate"][value="community"]').check();
  else await editor.locator('[data-agreement-rule-form] [data-approval-lens]').fill(E2E_LENS_MEMBER_KEY);
  await editorSave(editor).click();
  await editorClosed(page);
  await panelStatus(page, 'current');
  return agreementPanel(page);
}

// Propose on the panel, a guest naming a profile first; resolves once the panel shows the CID.
async function propose(page: Page, panel: Locator): Promise<void> {
  await panel.locator('[data-agreement-action="propose"]').click();
  await chooseProfileName(page, AUTHOR);
  await panel.locator('[data-agreement-action="propose"]').click();
  await expect(panel.locator('code.agreement-panel-cid')).toBeVisible({ timeout: 30_000 });
}

// Close the panel and open the agreement again from the Agreements list: it reads the index and the
// chain afresh.
async function reopen(page: Page, id: string): Promise<void> {
  await agreementPanel(page).locator('[data-agreement-action="close"]').click();
  await expect(agreementPanel(page)).toBeHidden();
  const list = await openAgreementsList(page);
  await list.locator(`.agreement-item[data-agreement-id="${id}"]`).click();
  await panelStatus(page, 'current');
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

    // Mint asks the escrow execution needs and the payout account and checks them; the program (a
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
    // And the city's minted agreements do not include it.
    const list = await openMintedAgreements(page);
    await expect(list.locator('[data-agreement-list-rows]')).toHaveText('No agreement of this city is minted yet.');
  });

  test('a minted agreement reads its account: status, decision and escrow, the sponsor’s actions, its lens’s decision, Bet and the Minted agreements list', async ({ mockApi: page, browser, baseURL }) => {
    test.setTimeout(300_000);
    await injectMockSolanaWallet(page, { publicKey: SPONSOR, providerName: 'phantom' });
    const accounts = new Map<string, Buffer>();
    await serveAgreementAccounts(page, accounts);
    const { layoutId } = await applyLayout(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    const panel = await saveAgreement(page, layoutId);
    await propose(page, panel);
    const index = pageIndex(page);
    const [cid] = [...index.agreements.keys()];
    expect(index.agreements.get(cid)!.content.sponsor).toBe(SPONSOR);
    const [{ id }] = await storedAgreements(page);
    await expect(panel.locator('[data-agreement-chain="unminted"] [data-agreement-action="mint"]')).toBeEnabled();

    // Minted (by the sponsor, elsewhere): the account is on devnet and the index records it.
    const account = agreementAccountAddress(cid, SPONSOR);
    const base: AgreementAccount = { cid, authority: SPONSOR, lens: E2E_LENS_MEMBER_KEY, payout: SPONSOR, requiredLamports: SOL / 2n };
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
    await amount.locator('[data-action-id="cancel"]').click();
    await expect(amount).toHaveCount(0);
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
    await expect(minted).toContainText('Its lens has attested the decision: record it on chain.');

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
    await panel.locator('[data-agreement-action="bet"]').click();
    const bet = page.locator('#proposalMarketOverlay');
    await expect(bet.locator('.cb-dialog__title')).toHaveText(`Will ${TITLE} execute on-chain?`, { timeout: 30_000 });
    await expect(bet).toContainText('No deadline set; this agreement cannot have an open market.');
    await expect(bet.getByRole('button', { name: 'Seed USDC market', exact: true })).toHaveCount(0);
    await expect(bet.locator('[data-market-submit]')).toHaveCount(0);
    await bet.locator('.close-circle-btn').click();
    await expect(bet).toHaveCount(0);

    // The Minted agreements list: the city's minted agreements from the index, each opening its panel.
    await agreementPanel(page).locator('[data-agreement-action="close"]').click();
    const list = await openMintedAgreements(page);
    const row = list.locator(`.agreement-item[data-agreement-cid="${cid}"]`);
    await expect(row).toContainText(TITLE);
    await expect(row).toContainText(`1 design · Active · ${short(account)}`);
    expect(index.requests.some(request => request.method === 'GET' && /^\/agreements\?.*minted=1/.test(request.path))).toBe(true);
    await row.click();
    await expect(list).toHaveCount(0);
    await panelStatus(page, 'current');
    await expect(page.locator('#agreement-panel-title')).toHaveText(TITLE);

    // Without a wallet (another device): no Fund or Cancel, and Execute and Record decision wait for one.
    const receiver = await openDevice(browser, `/agreements/${cid}?city=zg&reduceMotion=1`, index, accounts, baseURL);
    try {
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
