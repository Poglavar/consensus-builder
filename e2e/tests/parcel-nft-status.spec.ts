// The parcel panel's Tools tab reads the parcel's anchor from the connected wallet's chain and links
// the minted token or anchor on its explorer; "Mint anchor" is off once it exists. There is no Claim:
// parcel anchors are ownerless, so nothing is claimed.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockEvmWallet, injectMockSolanaWallet, stubSolanaParcelMint, waitForBlockchainRuntime } from '../helpers/blockchain';

const CONTRACT = '0x1234567890abcdef1234567890abcdef12345678';

test('with an EVM wallet, the anchor status links the minted parcel token and anchoring is off', async ({ mockApi: page }) => {
  await page.route('**/contracts/addresses.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ '84532': { ParcelNFT: CONTRACT } }),
  }));
  await injectMockEvmWallet(page, { chainIdHex: '0x14a34', walletKind: 'metamask' });
  // Mock the wallet RPC result for the read-only tokenIdForParcelId call; keep Ethers, the
  // production contract wrapper and the chain-context resolver active.
  await page.addInitScript(() => {
    const provider = (window as any).ethereum;
    const request = provider.request.bind(provider);
    provider.request = async (args: any) => args?.method === 'eth_call'
      ? `0x${'0'.repeat(63)}7`
      : request(args);
  });

  await openCity(page);
  await connectWalletByConnectorId(page, 'metamask');
  await openParcel(page, 'tools');
  const status = page.locator('#parcelMintStatus');
  const link = status.getByRole('link', { name: /Anchored on/ });
  await expect(link).toHaveAttribute('href', new RegExp(`^https://sepolia\\.basescan\\.org/nft/${CONTRACT}/7$`, 'i'), { timeout: 15000 });
  await expect(page.locator('#mintAndClaimButton')).toBeDisabled();
  await expect(page.locator('#tools-tab').getByRole('button', { name: /claim/i })).toHaveCount(0);
});

// A Solana wallet reads the parcel's ownerless parcel_nft anchor instead of an ERC-721 token.
test('with a Solana wallet, the anchor status links the parcel anchor account and anchoring is off', async ({ mockApi: page }) => {
  const ANCHOR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  await injectMockSolanaWallet(page, { publicKey: 'Cp886ML2Ja4FF3SMmyUeW16rRGsLrBcRW8kfWS1VfN7W', providerName: 'phantom' });
  await openCity(page);
  await connectWalletByConnectorId(page, 'solana-phantom');
  await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'SolanaParcelClient', 'solanaWeb3']);
  await stubSolanaParcelMint(page, { alreadyMinted: true, tokenId: ANCHOR });
  await page.evaluate(() => { (window as any).ethers = undefined; });
  await openParcel(page, 'tools');
  const status = page.locator('#parcelMintStatus');
  await expect(status.getByRole('link', { name: 'Anchor minted on Solana' })).toHaveAttribute('href', `https://explorer.solana.com/address/${ANCHOR}?cluster=devnet`);
  await expect(page.locator('#mintAndClaimButton')).toBeDisabled();
  await expect(page.locator('#tools-tab').getByRole('button', { name: /claim/i })).toHaveCount(0);
});
