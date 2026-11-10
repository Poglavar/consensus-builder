import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel } from '../helpers/runtime';
import { connectWalletByConnectorId, injectMockEvmWallet } from '../helpers/blockchain';

const CONTRACT = '0x1234567890abcdef1234567890abcdef12345678';
const CLAIM_PORTAL = 'http://claim-portal.e2e/claim';

test('claiming an anchored parcel opens the configured claim portal with its anchor key', async ({ mockApi: page }) => {
  await page.route('**/contracts/addresses.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ '84532': { ParcelAnchor: CONTRACT } }),
  }));
  await page.context().route(`${CLAIM_PORTAL}**`, route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>Claim portal fixture</title>',
  }));
  await injectMockEvmWallet(page, { chainIdHex: '0x14a34', walletKind: 'metamask' });
  // Mock the wallet RPC result for the read-only ParcelAnchor.isAnchored call (true); keep Ethers,
  // the production contract wrapper, claim-context resolver, and portal URL builder active.
  await page.addInitScript((claimPortal) => {
    (window as any).CLAIM_PORTAL_DEV_BASE_URL = claimPortal;
    const provider = (window as any).ethereum;
    const request = provider.request.bind(provider);
    provider.request = async (args: any) => args?.method === 'eth_call'
      ? `0x${'0'.repeat(63)}1`
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
  // uint256(keccak256("HR-335754-1234")), computed locally once isAnchored answered true.
  expect(new URL(portal.url()).searchParams.get('tokenId')).toBe('19350770297095790550223906069705959789076232857012598002208937639658530522144');
  expect(new URL(portal.url()).searchParams.get('contract')?.toLowerCase()).toBe(CONTRACT.toLowerCase());
  expect(new URL(portal.url()).searchParams.get('chain')).toBe('base-sepolia');
  expect(new URL(portal.url()).searchParams.get('parcel')).toBe('Parcel HR-335754-1234');
  await portal.close();
});
