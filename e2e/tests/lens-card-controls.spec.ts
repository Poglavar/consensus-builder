// Verify lens-card actions and their visible or stored results.
import { test, expect } from '../helpers/fixtures';
import { openCity, PARCEL_ID } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockSolanaWallet, routeSolanaReads, waitForBlockchainRuntime } from '../helpers/blockchain';
import { selectNativeOption } from '../helpers/controls';

const WALLET = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
const MEMBER = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
const MEMBER_TWO = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const ATTESTATION = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
const PROPOSAL_ACCOUNT = ATTESTATION;
const service = 'https://lens-card.example.test';
const serviceTwo = 'https://lens-card-second.example.test';

async function encodeProposalAccount(page: import('@playwright/test').Page, lensMembers = [MEMBER]): Promise<string> {
  return page.evaluate(({ owner, parcelId, lensMembers }) => {
    const bytes: number[] = [26, 94, 189, 187, 116, 136, 53, 33]; // Anchor Proposal account discriminator.
    const pushU32 = (value: number) => {
      bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    };
    const pushU64 = (value: bigint) => {
      for (let index = 0; index < 8; index++) {
        bytes.push(Number(value & 0xffn));
        value >>= 8n;
      }
    };
    const pushBytes = (value: Uint8Array) => bytes.push(...value);
    const pushString = (value: string) => {
      const encoded = new TextEncoder().encode(value);
      pushU32(encoded.length);
      pushBytes(encoded);
    };
    const web3 = (window as any).solanaWeb3;
    pushU64(77n); // proposal_id
    pushBytes(new web3.PublicKey(owner).toBytes());
    pushU32(1); pushString(parcelId); // parcel_ids
    bytes.push(0); // is_conditional
    pushString(''); // image_uri
    bytes.push(1, 0); // acceptance_possible, active status
    pushU64(0n); pushU64(0n); pushU64(0n); // SOL balance, token balance, acceptance count
    pushU32(0); // accepted_parcels
    pushU32(lensMembers.length); lensMembers.forEach(member => pushBytes(new web3.PublicKey(member).toBytes())); // lens
    bytes.push(0, 0); // bump, verdict_may_execute
    pushBytes(new Uint8Array(32)); // site_hash
    bytes.push(0, 0, 3); // open_ground, open_ground_cleared, v3 layout version
    return btoa(String.fromCharCode(...bytes));
  }, { owner: WALLET, parcelId: PARCEL_ID, lensMembers });
}

test('lens Attest signs the checked ownership challenge; Say yes and Submit verdict report invalid inputs', async ({ mockApi: page }) => {
  const submitted: any[] = [];
  const ignoredFirstService: any[] = [];
  const message = `${MEMBER_TWO} ownership attestation\nWallet ${WALLET} owns parcel ${PARCEL_ID}.\nChallenge: button-test-nonce`;
  await page.route('**/lenses/members', route => route.fulfill({ json: { members: [
    { key: MEMBER, name: 'First fixture member', serviceUrl: service },
    { key: MEMBER_TWO, name: 'Second fixture member', serviceUrl: serviceTwo },
  ] } }));
  await page.route(`${service}/lens/challenge`, route => {
    ignoredFirstService.push(route.request().postDataJSON());
    return route.fulfill({ json: { challenge: 'wrong-member-nonce', message: `${MEMBER} challenge`, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  });
  await page.route(`${serviceTwo}/lens/challenge`, route => {
    expect(route.request().postDataJSON()).toEqual({ parcelUid: PARCEL_ID, owner: WALLET });
    return route.fulfill({ json: { challenge: 'button-test-nonce', message, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  });
  await page.route(`${serviceTwo}/lens/ownership`, route => {
    submitted.push(route.request().postDataJSON());
    return route.fulfill({ json: { address: ATTESTATION, accountHash: 'checked-fixture-hash' } });
  });
  await page.route(`${service}/lens/attestations**`, route => route.fulfill({ json: { attestations: [] } }));
  await page.route(`${serviceTwo}/lens/attestations**`, route => route.fulfill({ json: { attestations: [] } }));
  // Keep the production Solana connection and account decoders; the external chain is empty.
  await routeSolanaReads(page, async route => {
    const input = route.request().postDataJSON();
    const answer = (item: any) => {
      const context = { context: { slot: 1 } };
      const result = item.method === 'getBalance' ? { ...context, value: 1_000_000_000 }
        : item.method === 'getMultipleAccounts' ? { ...context, value: (item.params?.[0] || []).map(() => null) }
          : ['getProgramAccounts', 'getSignaturesForAddress'].includes(item.method) ? []
            : { ...context, value: null };
      return { jsonrpc: '2.0', id: item.id, result };
    };
    return route.fulfill({ json: Array.isArray(input) ? input.map(answer) : answer(input) });
  });
  await injectMockSolanaWallet(page, { publicKey: WALLET });
  await openCity(page);
  await connectWalletByConnectorId(page, 'solana-phantom');
  await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'SolanaAcceptanceBridge', 'solanaWeb3']);
  await page.evaluate(() => {
    const w = window as any;
    const provider = w.solanaWalletManager.getProvider();
    provider.signMessage = async (bytes: Uint8Array) => {
      w.__lensSignedMessage = new TextDecoder().decode(bytes);
      return { signature: new Uint8Array(64).fill(7) };
    };
    provider.signTransaction = async () => { throw new Error('Invalid input must never ask for a transaction signature'); };
  });
  const id = await page.evaluate(({ parcelId, member, memberTwo, account }) => (window as any).proposalStorage.addProposal({
    title: 'Ownership attestation controls', goal: 'park', lifecycleStatus: 'Active', cadastreParcelIds: [parcelId],
    isMinted: true, nft: { chain: 'solana-devnet', contract: member, tokenId: account }, lens: [member, memberTwo]
  }), { parcelId: PARCEL_ID, member: MEMBER, memberTwo: MEMBER_TWO, account: ATTESTATION });
  await page.locator('#proposals-button').click();
  await page.locator(`#proposals-sheet [data-proposal-id="${id}"] .proposal-list-details-btn`).click();
  const panel = page.locator('#proposal-details-panel');
  if (await panel.locator('#proposal-details-minimize').getAttribute('aria-expanded') === 'false') await panel.locator('#proposal-details-minimize').click();
  await panel.locator('[data-proposal-section="verification"] > summary').click();
  const card = panel.locator('.proposal-lens-card');
  const row = card.locator(`[data-lens-parcel="${PARCEL_ID}"]`);
  const memberSelect = row.locator('[data-lens-parcel-member]');
  await expect(memberSelect.locator('option')).toHaveCount(2);
  await selectNativeOption(memberSelect, MEMBER_TWO);
  await expect(memberSelect).toHaveValue(MEMBER_TWO);
  await row.locator('[data-lens-attest]').click();
  await expect(row.locator('[data-lens-result]')).toContainText('Attested.');
  expect(ignoredFirstService).toEqual([]);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({ parcelUid: PARCEL_ID, owner: WALLET, challenge: 'button-test-nonce' });
  expect(submitted[0].signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  expect(await page.evaluate(() => (window as any).__lensSignedMessage)).toBe(message);
  await expect(row.locator('[data-lens-result] a')).toHaveAttribute('href', new RegExp(ATTESTATION));

  await row.locator('[data-lens-payout]').fill('invalid-address');
  await row.locator('[data-lens-say-yes]').click();
  await expect(row.locator('[data-lens-result]')).toContainText('payout must be a Solana address');
  await card.locator('[data-lens-submit-verdict]').click();
  await expect(card.locator('[data-lens-verdict-result]')).toHaveText('Paste the address of a verdict attestation.');
  await card.locator('[data-lens-verdict-address]').fill(ATTESTATION);
  await card.locator('[data-lens-submit-verdict]').click();
  await expect(card.locator('[data-lens-verdict-result]')).toContainText('Proposal account not found');
});

test('owner offer Say yes to execute focuses and scrolls to the lens Say yes control', async ({ mockApi: page }) => {
  await page.route('**/lenses/members', route => route.fulfill({ json: {
    members: [{ key: MEMBER, name: 'Fixture member', serviceUrl: service }],
  } }));
  await page.route(`${service}/lens/attestations**`, route => route.fulfill({ json: { attestations: [] } }));
  await injectMockSolanaWallet(page, { publicKey: WALLET });
  await openCity(page);
  await waitForBlockchainRuntime(page, ['OwnerOffer', 'ProposalLensCard', 'SolanaAcceptanceClient', 'SolanaAcceptanceBridge', 'SolanaChainDataLoader', 'LensCore', 'solanaWeb3']);
  const proposalProgram = await page.evaluate(() => (window as any).SolanaAcceptanceClient.constants.PROPOSAL_NFT_PROGRAM_ID);
  const proposalData = await encodeProposalAccount(page);
  await routeSolanaReads(page, async route => {
    const input = route.request().postDataJSON();
    const account = {
      data: [proposalData, 'base64'], executable: false, lamports: 1_000_000_000,
      owner: proposalProgram, rentEpoch: 0,
    };
    const resultFor = (item: any) => {
      const context = { context: { slot: 1 } };
      if (item.method === 'getGenesisHash') return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
      if (item.method === 'getBalance') return { ...context, value: 1_000_000_000 };
      if (item.method === 'getTokenAccountBalance') return { ...context, value: { amount: '0', decimals: 6 } };
      if (item.method === 'getProgramAccounts' || item.method === 'getSignaturesForAddress') return [];
      if (item.method === 'getAccountInfo') return { ...context, value: item.params?.[0] === PROPOSAL_ACCOUNT ? account : null };
      if (item.method === 'getMultipleAccounts') {
        return { ...context, value: (item.params?.[0] || []).map((address: string) => address === PROPOSAL_ACCOUNT ? account : null) };
      }
      return { ...context, value: null };
    };
    const envelope = (item: any) => ({ jsonrpc: '2.0', id: item.id, result: resultFor(item) });
    return route.fulfill({ json: Array.isArray(input) ? input.map(envelope) : envelope(input) });
  });
  await connectWalletByConnectorId(page, 'solana-phantom');
  const proposalId = await page.evaluate(({ parcelId, proposalAccount, proposalProgram, lensMember }) => (window as any).proposalStorage.addProposal({
    title: 'Owner offer Say yes navigation', goal: 'ownership-transfer-from-me', lifecycleStatus: 'Active',
    proposalRole: 'owner-offer', cadastreParcelIds: [parcelId], isMinted: true,
    nft: { chain: 'solana-devnet', contract: proposalProgram, tokenId: proposalAccount }, lens: [lensMember],
  }), { parcelId: PARCEL_ID, proposalAccount: PROPOSAL_ACCOUNT, proposalProgram, lensMember: MEMBER });
  await page.locator('#proposals-button').click();
  await page.locator(`#proposals-sheet [data-proposal-id="${proposalId}"] .proposal-list-details-btn`).click();
  const panel = page.locator('#proposal-details-panel');
  await expect(panel).toBeVisible();
  const expand = panel.getByRole('button', { name: 'Expand', exact: true });
  if (await expand.isVisible()) await expand.click();
  const funding = panel.locator('details[data-proposal-section="funding"]');
  if (!(await funding.evaluate(element => (element as HTMLDetailsElement).open))) await funding.locator(':scope > summary').click();
  const verification = panel.locator('details[data-proposal-section="verification"]');
  if (!(await verification.evaluate(element => (element as HTMLDetailsElement).open))) await verification.locator(':scope > summary').click();
  const ownerOfferLink = panel.locator('.proposal-bids-say-yes');
  const lensCard = panel.locator(`.proposal-lens-card[data-proposal-lens-card="${PROPOSAL_ACCOUNT}"]`);
  const lensSayYes = lensCard.locator(`[data-lens-parcel="${PARCEL_ID}"] [data-lens-say-yes]`);
  await expect(ownerOfferLink).toBeVisible();
  await expect(lensSayYes).toBeVisible();
  await ownerOfferLink.click();
  await expect(lensSayYes).toBeFocused();
  await expect(lensCard).toBeInViewport();
});
