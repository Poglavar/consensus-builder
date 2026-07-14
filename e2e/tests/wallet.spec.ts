import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { getWalletStates, injectMockEvmWallet, injectMockSolanaWallet, openWalletModal } from '../helpers/blockchain';
import { selectors } from '../helpers/selectors';

test.describe('Wallet connection @features', () => {
  // This asserts the CDN chain (ethers + solanaWeb3) actually loaded — a real browser concern, and
  // the canary for every wallet test below. It used to also probe connectWallet / walletConnect /
  // disconnectWallet / getWalletAddress / getConnectedAddress: none of those exist anywhere in the
  // app, and their results were computed and then never asserted on. Removed rather than left to
  // imply coverage that was never there — the real wallet API is `walletManager`, exercised below.
  test('the wallet CDN libraries (ethers + solanaWeb3) are loaded', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const walletModule = await page.evaluate(() => {
      const w = window as any;
      return {
        hasEthers: typeof w.ethers !== 'undefined',
        hasSolanaWeb3: typeof w.solanaWeb3 !== 'undefined',
        hasWalletManager: typeof w.walletManager === 'object' && w.walletManager !== null,
      };
    });

    expect(walletModule.hasEthers).toBe(true);
    expect(walletModule.hasSolanaWeb3).toBe(true);
    expect(walletModule.hasWalletManager).toBe(true);
  });

  test('EVM wallet connects through the connector modal and can disconnect', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0xaa36a7',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await openWalletModal(page);

    const connectorButton = page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="metamask"]`);
    await expect(connectorButton).toBeVisible();
    await connectorButton.click();

    await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);

    const statesAfterConnect = await getWalletStates(page);
    expect(statesAfterConnect.evm?.status).toBe('connected');
    expect(statesAfterConnect.evm?.accounts?.[0]).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(statesAfterConnect.evm?.chainId).toBe('0xaa36a7');
    expect(statesAfterConnect.evm?.connectorName).toBe('MetaMask');

    const renderedLabel = await page.evaluate(() => {
      const renderer = (window as typeof window & { renderWalletButtonLabel?: () => string }).renderWalletButtonLabel;
      return typeof renderer === 'function' ? renderer() : null;
    });
    expect(renderedLabel).toBe('0x1234...5678');

    await page.evaluate(async () => {
      const walletManager = (window as typeof window & { walletManager?: { disconnect?: () => Promise<void> } }).walletManager;
      if (!walletManager || typeof walletManager.disconnect !== 'function') {
        throw new Error('walletManager.disconnect is not available');
      }
      await walletManager.disconnect();
    });

    const statesAfterDisconnect = await getWalletStates(page);
    expect(statesAfterDisconnect.evm?.status).toBe('idle');
    expect(statesAfterDisconnect.evm?.accounts || []).toHaveLength(0);
  });

  test('EVM wallet can switch chains after connecting', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x1',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await openWalletModal(page);

    await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="metamask"]`).click();

    const switchedChain = await page.evaluate(async () => {
      const walletManager = (window as typeof window & { walletManager?: { switchChain?: (chainId: string) => Promise<{ chainId?: string | null }> } }).walletManager;
      if (!walletManager || typeof walletManager.switchChain !== 'function') {
        throw new Error('walletManager.switchChain is not available');
      }
      const result = await walletManager.switchChain('0x2105');
      return result.chainId || null;
    });

    expect(switchedChain).toBe('0x2105');

    const statesAfterSwitch = await getWalletStates(page);
    expect(statesAfterSwitch.evm?.chainId).toBe('0x2105');
  });

  test('Solana wallet connects through the connector modal and can disconnect', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await openWalletModal(page);

    const connectorButton = page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="solana-phantom"]`);
    await expect(connectorButton).toBeVisible();
    await connectorButton.click();

    await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);

    const statesAfterConnect = await getWalletStates(page);
    expect(statesAfterConnect.solana?.status).toBe('connected');
    expect(statesAfterConnect.solana?.accounts?.[0]).toBe('7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT');
    expect(statesAfterConnect.solana?.cluster).toBe('devnet');
    expect(statesAfterConnect.solana?.connectorName).toBe('Phantom');

    const renderedLabel = await page.evaluate(() => {
      const renderer = (window as typeof window & { renderWalletButtonLabel?: () => string }).renderWalletButtonLabel;
      return typeof renderer === 'function' ? renderer() : null;
    });
    expect(renderedLabel).toBe('7xKX...9wZT');

    await page.evaluate(async () => {
      const solanaWalletManager = (window as typeof window & { solanaWalletManager?: { disconnect?: () => Promise<void> } }).solanaWalletManager;
      if (!solanaWalletManager || typeof solanaWalletManager.disconnect !== 'function') {
        throw new Error('solanaWalletManager.disconnect is not available');
      }
      await solanaWalletManager.disconnect();
    });

    const statesAfterDisconnect = await getWalletStates(page);
    expect(statesAfterDisconnect.solana?.status).toBe('idle');
    expect(statesAfterDisconnect.solana?.accounts || []).toHaveLength(0);
  });

  test('dual-chain wallet renders separate EVM and Solana connector buttons', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x1',
      walletKind: 'brave',
    });
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'brave',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await openWalletModal(page);

    const dualWallet = page.locator('[data-wallet-dual="brave"]');
    await expect(dualWallet).toBeVisible();
    await expect(dualWallet.getByRole('button', { name: 'Ethereum' })).toBeVisible();
    await expect(dualWallet.getByRole('button', { name: 'Solana' })).toBeVisible();

    await dualWallet.getByRole('button', { name: 'Solana' }).click();

    const states = await getWalletStates(page);
    expect(states.solana?.status).toBe('connected');
    expect(states.evm?.status).not.toBe('connected');
  });
});
