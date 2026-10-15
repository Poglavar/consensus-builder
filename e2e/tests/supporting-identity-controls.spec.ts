// Cover wallet, chain, profile identity, and canonical parcel-name controls.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, PARCEL_ID } from '../helpers/runtime';
import { getWalletStates, injectMockEvmWallet, injectMockSolanaWallet } from '../helpers/blockchain';

async function openProfile(page: import('@playwright/test').Page, username: string) {
  await page.locator('#username-display').click();
  const welcome = page.locator('#welcome-modal');
  if (await welcome.isVisible()) {
    await page.locator('#username-input').fill(username);
    await page.locator('#welcome-submit-btn').click();
  }
  await page.locator('#username-display').click();
  const profile = page.locator('.agent-dialog-modal');
  await expect(profile).toBeVisible();
  return profile;
}

test.describe('Supporting identity controls @core', () => {
  test('the disconnected profile network selector can close or select No network', async ({ mockApi: page }) => {
    await openCity(page);
    const profile = await openProfile(page, 'Network chooser actor');
    const network = profile.locator('.wallet-chain-info');
    await expect(network).toHaveAttribute('role', 'button');
    await expect(network).toContainText('Select network');

    await network.click();
    const chainModal = page.locator('.chain-modal-overlay');
    await expect(chainModal).toBeVisible();
    await chainModal.getByRole('button', { name: /No network/ }).click();
    await expect(chainModal).toHaveCount(0);
    await expect(profile).toBeVisible();
    await expect(network).toContainText('Select network');
    expect((await getWalletStates(page)).evm?.status).not.toBe('connected');

    await network.click();
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-modal-close]').click();
    await expect(chainModal).toHaveCount(0);
    await expect(profile).toBeVisible();
  });

  test('a Brave Ethereum connector click connects EVM, switches chain, and exposes city-token and Attestify outcomes', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, { chainIdHex: '0xaa36a7', walletKind: 'brave' });
    await injectMockSolanaWallet(page, { providerName: 'brave' });
    await page.addInitScript(() => {
      const provider = (window as any).ethereum;
      if (!provider?.request) return;
      const request = provider.request.bind(provider);
      provider.request = async (args: any) => {
        if (args?.method === 'eth_getCode') return '0x6000';
        if (args?.method === 'eth_getBalance') return '0x0';
        if (args?.method === 'eth_blockNumber') return '0x1';
        return request(args);
      };
    });
    await page.route('**/contracts/addresses.json', route => route.fulfill({ json: {
      '84532': { CityMemeToken: '0x0000000000000000000000000000000000000001' },
    } }));
    await page.route('**/contracts/contracts.json', route => route.fulfill({ json: {
      '1337': {}, '84532': {}, '11155111': {},
    } }));
    // Keep the popup URL/query assertions real without requiring the separate Attestify dev server.
    await page.context().route('http://localhost:3000/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Attestify test fixture</title>',
    }));
    await openCity(page);
    const profile = await openProfile(page, 'Identity controls actor');

    await profile.locator('.wallet-connect-button').click();
    const walletModal = page.locator('.wallet-modal-overlay').last();
    await expect(walletModal).toBeVisible();
    const dualWallet = walletModal.locator('[data-wallet-dual="brave"]');
    await expect(dualWallet).toBeVisible();
    await dualWallet.getByRole('button', { name: 'Ethereum' }).click();
    await expect.poll(async () => (await getWalletStates(page)).evm?.status).toBe('connected');
    await expect.poll(async () => (await getWalletStates(page)).solana?.status).not.toBe('connected');
    await expect(page.locator('.wallet-modal-overlay')).toHaveCount(0);

    const network = profile.locator('.wallet-chain-info');
    await expect(network).toHaveAttribute('role', 'button');
    await network.click();
    const chainModal = page.locator('.chain-modal-overlay');
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-id="0x14a34"]').click();
    await expect.poll(async () => (await getWalletStates(page)).evm?.chainId).toBe('0x14a34');
    await expect(chainModal).toHaveCount(0);

    await page.evaluate(() => {
      const w = window as any;
      let registered = false;
      let available = 3n;
      const tokenAddress = '0x0000000000000000000000000000000000000001';
      const originalContract = w.ethers.Contract;
      Object.defineProperty(w.ethers, 'Contract', {
        configurable: true,
        value: new Proxy(originalContract, {
          construct(target, args, newTarget) {
            if (String(args[0]).toLowerCase() !== tokenAddress) return Reflect.construct(target, args, newTarget);
            return {
              decimals: async () => 0,
              balanceOf: async () => 0n,
              availableBalance: async () => available,
              citizens: async () => [registered ? 1n : 0n, 0n],
              registerAsCitizen: async () => {
                registered = true;
                return { hash: '0xregister-identity', wait: async () => ({ hash: '0xregister-identity' }) };
              },
              withdraw: async (_amount: bigint) => {
                available = 0n;
                return { hash: '0xclaim-identity', wait: async () => ({ hash: '0xclaim-identity' }) };
              },
            };
          },
        }),
      });
    });

    await profile.getByRole('button', { name: 'City token' }).click();
    const cityToken = page.locator('.city-token-overlay');
    await expect(cityToken).toBeVisible();
    await cityToken.locator('[data-city-token-register]').click();
    await expect(cityToken.locator('[data-city-token-register]')).toHaveText('Registered');
    await expect(cityToken.locator('[data-city-token-claim]')).toBeEnabled();
    await cityToken.locator('[data-city-token-claim]').click();
    await expect(cityToken.locator('[data-city-token-allotment]')).toHaveText(/0\.0+ CTY/);
    await expect(cityToken.locator('[data-city-token-claim]')).toBeDisabled();
    await cityToken.locator('.city-token-close').click();
    await expect(cityToken).toHaveCount(0);
    await expect(profile).toBeVisible();
    await expect.poll(async () => (await getWalletStates(page)).evm?.status).toBe('connected');

    await profile.locator('.wallet-attest-link').click();
    const attestify = page.locator('.attestify-overlay');
    await expect(attestify).toBeVisible();
    await attestify.locator('.attestify-close').click();
    await expect(attestify).toHaveCount(0);

    await profile.locator('.wallet-attest-link').click();
    const popupPromise = page.context().waitForEvent('page');
    await attestify.locator('[data-attest-proceed]').click();
    const popup = await popupPromise;
    await expect(attestify).toHaveCount(0);
    await expect.poll(() => new URL(popup.url()).searchParams.get('eoaAddress')).toBe('0x1234567890abcdef1234567890abcdef12345678');
    await expect.poll(() => new URL(popup.url()).searchParams.get('MY_NAME_IS')).toBe('Identity controls actor');
    await popup.close();

    // Exercise both additional EVM choices through the connected wallet's real chain-switch path.
    await network.click();
    await expect(chainModal.locator('[data-chain-id="0xaa36a7"]')).toContainText('Sepolia');
    await chainModal.locator('[data-chain-id="0xaa36a7"]').click();
    await expect.poll(async () => (await getWalletStates(page)).evm?.chainId).toBe('0xaa36a7');
    await expect(network).toContainText('Sepolia');

    await network.click();
    await expect(chainModal.locator('[data-chain-id="0x539"]')).toContainText('Localhost');
    await chainModal.locator('[data-chain-id="0x539"]').click();
    await expect.poll(async () => (await getWalletStates(page)).evm?.chainId).toBe('0x539');
    await expect(network).toContainText('Localhost');
  });

  test('the Canton profile identity control activates and leaves Canton through real chain selections', async ({ mockApi: page }) => {
    await page.addInitScript(() => {
      (window as any).CANTON_ENABLED = true;
      localStorage.setItem('canton.parties', JSON.stringify([
        { party: 'Owner::identity-controls', role: 'owner', parcelId: '', ts: 1 },
        { party: 'Buyer::identity-controls', role: 'buyer', parcelId: '', ts: 2 },
        { party: 'Lens::identity-controls', role: 'lens', parcelId: '', ts: 3 },
        { party: 'Generated::identity-controls', role: 'identity', parcelId: '', ts: 4 },
      ]));
    });
    await openCity(page);
    const profile = await openProfile(page, 'Canton identity controls actor');
    const network = profile.locator('.wallet-chain-info');

    await network.click();
    const chainModal = page.locator('.chain-modal-overlay');
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-id="canton"]').click();
    const picker = page.locator('.canton-id-overlay');
    await expect(picker).toBeVisible();
    await picker.locator('[data-party-select="Owner::identity-controls"]').click();
    await expect(network).toContainText('Canton · Owner');
    expect(await page.evaluate(() => (window as any).CantonMode.isActive())).toBe(true);
    expect(await page.evaluate(() => (window as any).CantonMode.getParty())).toBe('Owner::identity-controls');

    await network.click();
    await picker.locator('[data-party-select="Buyer::identity-controls"]').click();
    await expect(network).toContainText('Canton · Buyer');
    expect(await page.evaluate(() => (window as any).CantonMode.getParty())).toBe('Buyer::identity-controls');

    await network.click();
    await picker.locator('[data-party-select="Lens::identity-controls"]').click();
    await expect(network).toContainText('Canton · Lens');
    expect(await page.evaluate(() => (window as any).CantonMode.getParty())).toBe('Lens::identity-controls');

    await network.click();
    await picker.locator('[data-party-select="Generated::identity-controls"]').click();
    await expect(network).toContainText('Canton · Generated');
    expect(await page.evaluate(() => (window as any).CantonMode.getParty())).toBe('Generated::identity-controls');

    await network.click();
    await expect(picker).toBeVisible();
    await picker.locator('[data-close]').click();
    await expect(picker).toHaveCount(0);
    await expect(network).toContainText('Canton · Generated');

    await network.click();
    await expect(picker).toBeVisible();
    await picker.locator('[data-switch]').click();
    await expect(picker).toHaveCount(0);
    await expect(chainModal).toBeVisible();
    await chainModal.locator('[data-chain-id="none"]').click();
    await expect(chainModal).toHaveCount(0);
    await expect(network).toContainText('Select network');
    expect(await page.evaluate(() => (window as any).CantonMode.isActive())).toBe(false);
  });

  test('the parcel ENS value button copies its full canonical name', async ({ mockApi: page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCity(page);
    await openParcel(page, 'info', PARCEL_ID);
    const copy = page.locator('#parcel-info-panel .ens-name-value');
    await expect(copy).toBeVisible();
    const fullName = await page.evaluate(id => (window as any).parcelEnsName(id), PARCEL_ID);
    await copy.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullName);
  });
});
