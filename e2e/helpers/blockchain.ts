// Wallet and chain boundaries for the specs: injected EVM and Solana wallets, the connector modal,
// the wallet vendors, Solana RPC reads, the Solana parcel-anchor mint and the EVM ParcelNFT reads.
// Designs are not minted (plan-design-agreement.md, M3), so nothing here stubs a proposal contract.
import { expect, Page, Route } from '@playwright/test';
import { selectors } from './selectors';

/** Mock Solana account reads regardless of the developer's configured RPC provider. */
export async function routeSolanaReads(page: Page, respond: (route: Route) => Promise<unknown>): Promise<void> {
  const methods = new Set(['getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'getBalance',
    'getTokenAccountBalance', 'getSignaturesForAddress', 'getLatestBlockhash']);
  await page.route('**/*', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    let body: any;
    try { body = route.request().postDataJSON(); } catch (_) { return route.fallback(); }
    const requests = Array.isArray(body) ? body : [body];
    if (!requests.length || !requests.every(item => item?.jsonrpc === '2.0' && methods.has(item.method))) return route.fallback();
    await respond(route);
  });
}

type MockEvmWalletOptions = {
  account?: string;
  chainIdHex?: string;
  walletKind?: 'metamask' | 'brave' | 'coinbase';
};

type MockSolanaWalletOptions = {
  publicKey?: string;
  providerName?: 'phantom' | 'solflare' | 'brave';
  trusted?: boolean;
};

type MockSolanaParcelMintOptions = {
  signature?: string;
  parcelProgramId?: string;
  /** The token id an already-minted anchor reports. */
  tokenId?: string;
  alreadyMinted?: boolean;
};

type MockEvmLoaderOptions = {
  chainIdDec?: string;
  parcelContractAddress?: string;
};

/** Wait for the app's versioned local scripts and on-demand wallet vendors to finish loading. */
export async function waitForBlockchainRuntime(page: Page, globals: string[] = []): Promise<void> {
  await page.evaluate(async () => {
    const ensureWalletVendors = (window as typeof window & {
      ensureWalletVendors?: () => Promise<boolean>;
    }).ensureWalletVendors;
    if (ensureWalletVendors) await ensureWalletVendors();
  });

  if (globals.length) {
    await page.waitForFunction((requiredGlobals) => {
      const runtime = window as typeof window & Record<string, unknown>;
      return requiredGlobals.every((name) => runtime[name] !== undefined && runtime[name] !== null);
    }, globals);
  }
}

export async function injectMockEvmWallet(page: Page, options: MockEvmWalletOptions = {}): Promise<void> {
  await page.addInitScript((initOptions: MockEvmWalletOptions) => {
    const account = initOptions.account || '0x1234567890abcdef1234567890abcdef12345678';
    let chainIdHex = initOptions.chainIdHex || '0x1';
    const walletKind = initOptions.walletKind || 'metamask';
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    const emit = (eventName: string, payload: unknown) => {
      const handlers = listeners.get(eventName);
      if (!handlers) return;
      handlers.forEach((handler) => handler(payload));
    };

    const normalizeHex = (value: string) => {
      if (!value) return '0x1';
      if (value.startsWith('0x') || value.startsWith('0X')) {
        return `0x${value.slice(2).toLowerCase()}`;
      }
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return `0x${Math.trunc(parsed).toString(16)}`;
      }
      return value;
    };

    const provider = {
      id: walletKind,
      isMetaMask: walletKind === 'metamask',
      isBraveWallet: walletKind === 'brave',
      isCoinbaseWallet: walletKind === 'coinbase',
      request: async ({ method, params }: { method: string; params?: Array<{ chainId?: string }> }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return [account];
        }
        if (method === 'eth_chainId') {
          return chainIdHex;
        }
        if (method === 'net_version') {
          return String(parseInt(chainIdHex, 16));
        }
        // Connected profiles read these quantities through the real ethers provider. RPC
        // quantities are hex strings; null makes ethers throw before the UI can finish loading.
        if (['eth_getBalance', 'eth_getTransactionCount'].includes(method)) return '0x0';
        if (['eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas'].includes(method)) return '0x1';
        if (method === 'eth_estimateGas') return '0x5208';
        if (method === 'eth_getCode' || method === 'eth_call') return '0x';
        if (method === 'wallet_switchEthereumChain') {
          const requested = params && params[0] && params[0].chainId ? String(params[0].chainId) : chainIdHex;
          chainIdHex = normalizeHex(requested);
          emit('chainChanged', chainIdHex);
          return null;
        }
        return null;
      },
      on: (eventName: string, handler: (...args: unknown[]) => void) => {
        const handlers = listeners.get(eventName) || new Set<(...args: unknown[]) => void>();
        handlers.add(handler);
        listeners.set(eventName, handlers);
      },
      removeListener: (eventName: string, handler: (...args: unknown[]) => void) => {
        const handlers = listeners.get(eventName);
        if (!handlers) return;
        handlers.delete(handler);
      },
      off: (eventName: string, handler: (...args: unknown[]) => void) => {
        const handlers = listeners.get(eventName);
        if (!handlers) return;
        handlers.delete(handler);
      },
    };

    (window as typeof window & { ethereum?: unknown }).ethereum = provider;
  }, options);
}

export async function injectMockSolanaWallet(page: Page, options: MockSolanaWalletOptions = {}): Promise<void> {
  await page.addInitScript((initOptions: MockSolanaWalletOptions) => {
    const publicKeyValue = initOptions.publicKey || 'GrU64PKaQmtksooZhFeeSKW1G6UKY67TP7FqRDsSwJ';
    const providerName = initOptions.providerName || 'phantom';
    const trusted = initOptions.trusted !== false;
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    const publicKey = {
      toString: () => publicKeyValue,
      toBase58: () => publicKeyValue,
    };

    const emit = (eventName: string, payload?: unknown) => {
      const handlers = listeners.get(eventName);
      if (!handlers) return;
      handlers.forEach((handler) => handler(payload));
    };

    const provider = {
      isPhantom: providerName === 'phantom',
      isSolflare: providerName === 'solflare',
      isBraveWallet: providerName === 'brave',
      publicKey,
      connect: async (connectOptions?: { onlyIfTrusted?: boolean }) => {
        if (connectOptions && connectOptions.onlyIfTrusted && !trusted) {
          throw new Error('Not trusted');
        }
        emit('connect', publicKey);
        return { publicKey };
      },
      disconnect: async () => {
        emit('disconnect');
      },
      signTransaction: async <T>(transaction: T) => transaction,
      on: (eventName: string, handler: (...args: unknown[]) => void) => {
        const handlers = listeners.get(eventName) || new Set<(...args: unknown[]) => void>();
        handlers.add(handler);
        listeners.set(eventName, handlers);
      },
      off: (eventName: string, handler: (...args: unknown[]) => void) => {
        const handlers = listeners.get(eventName);
        if (!handlers) return;
        handlers.delete(handler);
      },
    };

    if (providerName === 'solflare') {
      (window as typeof window & { solflare?: unknown }).solflare = provider;
      (window as typeof window & { solana?: unknown }).solana = provider;
      return;
    }

    (window as typeof window & { solana?: unknown }).solana = provider;
  }, options);
}

export async function openWalletModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const walletManager = (window as typeof window & { walletManager?: { openConnectorModal?: () => void } }).walletManager;
    if (!walletManager || typeof walletManager.openConnectorModal !== 'function') {
      throw new Error('walletManager.openConnectorModal is not available');
    }
    walletManager.openConnectorModal();
  });

  await expect(page.locator(selectors.walletModalOverlay)).toBeVisible();
  await expect(page.locator(selectors.walletModalOptions)).toBeVisible();
}

export async function connectWalletByConnectorId(page: Page, connectorId: string): Promise<void> {
  await openWalletModal(page);
  await page.locator(`${selectors.walletConnectorButton}[data-wallet-connector="${connectorId}"]`).click();
  await expect(page.locator(selectors.walletModalOverlay)).toHaveCount(0);
  await walletVendorsLoaded(page);
}

// ethers and solanaWeb3 load on demand (index.html ensureWalletVendors); a wallet connect only starts
// the load, so the connect helper and any stub that patches window.ethers wait for it rather than race it.
async function walletVendorsLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as any).ensureWalletVendors === 'function');
  const loaded = await page.evaluate(() => (window as any).ensureWalletVendors());
  if (!loaded) throw new Error('the wallet vendors (ethers) failed to load');
}

/**
 * The Solana parcel-anchor mint (solana/parcel-mint.js) against a local RPC boundary: the
 * connection answers the blockhash, send and confirmation, the wallet signs, the loader resolves the
 * ParcelNFT program and reports the anchor's mint status (minted already when `alreadyMinted`).
 * Instruction building and the mint flow itself stay on their production paths.
 */
export async function stubSolanaParcelMint(page: Page, options: MockSolanaParcelMintOptions = {}): Promise<void> {
  await page.evaluate((stubOptions: MockSolanaParcelMintOptions) => {
    const globalWindow = window as typeof window & {
      solanaWalletManager?: {
        getProvider?: () => {
          publicKey?: { toString?: () => string; toBase58?: () => string };
          signTransaction?: (tx: unknown) => Promise<unknown>;
        };
      };
      SolanaChainDataLoader?: {
        getConnection?: (cluster: string) => unknown;
        resolveProgramAddress?: (chainKey: string, contractName: string) => Promise<string | null>;
        getParcelMintStatus?: (...args: unknown[]) => Promise<unknown>;
        setParcelMintStatusCache?: (...args: unknown[]) => unknown;
      };
    };

    const signature = stubOptions.signature || '5N2o4X1mockSignature';
    const parcelProgramId = stubOptions.parcelProgramId || '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
    const connection = {
      getLatestBlockhash: async () => ({
        blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ',
        lastValidBlockHeight: 1000,
      }),
      sendRawTransaction: async () => signature,
      confirmTransaction: async () => ({ value: { err: null } }),
    };

    if (!globalWindow.solanaWalletManager || typeof globalWindow.solanaWalletManager.getProvider !== 'function') {
      throw new Error('solanaWalletManager.getProvider is not available');
    }
    if (!globalWindow.SolanaChainDataLoader) {
      throw new Error('SolanaChainDataLoader is not available');
    }

    const provider = globalWindow.solanaWalletManager.getProvider();
    if (!provider) {
      throw new Error('Active Solana provider is not available');
    }

    provider.signTransaction = async <T>(transaction: T) => {
      const tx = transaction as T & { serialize?: () => Uint8Array };
      tx.serialize = () => new Uint8Array([1, 2, 3]);
      return tx;
    };

    globalWindow.SolanaChainDataLoader.getConnection = () => connection;
    globalWindow.SolanaChainDataLoader.resolveProgramAddress = async (_chainKey: string, contractName: string) => (
      contractName === 'ParcelNFT' ? parcelProgramId : null
    );
    globalWindow.SolanaChainDataLoader.getParcelMintStatus = async () => ({
      minted: Boolean(stubOptions.alreadyMinted),
      tokenId: stubOptions.alreadyMinted ? (stubOptions.tokenId || parcelProgramId) : undefined,
    });
    globalWindow.SolanaChainDataLoader.setParcelMintStatusCache = (...args: unknown[]) => args;
  }, options);
}

/** The EVM ParcelNFT reads (ChainDataLoader.getParcelsFromChain): token 1 reads whole, token 2 only by its parcel id. */
export async function stubEvmChainDataReads(page: Page, options: MockEvmLoaderOptions = {}): Promise<void> {
  await walletVendorsLoaded(page);
  await page.evaluate((stubOptions: MockEvmLoaderOptions) => {
    const globalWindow = window as typeof window & {
      ethers?: {
        BrowserProvider?: unknown;
        Contract?: unknown;
        JsonRpcProvider?: unknown;
        getAddress?: (value: string) => string;
      };
    };

    if (!globalWindow.ethers) {
      throw new Error('window.ethers is not available');
    }

    const chainIdDec = stubOptions.chainIdDec || '31337';
    const parcelContractAddress = stubOptions.parcelContractAddress || '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

    class MockProvider {
      async getNetwork() {
        return { chainId: BigInt(chainIdDec) };
      }
    }

    class MockContract {
      address: string;

      constructor(address: string) {
        this.address = address;
      }

      async getTokensByOwner() {
        return this.address.toLowerCase() === parcelContractAddress.toLowerCase() ? [1n, 2n] : [];
      }

      async getParcelByToken(tokenId: bigint) {
        if (tokenId === 2n) {
          throw new Error('missing parcel details');
        }
        return {
          parcelId: 'HR-335754-1234',
          metadataURI: 'ipfs://parcel-1234',
        };
      }

      async parcelIdForTokenId(tokenId: bigint) {
        return tokenId === 2n ? 'HR-335754-1235' : 'HR-335754-1234';
      }
    }

    Object.defineProperty(globalWindow.ethers, 'BrowserProvider', {
      configurable: true,
      writable: true,
      value: MockProvider,
    });
    Object.defineProperty(globalWindow.ethers, 'JsonRpcProvider', {
      configurable: true,
      writable: true,
      value: MockProvider,
    });
    Object.defineProperty(globalWindow.ethers, 'Contract', {
      configurable: true,
      writable: true,
      value: MockContract,
    });
  }, options);
}

export async function getWalletStates(page: Page): Promise<{
  evm: { status?: string; accounts?: string[]; chainId?: string | null; connectorName?: string | null } | null;
  solana: { status?: string; accounts?: string[]; cluster?: string | null; connectorName?: string | null } | null;
}> {
  return page.evaluate(() => {
    const globalWindow = window as typeof window & {
      walletManager?: { getState?: () => unknown };
      solanaWalletManager?: { getState?: () => unknown };
    };

    return {
      evm: globalWindow.walletManager && typeof globalWindow.walletManager.getState === 'function'
        ? globalWindow.walletManager.getState() as { status?: string; accounts?: string[]; chainId?: string | null; connectorName?: string | null }
        : null,
      solana: globalWindow.solanaWalletManager && typeof globalWindow.solanaWalletManager.getState === 'function'
        ? globalWindow.solanaWalletManager.getState() as { status?: string; accounts?: string[]; cluster?: string | null; connectorName?: string | null }
        : null,
    };
  });
}
