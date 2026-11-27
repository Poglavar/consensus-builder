import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { getWalletStates, injectMockEvmWallet, injectMockSolanaWallet, openWalletModal } from '../helpers/blockchain';
import { selectors } from '../helpers/selectors';

test.describe('Wallet connection @features', () => {
  test('a failed Solana SDK request can be retried while Ethereum stays ready', async ({ mockApi: page }) => {
    let solanaRequests = 0;
    let evmRequests = 0;
    await page.route('**/vendor/solana-web3-*/index.iife.min.js', route =>
      ++solanaRequests === 1 ? route.abort() : route.continue());
    await page.route('**/vendor/ethers-*/ethers.umd.min.js', route => {
      evmRequests++;
      return route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    expect([evmRequests, solanaRequests]).toEqual([0, 0]);

    const readiness = await page.evaluate(async () => {
      const w = window as any;
      const both = await w.ensureWalletVendors();
      const evm = await w.ensureWalletVendors('evm');
      const solanaAfterFailure = typeof w.solanaWeb3;
      const retried = await Promise.all([w.ensureWalletVendors('solana'), w.ensureWalletVendors()]);
      return {
        both, evm, solanaAfterFailure, retried,
        ethersProvider: typeof w.ethers?.BrowserProvider, solanaConnection: typeof w.solanaWeb3?.Connection,
      };
    });
    expect(readiness).toEqual({ both: false, evm: true, solanaAfterFailure: 'undefined',
      retried: [true, true], ethersProvider: 'function', solanaConnection: 'function' });
    expect([evmRequests, solanaRequests]).toEqual([1, 2]);
  });

  test('EVM wallet connects through the connector modal and can disconnect', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0xaa36a7',
      walletKind: 'metamask',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
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
    await page.waitForFunction(() => typeof (window as any).ethers?.BrowserProvider === 'function');
    expect(await page.evaluate(() => typeof (window as any).solanaWeb3)).toBe('undefined');

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

    await page.goto('/', { waitUntil: 'domcontentloaded' });
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
    await page.setViewportSize({ width: 390, height: 844 });
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await openWalletModal(page);

    const connectorButton = page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="solana-phantom"]`);
    await expect(connectorButton).toBeVisible();
    await connectorButton.press('Enter');

    await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);

    const statesAfterConnect = await getWalletStates(page);
    expect(statesAfterConnect.solana?.status).toBe('connected');
    expect(statesAfterConnect.solana?.accounts?.[0]).toBe('7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT');
    expect(statesAfterConnect.solana?.cluster).toBe('devnet');
    expect(statesAfterConnect.solana?.connectorName).toBe('Phantom');
    await page.waitForFunction(() => typeof (window as any).solanaWeb3?.Connection === 'function');
    expect(await page.evaluate(() => typeof (window as any).ethers)).toBe('undefined');

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

    await page.goto('/', { waitUntil: 'domcontentloaded' });
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

  test('scoped Solana picker ignores an existing EVM wallet and stale picker work', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x1',
      walletKind: 'metamask',
    });
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForMapReady(page);
    await openWalletModal(page);
    await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="metamask"]`).click();
    await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);

    await page.evaluate(() => { (window as any).walletManager.openConnectorModal({ chain: 'solana' }); });
    const scoped = page.locator(selectors.walletModalOverlay);
    await expect(scoped).toBeVisible();
    await expect(scoped.locator('[data-wallet-connector]')).toHaveCount(1);
    await expect(scoped.locator('[data-wallet-connector="solana-phantom"]')).toBeVisible();
    await page.waitForTimeout(1200); // longer than the modal poll; the EVM state must not close it
    await expect(scoped).toBeVisible();

    // A provider request can outlive the first picker. Its rejection must not replace the
    // message or controls in the next picker, even if a different wallet is already connected.
    await page.evaluate(() => {
      const root = window as any;
      const connect = root.solana.connect.bind(root.solana);
      root.solana.connect = () => new Promise((_resolve, reject) => {
        root.rejectFirstConnection = () => { root.solana.connect = connect; reject(new Error('Cancelled first request')); };
      });
    });
    await scoped.locator('[data-wallet-connector="solana-phantom"]').click();
    await expect(scoped.locator('[data-wallet-connector="solana-phantom"]')).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Escape');
    await expect(scoped).toHaveCount(0);
    await page.evaluate(() => { (window as any).walletManager.openConnectorModal({ chain: 'solana' }); });
    await page.evaluate(() => (window as any).rejectFirstConnection());
    await expect(scoped.locator('[data-wallet-modal-error]')).toBeEmpty();
    await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="solana-phantom"]`).click();
    await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);

    const states = await getWalletStates(page);
    expect(states.evm?.status).toBe('connected');
    expect(states.solana?.status).toBe('connected');
    expect(states.solana?.accounts).toEqual(['7xKXtg2CWcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT']);
  });
});
