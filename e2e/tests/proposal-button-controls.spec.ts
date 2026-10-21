// Exercise proposal action buttons and assert the resulting UI and stored state.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal, chooseTermsForShare, PARCEL_GEOMETRY, PARCEL_ID } from '../helpers/runtime';
import { attachSharedProposalServer, createSharedProposalServer } from '../helpers/mocks/shared-server';
import { connectWalletByConnectorId, injectMockEvmWallet, injectMockSolanaWallet, routeSolanaReads, waitForBlockchainRuntime } from '../helpers/blockchain';
import { installProposalEvmBoundary, PROPOSAL_EVM_ACCOUNT } from '../helpers/proposal-chain-boundary';
import { installSolanaProposalAccount } from '../helpers/solana-proposal-account';

async function addProposal(page: import('@playwright/test').Page, proposal: Record<string, unknown>): Promise<string> {
  return page.evaluate(record => (window as any).proposalStorage.addProposal(record), proposal);
}

async function showExpandedProposal(page: import('@playwright/test').Page, proposalId: string): Promise<void> {
  await showProposal(page, proposalId);
  const panel = page.locator('#proposal-details-panel');
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(panel.locator('.panel-body')).toBeVisible();
}

async function openLandSection(page: import('@playwright/test').Page): Promise<void> {
  const section = page.locator('#proposal-details-content details[data-proposal-section="land"]');
  if (!(await section.evaluate(element => (element as HTMLDetailsElement).open))) {
    await section.locator(':scope > summary').click();
  }
  await expect(section).toHaveJSProperty('open', true);
}

async function establishLocalProfile(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('#username-display').click();
  await expect(page.locator('#welcome-modal')).toBeVisible();
  await page.locator('#username-input').fill('Proposal action tester');
  await page.locator('#welcome-submit-btn').click();
  await expect(page.locator('#welcome-modal')).toBeHidden();
}

async function mockEmptySolanaRpc(page: import('@playwright/test').Page): Promise<void> {
  await routeSolanaReads(page, async route => {
    const input = route.request().postDataJSON() as any;
    const answer = (item: any) => {
      const context = { context: { slot: 1 } };
      const value = item.method === 'getBalance' ? { ...context, value: 1_000_000_000 }
        : item.method === 'getTokenAccountBalance' ? { context: { slot: 1 }, value: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' } }
          : item.method === 'getLatestBlockhash' ? { ...context, value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ', lastValidBlockHeight: 99 } }
            : item.method === 'getMultipleAccounts' ? { ...context, value: (item.params?.[0] || []).map(() => null) }
              : item.method === 'getProgramAccounts' || item.method === 'getSignaturesForAddress' ? []
                : { ...context, value: null };
      return { jsonrpc: '2.0', id: item.id, result: value };
    };
    return route.fulfill({ json: Array.isArray(input) ? input.map(answer) : answer(input) });
  });
}

test.describe('proposal detail button controls @features', () => {
  test('Donate and Pledge close buttons dismiss their support dialogs', async ({ mockApi: page }) => {
    const wallet = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
    const proposalAccount = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
    await injectMockSolanaWallet(page, { publicKey: wallet, providerName: 'phantom' });
    await mockEmptySolanaRpc(page);
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaPledgeBridge', 'SolanaPledgeClient', 'ProposalSupportView']);
    const proposalId = await addProposal(page, {
      title: 'Support dialog close test', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID],
      isMinted: true,
      nft: { chain: 'solana-devnet', contract: proposalAccount, tokenId: proposalAccount },
    });
    await showExpandedProposal(page, proposalId);
    const panel = page.locator('#proposal-details-panel');
    const dialog = page.locator('#proposalBoostOverlay');

    await panel.locator('.btn-donate-proposal').click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close donation dialog' }).click();
    await expect(dialog).toBeHidden();

    await panel.locator('.btn-pledge-proposal').click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close pledge dialog' }).click();
    await expect(dialog).toBeHidden();
  });

  test('Connect Solana wallet opens the wallet picker for a minted proposal', async ({ mockApi: page }) => {
    await mockEmptySolanaRpc(page);
    await openCity(page);
    const proposalId = await addProposal(page, {
      title: 'Solana support proposal', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID],
      isMinted: true,
      nft: { chain: 'solana-devnet', contract: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg', tokenId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg' },
    });
    await showExpandedProposal(page, proposalId);
    const connect = page.locator('#proposal-details-panel .btn-connect-proposal-support');
    await expect(connect).toBeVisible();
    await connect.click();
    const walletPicker = page.locator('.wallet-modal-overlay');
    await expect(walletPicker).toBeVisible();
    await expect(walletPicker.locator('[data-wallet-options]')).toBeVisible();
    await walletPicker.locator('[data-wallet-modal-close]').click();
    await expect(walletPicker).toBeHidden();
  });

  test('Copy hash copies the declared proposal oracle recipe digest', async ({ mockApi: page }) => {
    const proposalAccount = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
    const owner = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
    await mockEmptySolanaRpc(page);
    const digest = `sha256:${'a'.repeat(64)}`;
    await page.route('**/oracle/recipes/proposal-lifecycle-v1?*', route => route.fulfill({ json: {
      recipe: { id: 'proposal-lifecycle-v1', hash: digest, subject: { proposalAccount }, outcomes: { executed: 'YES', cancelled: 'NO' } },
    } }));
    await page.route('**/oracle/events?*', route => route.fulfill({ json: { events: [] } }));
    await openCity(page);
    await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'SolanaMarketBridge', 'SolanaAcceptanceClient', 'solanaWeb3', 'ProposalMarketView']);
    await installSolanaProposalAccount(page, { proposal: proposalAccount, owner });
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const proposalId = await addProposal(page, {
      title: 'Oracle recipe hash', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID], isMinted: true,
      nft: { chain: 'solana-devnet', contract: proposalAccount, tokenId: proposalAccount },
    });
    await showExpandedProposal(page, proposalId);
    const marketSection = page.locator('#proposal-details-panel details[data-proposal-section="market"]');
    if (!(await marketSection.evaluate(element => (element as HTMLDetailsElement).open))) {
      await marketSection.locator(':scope > summary').click();
    }
    const card = page.locator('.proposal-market-summary');
    const copy = card.getByRole('button', { name: 'Copy hash', exact: true });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(digest);
  });

  test('a published proposal lens button opens its saved, read-only lens', async ({ mockApi: page }) => {
    await openCity(page);
    const proposalId = await addProposal(page, {
      title: 'Lens-backed proposal',
      goal: 'park',
      lifecycleStatus: 'Active',
      cadastreParcelIds: [PARCEL_ID],
      isMinted: true,
      nft: { chain: 'ethereum', contract: '0x1234567890123456789012345678901234567890', tokenId: '42' },
      lens: ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'],
    });
    await showExpandedProposal(page, proposalId);
    const record = page.locator('#proposal-details-content details[data-proposal-section="record"]');
    if (!(await record.evaluate(element => (element as HTMLDetailsElement).open))) {
      await record.locator(':scope > summary').click();
    }
    await expect(record).toHaveJSProperty('open', true);

    const trigger = page.locator('#proposal-details-content .proposal-lens-button');
    await expect(trigger).toBeEnabled();
    await trigger.click();
    const modal = page.locator('.lens-modal-overlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('This lens is baked into the proposal and cannot be edited.');
    await modal.locator('.lens-close-btn').click();
    await expect(modal).toBeHidden();
  });

  test('parcel-set related proposal and activity links navigate to the selected scope', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const parcelSource = { sourceId: 'hr-cadastre', snapshotId: null };
    const sourceId = await addProposal(page, {
      title: 'Source plan', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID],
      parcelSet: { setHash: 'e2e-parcel-set-hash', parcelSource },
    });
    const relatedId = await addProposal(page, {
      title: 'Related plan', goal: 'square', lifecycleStatus: 'Active', cadastreParcelIds: [PARCEL_ID],
      parcelSet: { parcelSource },
    });

    await showExpandedProposal(page, sourceId);
    await openLandSection(page);
    const relatedButton = page.locator(`#proposal-details-content [data-related-proposal-id="${relatedId}"]`);
    await expect(relatedButton).toBeVisible();
    await relatedButton.click();
    await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getSelected()?.proposalId)).toBe(relatedId);
    await expect(page.locator('#planning-inspector')).toContainText('Related plan');
    await showExpandedProposal(page, relatedId);

    await showExpandedProposal(page, sourceId);
    await openLandSection(page);
    const proposalActivity = page.locator('#proposal-details-content .activity-scope-link[data-activity-scope="proposalId"]');
    await proposalActivity.click();
    const activity = page.locator('.game-log-modal');
    await expect(activity).toBeVisible();
    await expect(activity.locator('[data-activity-scope-chip]')).toContainText(sourceId);
    await activity.getByRole('button', { name: 'Clear scope' }).click();
    await expect(activity.locator('[data-activity-scope-chip]')).toBeHidden();
    await activity.locator('.game-log-modal-close').click();
    await expect(activity).toBeHidden();

    await showExpandedProposal(page, sourceId);
    await openLandSection(page);
    await page.locator('#proposal-details-content .activity-scope-link[data-activity-scope="parcelSet"]').click();
    await expect(activity.locator('[data-activity-scope-chip]')).toContainText(/Land:/);
  });

  test('simulating an open ownership purchase preserves its shared offer and survives reload', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    const proposalId = await addProposal(page, {
      title: 'Open ownership offer',
      goal: 'parcelBased',
      lifecycleStatus: 'Active',
      offer: 100, funded: false,
      cadastreParcelIds: [PARCEL_ID],
      facets: { ownership: 'third-party' },
      ownershipTransferProposal: { direction: 'from-me', recipientScope: 'any', status: 'open' },
    });
    await showExpandedProposal(page, proposalId);

    const buy = page.locator('#proposal-details-panel .proposal-buy-btn');
    await expect(buy).toHaveText('Simulate purchase');
    await expect(page.locator('#proposal-details-panel .proposal-purchase-hint')).toContainText('No payment is made');
    const before = await page.evaluate(id => {
      const w = window as any; const p = w.proposalStorage.getProposal(id);
      return { otp: p.ownershipTransferProposal, hash: w.proposalConsentFingerprint(p) };
    }, proposalId);
    await buy.click();
    await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage.getProposal(id)?.localPurchaseSimulation, proposalId)).toBe(true);
    await expect(page.locator('#proposal-details-panel .proposal-purchase-simulation')).toHaveText('Purchase simulated in this browser');
    await expect(page.locator('#proposal-details-panel .proposal-buy-btn')).toHaveCount(0);
    await page.reload();
    await expect.poll(() => page.evaluate(id => !!(window as any).proposalStorage?.getProposal(id)?.localPurchaseSimulation, proposalId)).toBe(true);
    await showExpandedProposal(page, proposalId);
    await expect(page.locator('#proposal-details-panel .proposal-purchase-simulation')).toHaveText('Purchase simulated in this browser');
    await expect(page.locator('#proposal-details-panel .proposal-buy-btn')).toHaveCount(0);
    const after = await page.evaluate(id => {
      const w = window as any; const p = w.proposalStorage.getProposal(id);
      const shared = w.__formationDepth.preparePublishRecord(p).proposal;
      return { lifecycle: p.lifecycleStatus, funded: p.funded, executedAt: p.executedAt || null,
        otp: p.ownershipTransferProposal, hash: w.proposalConsentFingerprint(p),
        buyer: p.localPurchaseSimulation.buyerAgentId,
        modeledOwner: w.PersistentStorage.getItem(`parcel_${p.cadastreParcelIds[0]}_owner`),
        sharedHasSimulation: Object.hasOwn(shared, 'localPurchaseSimulation'),
        sharedOfferOpen: w.isProposalOpenSaleOffer(shared) };
    }, proposalId);
    expect(after).toMatchObject({ lifecycle: 'Active', funded: false, executedAt: null,
      otp: before.otp, hash: before.hash, sharedHasSimulation: false, sharedOfferOpen: true });
    expect(after.modeledOwner).toBe(after.buyer);
  });

  test('the grain-score Repeat control runs another inspection and returns to its result', async ({ mockApi: page }) => {
    await openCity(page);
    await createSpace(page, 'park');
    await page.locator('#proposals-button').click();
    await page.locator('#proposal-list-actions > summary').click();
    await page.locator('#roosterScoreButton').click();

    const panel = page.locator('#grain-score-panel');
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 20000 });
    const firstScore = await panel.locator('[data-grain-role="totalScore"]').innerText();
    const repeat = panel.locator('[data-grain-action="repeat"]');
    await expect(repeat).toBeVisible();
    await repeat.click();
    await expect(page.locator('#grain-score-overlay')).toBeVisible();
    await expect(panel.locator('[data-grain-role="result"]')).toBeVisible({ timeout: 20000 });
    await expect(panel.locator('[data-grain-role="totalScore"]')).toHaveText(firstScore);
  });

  test('Share uploads the selected proposal, copies its link, and switches to the whole applied plan', async ({ mockApi: page }) => {
    const server = createSharedProposalServer();
    await attachSharedProposalServer(page, server);
    await openCity(page);
    await establishLocalProfile(page);
    const proposalId = await createSpace(page, 'park');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await showExpandedProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();
    await chooseTermsForShare(page);

    const share = page.locator('.share-modal-overlay');
    await share.getByRole('button', { name: 'Upload', exact: true }).click();
    const link = share.locator('.share-modal-link').first();
    await expect(link).toHaveValue(/\/proposals\/\d+\?.*city=zg/);
    expect(server.records.size).toBe(1);
    const url = await link.inputValue();
    await share.getByRole('button', { name: 'Copy URL', exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    await share.locator('.share-modal-plan-btn').click();
    const plan = page.locator('.share-plan-panel');
    await expect(plan).toBeVisible({ timeout: 30000 });
    await expect(plan.locator('.share-plan-row')).toContainText(/park/i);
    // The originating share dialog closes only after the applied-plan panel is ready.
    await expect(share).toBeHidden();

    const uploadedMode = plan.getByRole('button', { name: 'Uploaded', exact: true });
    await uploadedMode.click();
    await expect(uploadedMode).toHaveAttribute('aria-pressed', 'true');
    const pendingMode = plan.getByRole('button', { name: 'Not uploaded yet', exact: true });
    await pendingMode.click();
    await expect(pendingMode).toHaveAttribute('aria-pressed', 'true');
    await plan.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(plan).toBeHidden();
  });

  test('the minted proposal share row copies its chain explorer link', async ({ mockApi: page }) => {
    await openCity(page);
    await establishLocalProfile(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const proposalId = await addProposal(page, {
      title: 'Minted proposal link',
      goal: 'park',
      lifecycleStatus: 'Active',
      cadastreParcelIds: [PARCEL_ID],
      isMinted: true,
      nft: { chain: 'solana-devnet', contract: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1', tokenId: 'MintedProposalAccount' },
    });
    await showExpandedProposal(page, proposalId);
    await page.locator('#proposal-details-footer .btn-share-proposal').click();

    const share = page.locator('.share-modal-overlay');
    const mintedLink = share.locator('.share-modal-link').last();
    await expect(mintedLink).toHaveValue(/explorer\.solana\.com\/address\/MintedProposalAccount\?cluster=devnet/);
    await share.getByRole('button', { name: 'Copy URL', exact: true }).last().click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(await mintedLink.inputValue());
  });

  test('missing parcel mint prerequisites can be cancelled or kept in memory without a transaction', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { account: PROPOSAL_EVM_ACCOUNT, chainIdHex: '0x14a34', walletKind: 'metamask' });
    await openCity(page);
    await establishLocalProfile(page);
    await connectWalletByConnectorId(page, 'metamask');
    await installProposalEvmBoundary(page, { parcelAlreadyMinted: false });
    const proposalId = await page.evaluate(({ parcelId, geometry }) => (window as any).proposalStorage.addProposal({
      proposalId: 'missing-parcel-prerequisite-source', title: 'Missing parcel prerequisite',
      description: 'A saved legacy proposal with an existing geometry.', goal: 'park', lifecycleStatus: 'Active',
      kind: 'community-vote', termsConfirmed: true,
      city: 'zagreb',
      cadastreParcelIds: [parcelId], geometry, structureProposal: { kind: 'park', geometry, applied: true },
      lens: [{ address: '0x1234567890abcdef1234567890abcdef12345678' }],
      screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }), { parcelId: PARCEL_ID, geometry: PARCEL_GEOMETRY });
    await showExpandedProposal(page, proposalId);
    await page.locator('.btn-share-proposal').click();
    const share = page.locator('.share-modal-overlay');
    const openMissingPrerequisites = async () => {
      await share.getByRole('button', { name: 'Mint', exact: true }).click();
      const prompt = page.locator('.cb-dialog-overlay--confirm');
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText('not represented as an NFT');
      return prompt;
    };

    const firstPrompt = await openMissingPrerequisites();
    await firstPrompt.locator('.close-circle-btn').click();
    await expect(firstPrompt).toBeHidden();
    await expect(share).toContainText('Mint cancelled.');

    const secondPrompt = await openMissingPrerequisites();
    await secondPrompt.getByRole('button', { name: 'Create in memory', exact: true }).click();
    await expect(secondPrompt).toBeHidden();
    await expect(share).toContainText('Mint skipped. Proposal remains in memory.');
    expect(await page.evaluate(() => (window as any).__proposalEvmBoundary.filter((method: string) => method === 'eth_sendTransaction'))).toEqual([]);
  });
});
