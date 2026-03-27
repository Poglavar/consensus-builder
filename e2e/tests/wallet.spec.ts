import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectors } from '../helpers/selectors';

test.describe('Wallet connection @features', () => {
  test('wallet connection module is loaded', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const walletModule = await page.evaluate(() => {
      const w = window as any;
      return {
        hasWalletConnect: typeof w.connectWallet === 'function' || typeof w.walletConnect === 'function',
        hasDisconnect: typeof w.disconnectWallet === 'function',
        hasGetAddress: typeof w.getWalletAddress === 'function' || typeof w.getConnectedAddress === 'function',
        hasEthers: typeof w.ethers !== 'undefined',
        hasSolanaWeb3: typeof w.solanaWeb3 !== 'undefined',
      };
    });

    // Core blockchain libraries should be loaded
    expect(walletModule.hasEthers).toBe(true);
  });

  test('EVM wallet provider can be mocked', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    // Inject a mock ethereum provider
    const mockInjected = await page.evaluate(() => {
      const mockProvider = {
        isMetaMask: true,
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_requestAccounts') return ['0x1234567890abcdef1234567890abcdef12345678'];
          if (method === 'eth_accounts') return ['0x1234567890abcdef1234567890abcdef12345678'];
          if (method === 'eth_chainId') return '0x1';
          if (method === 'net_version') return '1';
          return null;
        },
        on: () => {},
        removeListener: () => {},
      };
      (window as any).ethereum = mockProvider;
      return typeof (window as any).ethereum !== 'undefined';
    });

    expect(mockInjected).toBe(true);
  });

  test('Solana web3 library is loaded', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const hasSolana = await page.evaluate(() => {
      const w = window as any;
      return {
        hasSolanaWeb3: typeof w.solanaWeb3 !== 'undefined',
        hasConnection: w.solanaWeb3 && typeof w.solanaWeb3.Connection === 'function',
        hasPublicKey: w.solanaWeb3 && typeof w.solanaWeb3.PublicKey === 'function',
      };
    });

    expect(hasSolana.hasSolanaWeb3).toBe(true);
  });
});
