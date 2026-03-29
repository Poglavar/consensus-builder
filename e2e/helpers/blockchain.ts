import { expect, Page } from '@playwright/test';
import { selectors } from './selectors';

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

type MockEvmProposalMintOptions = {
  account?: string;
  chainIdDec?: string;
  contractAddress?: string;
  txHash?: string;
  proposalId?: string;
  blockNumber?: number;
};

type MockEvmTxOptions = {
  account?: string;
  chainIdDec?: string;
  contractAddress?: string;
  txHash?: string;
};

type MockSolanaBridgeOptions = {
  publicKey?: string;
  signature?: string;
  cluster?: string;
  proposalProgramId?: string;
  parcelProgramId?: string;
  proposalId?: string;
  alreadyMinted?: boolean;
};

type MockEvmLoaderOptions = {
  account?: string;
  chainIdDec?: string;
  parcelContractAddress?: string;
  proposalContractAddress?: string;
};

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
}

export async function stubEvmProposalMintSuccess(page: Page, options: MockEvmProposalMintOptions = {}): Promise<void> {
  await page.evaluate((stubOptions: MockEvmProposalMintOptions) => {
    const globalWindow = window as typeof window & {
      ethers?: {
        BrowserProvider?: unknown;
        Contract?: unknown;
        getAddress?: (value: string) => string;
      };
    };

    if (!globalWindow.ethers) {
      throw new Error('window.ethers is not available');
    }

    const account = stubOptions.account || '0x1234567890abcdef1234567890abcdef12345678';
    const chainIdDec = stubOptions.chainIdDec || '31337';
    const contractAddress = stubOptions.contractAddress || '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318';
    const txHash = stubOptions.txHash || '0xabc123';
    const proposalId = stubOptions.proposalId || '7';
    const blockNumber = stubOptions.blockNumber || 123;
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    class MockBrowserProvider {
      provider: unknown;

      constructor(provider: unknown) {
        this.provider = provider;
      }

      async getSigner() {
        return {
          getAddress: async () => account,
        };
      }

      async getNetwork() {
        return {
          chainId: BigInt(chainIdDec),
        };
      }

      async getCode() {
        return '0x1234';
      }
    }

    class MockContract {
      address: string;
      mintAndFund: ((...args: unknown[]) => Promise<{ hash: string; wait: () => Promise<{ hash: string; logs: Array<{ address: string; topics: string[] }>; blockNumber: number }> }>) & {
        staticCall: (...args: unknown[]) => Promise<boolean>;
      };

      constructor(address: string) {
        this.address = address;
        const wait = async () => ({
          hash: txHash,
          blockNumber,
          logs: [
            {
              address,
              topics: [transferTopic, '0x0', '0x0', `0x${BigInt(proposalId).toString(16)}`],
            },
          ],
        });

        const mintAndFund = async () => ({
          hash: txHash,
          wait,
        });
        mintAndFund.staticCall = async () => true;
        this.mintAndFund = mintAndFund;
      }
    }

    Object.defineProperty(globalWindow.ethers, 'BrowserProvider', {
      configurable: true,
      writable: true,
      value: MockBrowserProvider,
    });
    Object.defineProperty(globalWindow.ethers, 'Contract', {
      configurable: true,
      writable: true,
      value: MockContract,
    });
    Object.defineProperty(globalWindow, '__mockMintContractAddress', {
      configurable: true,
      writable: true,
      value: contractAddress,
    });
  }, options);
}

export async function stubEvmAcceptWithdrawSuccess(page: Page, options: MockEvmTxOptions = {}): Promise<void> {
  await page.evaluate((stubOptions: MockEvmTxOptions) => {
    const globalWindow = window as typeof window & {
      ethers?: {
        BrowserProvider?: unknown;
        Contract?: unknown;
        getAddress?: (value: string) => string;
      };
    };

    if (!globalWindow.ethers) {
      throw new Error('window.ethers is not available');
    }

    const account = stubOptions.account || '0x1234567890abcdef1234567890abcdef12345678';
    const chainIdDec = stubOptions.chainIdDec || '84532';
    const contractAddress = stubOptions.contractAddress || '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709';
    const txHash = stubOptions.txHash || '0xdef456';

    class MockBrowserProvider {
      async getSigner() {
        return {
          getAddress: async () => account,
        };
      }

      async getNetwork() {
        return {
          chainId: BigInt(chainIdDec),
        };
      }

      async getCode() {
        return '0x1234';
      }
    }

    class MockContract {
      address: string;

      constructor(address: string) {
        this.address = address;
      }

      async acceptProposal() {
        return {
          hash: txHash,
          wait: async () => ({ hash: txHash }),
        };
      }

      async withdrawAcceptance() {
        return {
          hash: txHash,
          wait: async () => ({ hash: txHash }),
        };
      }
    }

    Object.defineProperty(globalWindow.ethers, 'BrowserProvider', {
      configurable: true,
      writable: true,
      value: MockBrowserProvider,
    });
    Object.defineProperty(globalWindow.ethers, 'Contract', {
      configurable: true,
      writable: true,
      value: MockContract,
    });
    Object.defineProperty(globalWindow, '__mockAcceptWithdrawContractAddress', {
      configurable: true,
      writable: true,
      value: contractAddress,
    });
  }, options);
}

export async function stubSolanaBridgeSuccess(page: Page, options: MockSolanaBridgeOptions = {}): Promise<void> {
  await page.evaluate((stubOptions: MockSolanaBridgeOptions) => {
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
        parseProposalAccount?: (data: Uint8Array, address: string) => unknown;
        getParcelMintStatus?: (...args: unknown[]) => Promise<unknown>;
        setParcelMintStatusCache?: (...args: unknown[]) => unknown;
      };
    };

    const signature = stubOptions.signature || '5N2o4X1mockSignature';
    const cluster = stubOptions.cluster || 'devnet';
    const proposalProgramId = stubOptions.proposalProgramId || '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
    const parcelProgramId = stubOptions.parcelProgramId || '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
    const proposalId = stubOptions.proposalId || proposalProgramId;
    const connection = {
      getLatestBlockhash: async () => ({
        blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ',
        lastValidBlockHeight: 1000,
      }),
      sendRawTransaction: async () => signature,
      confirmTransaction: async () => ({ value: { err: null } }),
      getAccountInfo: async () => ({
        data: new Uint8Array(32),
        owner: { toString: () => proposalProgramId },
      }),
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
    globalWindow.SolanaChainDataLoader.resolveProgramAddress = async (_chainKey: string, contractName: string) => {
      if (contractName === 'ProposalNFT') return proposalProgramId;
      if (contractName === 'ParcelNFT') return parcelProgramId;
      return null;
    };
    globalWindow.SolanaChainDataLoader.parseProposalAccount = () => ({
      acceptancePossible: true,
      status: 'Active',
      parentParcelIds: ['HR-335754-1234'],
      acceptedParcels: [],
    });
    globalWindow.SolanaChainDataLoader.getParcelMintStatus = async () => ({
      minted: Boolean(stubOptions.alreadyMinted),
      tokenId: stubOptions.alreadyMinted ? proposalId : undefined,
    });
    globalWindow.SolanaChainDataLoader.setParcelMintStatusCache = (...args: unknown[]) => args;
  }, options);
}

export async function stubEvmChainDataReads(page: Page, options: MockEvmLoaderOptions = {}): Promise<void> {
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

    const account = stubOptions.account || '0x1234567890abcdef1234567890abcdef12345678';
    const chainIdDec = stubOptions.chainIdDec || '31337';
    const parcelContractAddress = stubOptions.parcelContractAddress || '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
    const proposalContractAddress = stubOptions.proposalContractAddress || '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318';

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
        if (this.address.toLowerCase() === parcelContractAddress.toLowerCase()) {
          return [1n, 2n];
        }
        return [11n, 12n];
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

      async getProposalsBatch() {
        return [
          [['HR-335754-1234'], ['HR-335754-1235']],
          [false, true],
          ['ipfs://proposal-1', 'ipfs://proposal-2'],
          [true, false],
          [0n, 1n],
          [0n, 10n],
          [100n, 200n],
          [1n, 2n],
          [1000n, 2000n],
          [5n, 10n],
        ];
      }

      async getLens(tokenId: bigint) {
        return tokenId === 11n ? [account] : ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'];
      }

      async ownerOf(tokenId: bigint) {
        return tokenId === 11n ? account : '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
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