// Proposal details and parcel tools actions that M2 and M3 kept: area and reference metrics, ownership
// estimates, and claiming and minting a parcel anchor. Consent, payout terms, owner offers, support and
// the design's market card left the design with M2 (plan-design-agreement.md): decisions are an
// agreement's, and only agreements are minted besides parcel anchors (M3).
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { openCity, openParcel, showProposal, PARCEL_ID, showProposalTab } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, stubSolanaParcelMint, waitForBlockchainRuntime } from '../helpers/blockchain';

const SOLANA_WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const PARCEL_PROGRAM = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';

async function expandProposalDetails(page: import('@playwright/test').Page): Promise<void> {
  const expand = page.locator('#proposal-details-panel').getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
}

async function openProposalSection(page: import('@playwright/test').Page, section: 'land'): Promise<void> {
  await showProposalTab(page, 'overview');
  const details = page.locator(`#proposal-details-panel details[data-proposal-section="${section}"]`);
  await details.locator(':scope > summary').click();
  await expect(details).toHaveJSProperty('open', true);
}

test.describe('Proposal actions @features', () => {
  test('area metrics distinguish site area, partial source sums and unknown measurements', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const ids = await page.evaluate(parcelId => {
      const w = window as any;
      const base = { goal: 'as-is', lifecycleStatus: 'Active' };
      const site = { type: 'Polygon', coordinates: [[[0,0],[0.001,0],[0.001,0.001],[0,0.001],[0,0]]] };
      return {
        partial: w.proposalStorage.addProposal({ ...base, title: 'Site and source areas', site, cadastreParcelIds: [parcelId, 'area-unloaded'] }),
        unknown: w.proposalStorage.addProposal({ ...base, title: 'Unknown source area', cadastreParcelIds: ['area-unloaded'] })
      };
    }, PARCEL_ID);
    const areas = await page.evaluate(({ partial, unknown }) => {
      const w = window as any;
      const partialProposal = w.proposalStorage.getProposal(partial);
      const sources = w.getProposalAreaMap(partialProposal);
      return { sourceTotal: sources.totalArea, sourceCount: sources.sourceCount, declaredCount: sources.declaredCount,
        primary: w.computeProposalMetrics(partialProposal).area,
        unknown: w.computeProposalMetrics(w.proposalStorage.getProposal(unknown)).area,
        withoutSite: w.computeProposalMetrics({ ...partialProposal, site: null }).area };
    }, ids);
    expect(areas).toMatchObject({ sourceTotal: null, sourceCount: 1, declaredCount: 2, unknown: null, withoutSite: null });
    expect(areas.primary).toBeGreaterThan(12000);
    await showProposal(page, ids.partial);
    await expandProposalDetails(page);
    // The site area is the Overview's one area figure; the source parcels' sum is under Details.
    const site = page.locator('[data-proposal-area-basis="site"]');
    const sources = page.locator('[data-proposal-area-basis="source-parcels"]');
    await expect(site.locator('.metric-label')).toHaveText('Site area:');
    await expect(site.locator('.metric-value')).toContainText('m²');
    const siteArea = Number((await site.locator('.metric-value').innerText()).replace(/[^\d]/g, ''));
    expect(siteArea).toBeGreaterThan(12000);
    expect(siteArea).toBeLessThan(12500);
    await openProposalSection(page, 'land');
    await expect(sources).toHaveAttribute('data-area-complete', 'false');
    await expect(sources.locator('.metric-label')).toHaveText('Available source parcel area:');
    await expect(sources.locator('.metric-value')).not.toHaveText('—');
    await expect(page.locator('.proposal-area-coverage')).toHaveText('Areas available for 1 of 2 declared references.');
    await showProposal(page, ids.unknown);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');
    await expect(site).toHaveCount(0);
    await expect(sources.locator('.metric-value')).toHaveText('—');
    await expect(page.locator('.proposal-area-coverage')).toHaveText('Areas available for 0 of 1 declared references.');
  });

  test('reference comparison counts all loaded matches before showing twelve rows', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const id = await page.evaluate(() => {
      const storage = (window as any).proposalStorage;
      const base = { goal: 'as-is', lifecycleStatus: 'Active', cadastreParcelIds: ['reference-card-1', 'reference-card-2'],
        parcelSet: { parcelSource: { sourceId: 'e2e:reference-fixture', snapshotId: null } } };
      const id = storage.addProposal({ ...base, title: 'Reference comparison target' });
      for (let i = 0; i < 15; i++) storage.addProposal({ ...base, title: `Reference comparison ${i}`,
        cadastreParcelIds: i < 13 ? base.cadastreParcelIds : ['reference-card-2'] });
      return id;
    });
    await showProposal(page, id);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');
    const card = page.locator('.proposal-parcel-set-card');
    await expect(card.getByRole('heading')).toHaveText('Designs sharing references');
    await expect(card.locator('p')).toHaveText('2 declared cadastral references. Of 15 loaded matches, 13 use the same references and 2 share some. Showing 12.');
    await expect(card.locator('[data-related-proposal-id]')).toHaveCount(12);
    const firstRelated = card.locator('[data-related-proposal-id]').first();
    const firstRelatedId = await firstRelated.getAttribute('data-related-proposal-id');
    expect(firstRelatedId).toBeTruthy();
    if (!firstRelatedId) throw new Error('The first related proposal has no local identity.');
    await firstRelated.click();
    await expect.poll(() => page.evaluate(() => (window as any).currentlyHighlightedProposalId)).toBe(firstRelatedId);
    await expect(page.locator('#proposal-details-panel').getByText('Reference comparison 0', { exact: true })).toBeVisible();
  });

  test('unloaded source references are not presented as removed parcels', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const id = await page.evaluate(parcelId => {
      const w = window as any;
      return w.proposalStorage.addProposal({ title: 'Source reference states', goal: 'as-is', lifecycleStatus: 'Active',
        cadastreParcelIds: [parcelId, 'source-not-loaded'] });
    }, PARCEL_ID);
    await showProposal(page, id);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');
    const rows = page.locator('#proposal-details-panel .proposal-parcel-row');
    const source = page.locator('#proposal-details-panel .proposal-parcel-row[data-parcel-id="source-not-loaded"]');
    await expect(source).toHaveAttribute('data-reference-state', 'unloaded');
    await expect(source.locator('.parcel-status')).toHaveText('Source geometry not loaded');
    await expect(source).not.toHaveAttribute('data-parcel-replaced', 'true');
    await expect(source).not.toContainText('Single owner');
    await expect(rows.filter({ hasText: 'Removed' })).toHaveCount(0);
    await expect(page.locator(`#proposal-details-panel .proposal-parcel-row[data-parcel-id="${PARCEL_ID}"]`))
      .toHaveAttribute('data-reference-state', 'available');
  });

  test('ownership estimates show the modeled owner entries the record carries', async ({ mockApi: page }) => {
    await openCity(page);
    await page.evaluate(() => (window as any).i18n.setLanguage('en'));
    const id = await page.evaluate(parcelId => (window as any).proposalStorage.addProposal({
      title: 'Ownership estimate fixture', goal: 'as-is', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
      ownershipAndAcquisitionStats: { ownerEntryCount: 99, ownershipCounts: { individual: 4 } },
    }), PARCEL_ID);

    await showProposal(page, id);
    await expandProposalDetails(page);
    await openProposalSection(page, 'land');
    await expect(page.locator('[data-ownership-estimates]')).toContainText('may repeat across parcels');
    const estimates = page.locator('#proposal-details-panel .metric-group').filter({ hasText: 'Listed owner entries:' });
    await expect(estimates.locator('.metric-value')).toHaveText('99');
  });

  test('claim tools keep minting unavailable until a wallet is connected', async ({ mockApi: page }) => {
    await openCity(page);
    await openParcel(page, 'tools');
    const claim = page.locator('#claimButton');
    await expect(claim).toBeVisible();
    await expect(claim).toBeDisabled();
  });

  test('connected parcel owner mints from the parcel tools dialog and receives a confirmed transaction', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await openCity(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'SolanaParcelClient', 'solanaWeb3']);
    await stubSolanaParcelMint(page, { parcelProgramId: PARCEL_PROGRAM });

    // The metadata service is the app's external asset boundary. RPC instruction creation,
    // wallet signing, sending and confirmation remain on their normal production code paths.
    await page.route('**/metadata', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ metadataUrl: 'ipfs://e2e-parcel-metadata.json' }),
    }));
    await openParcel(page, 'tools');
    const mint = page.locator('#mintAndClaimButton');
    await expect(mint).toBeEnabled();
    await mint.click();
    const mintDialog = page.locator('.parcel-mint-modal');
    await expect(mintDialog).toBeVisible();
    await mintDialog.locator('.parcel-mint-close').click();
    await expect(mintDialog).toBeHidden();
    await expect(mint).toBeEnabled();
    await mint.click();
    await expect(mintDialog).toBeVisible();
    await mintDialog.getByRole('button', { name: 'Mint', exact: true }).click();

    const success = page.locator('#parcel-mint-success-modal');
    await expect(success).toBeVisible({ timeout: 15000 });
    await expect(success).toContainText('Parcel has been minted');
    await expect(success.locator('a[href*="explorer.solana.com/tx/"]')).toBeVisible();
    await success.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(success).toBeHidden();
  });

  // The anchor mint (solana/parcel-mint.js) asks the chain first: an anchor already there is reported
  // as minted with no transaction, and the cached status is refreshed from what the chain said.
  test('mintParcelSolana short-circuits when the parcel anchor is already minted and caches the result', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, { publicKey: SOLANA_WALLET, providerName: 'phantom' });
    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'SolanaParcelClient', 'solanaWeb3']);
    await stubSolanaParcelMint(page, { alreadyMinted: true, parcelProgramId: PARCEL_PROGRAM, tokenId: PARCEL_PROGRAM });

    const result = await page.evaluate(async programId => {
      const w = window as any;
      const sends: string[] = [];
      const connection = w.SolanaChainDataLoader.getConnection('devnet');
      const send = connection.sendRawTransaction;
      connection.sendRawTransaction = async (...args: unknown[]) => { sends.push('send'); return send(...args); };
      const setCalls: unknown[][] = [];
      const originalSet = w.SolanaChainDataLoader.setParcelMintStatusCache;
      w.SolanaChainDataLoader.setParcelMintStatusCache = (...args: unknown[]) => { setCalls.push(args); return args; };
      try {
        const minted = await w.mintParcelSolana('HR-335754-1234', 'ipfs://parcel-image', programId, 'devnet');
        return { minted, setCalls, sends };
      } finally {
        w.SolanaChainDataLoader.setParcelMintStatusCache = originalSet;
      }
    }, PARCEL_PROGRAM);

    expect(result.minted).toMatchObject({ txHash: null, alreadyMinted: true });
    expect(typeof result.minted.tokenId).toBe('string');
    expect(result.minted.tokenId).toBeTruthy();
    // Nothing was sent: the anchor exists.
    expect(result.sends).toEqual([]);
    expect(result.setCalls).toHaveLength(1);
    expect(result.setCalls[0].slice(0, 3)).toEqual(['HR-335754-1234', PARCEL_PROGRAM, 'devnet']);
    expect(result.setCalls[0][3]).toMatchObject({ minted: true });
  });
});
