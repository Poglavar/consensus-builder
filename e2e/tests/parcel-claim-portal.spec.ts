import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockEvmWallet, injectMockSolanaWallet, stubSolanaParcelMint, waitForBlockchainRuntime } from '../helpers/blockchain';

const CONTRACT = '0x1234567890abcdef1234567890abcdef12345678';
const CLAIM_PORTAL = 'http://claim-portal.e2e/claim';

test('claim existing parcel NFT opens the configured claim portal with the resolved token', async ({ mockApi: page }) => {
  await page.route('**/contracts/addresses.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ '84532': { ParcelNFT: CONTRACT } }),
  }));
  await page.context().route(`${CLAIM_PORTAL}**`, route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>Claim portal fixture</title>',
  }));
  await injectMockEvmWallet(page, { chainIdHex: '0x14a34', walletKind: 'metamask' });
  // Mock the wallet RPC result for the read-only tokenIdForParcelId call; keep Ethers, the
  // production contract wrapper, claim-context resolver, and portal URL builder active.
  await page.addInitScript((claimPortal) => {
    (window as any).CLAIM_PORTAL_DEV_BASE_URL = claimPortal;
    const provider = (window as any).ethereum;
    const request = provider.request.bind(provider);
    provider.request = async (args: any) => args?.method === 'eth_call'
      ? `0x${'0'.repeat(63)}7`
      : request(args);
  }, CLAIM_PORTAL);

  await openCity(page);
  await connectWalletByConnectorId(page, 'metamask');
  await openParcel(page, 'tools');
  const claim = page.locator('#claimButton');
  await expect(claim).toBeEnabled({ timeout: 15000 });
  const portalPromise = page.context().waitForEvent('page');
  await claim.click();
  const portal = await portalPromise;
  await portal.waitForURL(url => url.origin === new URL(CLAIM_PORTAL).origin);
  expect(new URL(portal.url()).searchParams.get('tokenId')).toBe('7');
  expect(new URL(portal.url()).searchParams.get('contract')?.toLowerCase()).toBe(CONTRACT.toLowerCase());
  expect(new URL(portal.url()).searchParams.get('chain')).toBe('base-sepolia');
  expect(new URL(portal.url()).searchParams.get('parcel')).toBe('Parcel HR-335754-1234');
  await portal.close();
});

// A Solana wallet reads the parcel's ownerless parcel_nft anchor instead of an ERC-721 token: Claim
// opens the claim portal's page of that anchor account on Solana devnet, and refuses an unanchored parcel.
test('with a Solana wallet, Claim opens the portal page of the parcel anchor account', async ({ mockApi: page }) => {
  const ANCHOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  await page.context().route(`${CLAIM_PORTAL}**`, route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>Claim portal fixture</title>',
  }));
  await page.addInitScript((claimPortal) => { (window as any).CLAIM_PORTAL_DEV_BASE_URL = claimPortal; }, CLAIM_PORTAL);
  await injectMockSolanaWallet(page, { publicKey: 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W', providerName: 'phantom' });
  await openCity(page);
  await connectWalletByConnectorId(page, 'solana-phantom');
  await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'SolanaParcelClient', 'solanaWeb3']);
  await stubSolanaParcelMint(page, { alreadyMinted: true, tokenId: ANCHOR });
  await page.evaluate(() => { (window as any).ethers = undefined; });
  await openParcel(page, 'tools');
  const status = page.locator('#parcelMintStatus');
  await expect(status.getByRole('link', { name: /NFT status: Minted/ })).toHaveAttribute('href', `https://explorer.solana.com/address/${ANCHOR}?cluster=devnet`);
  const claim = page.locator('#claimButton');
  await expect(claim).toBeEnabled({ timeout: 15000 });
  const portalPromise = page.context().waitForEvent('page');
  await claim.click();
  const portal = await portalPromise;
  await portal.waitForURL(url => url.origin === new URL(CLAIM_PORTAL).origin);
  const opened = new URL(portal.url());
  expect(opened.pathname).toBe(`/claim/address/${ANCHOR}`);
  expect(opened.searchParams.get('chain')).toBe('solana-devnet');
  await portal.close();
  await expect(status.getByRole('link', { name: /NFT status: Minted/ })).toBeVisible();
});
