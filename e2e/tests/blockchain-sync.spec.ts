import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import {
  connectWalletByConnectorId,
  injectMockEvmWallet,
  injectMockSolanaWallet,
} from '../helpers/blockchain';

test.describe('Blockchain sync @features', () => {
  test('BlockchainSync.init reacts to wallet events and syncs configured EVM contracts', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x7a69',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');

    const result = await page.evaluate(async () => {
      const globalWindow = window as typeof window & {
        ethers?: {
          BrowserProvider?: unknown;
          Contract?: unknown;
        };
        walletManager?: {
          on?: (eventName: string, handler: (...args: unknown[]) => void) => (() => void) | void;
          getProvider?: () => unknown;
        };
        BlockchainSync?: {
          init?: () => void;
          shutdown?: () => void;
          getStatus?: () => {
            hasEventListeners?: boolean;
            hasPeriodicSync?: boolean;
          };
        };
        getCityConfig?: () => unknown;
        proposalStorage?: unknown;
        updateStatus?: (message: string) => void;
        refreshProposalsLayer?: () => void;
        updateShowProposalsButton?: () => void;
      };

      if (!globalWindow.ethers || !globalWindow.walletManager || !globalWindow.BlockchainSync) {
        throw new Error('Blockchain sync dependencies are not available');
      }

      globalWindow.BlockchainSync.shutdown?.();

      const metrics = {
        statusMessages: [] as string[],
        refreshCount: 0,
        showButtonCount: 0,
        totalSupplyCalls: 0,
        tokenByIndexCalls: 0,
        getProposalCalls: 0,
        ownerOfCalls: 0,
        addProposalCalls: 0,
        contractOnEvents: [] as string[],
        contractOffEvents: [] as string[],
      };

      const addedProposals: Array<Record<string, unknown>> = [];
      const walletListeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const originalWalletOn = typeof globalWindow.walletManager.on === 'function'
        ? globalWindow.walletManager.on.bind(globalWindow.walletManager)
        : null;

      globalWindow.walletManager.on = (eventName: string, handler: (...args: unknown[]) => void) => {
        const handlers = walletListeners.get(eventName) || new Set<(...args: unknown[]) => void>();
        handlers.add(handler);
        walletListeners.set(eventName, handlers);

        const detach = originalWalletOn ? originalWalletOn(eventName, handler) : undefined;
        return () => {
          handlers.delete(handler);
          if (typeof detach === 'function') {
            detach();
          }
        };
      };

      globalWindow.getCityConfig = () => ({
        blockchain: {
          proposalContracts: [
            {
              chainId: '31337',
              contractAddress: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
            },
          ],
        },
      });

      globalWindow.proposalStorage = {
        getProposal: () => null,
        getAllProposals: () => [],
        addProposal: (proposal: Record<string, unknown>) => {
          metrics.addProposalCalls += 1;
          addedProposals.push(proposal);
          return proposal.proposalId || '31337-0x8a791620dd6260079bf849dc5567adc3f2fdc318-7';
        },
        save: () => undefined,
      };

      globalWindow.updateStatus = (message: string) => {
        metrics.statusMessages.push(message);
      };
      globalWindow.refreshProposalsLayer = () => {
        metrics.refreshCount += 1;
      };
      globalWindow.updateShowProposalsButton = () => {
        metrics.showButtonCount += 1;
      };

      class MockBrowserProvider {
        provider: unknown;

        constructor(provider: unknown) {
          this.provider = provider;
        }

        async getNetwork() {
          return { chainId: 31337n };
        }
      }

      class MockContract {
        address: string;

        constructor(address: string) {
          this.address = address;
        }

        async totalSupply() {
          metrics.totalSupplyCalls += 1;
          return 1n;
        }

        async tokenByIndex(index: number) {
          metrics.tokenByIndexCalls += 1;
          return BigInt(index + 7);
        }

        async getProposal(tokenId: bigint) {
          metrics.getProposalCalls += 1;
          return [
            ['HR-335754-1234'],
            false,
            `ipfs://proposal-${tokenId.toString()}`,
            true,
            1,
            0n,
            100n,
            1n,
            1000n,
            5n,
          ];
        }

        async ownerOf() {
          metrics.ownerOfCalls += 1;
          return '0x1234567890abcdef1234567890abcdef12345678';
        }

        on(eventName: string, _handler: (...args: unknown[]) => void) {
          metrics.contractOnEvents.push(eventName);
          return this;
        }

        off(eventName: string, _handler: (...args: unknown[]) => void) {
          metrics.contractOffEvents.push(eventName);
          return this;
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

      globalWindow.BlockchainSync.init?.();
      await new Promise((resolve) => setTimeout(resolve, 50));

      walletListeners.get('accountsChanged')?.forEach((handler) => handler({
        accounts: ['0x1234567890abcdef1234567890abcdef12345678'],
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      walletListeners.get('chainChanged')?.forEach((handler) => handler({ chainId: '31337' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const syncStatus = globalWindow.BlockchainSync.getStatus?.() || {};
      globalWindow.BlockchainSync.shutdown?.();

      return {
        metrics,
        addedProposals,
        listenerEvents: Array.from(walletListeners.keys()),
        syncStatus,
      };
    });

    expect(result.listenerEvents).toEqual(expect.arrayContaining(['accountsChanged', 'chainChanged']));
    expect(result.metrics.totalSupplyCalls).toBeGreaterThanOrEqual(3);
    // Accounts/chain changes trigger incremental syncs. The supply is checked each time, while
    // the already imported token is deliberately not fetched or inserted again.
    expect(result.metrics.tokenByIndexCalls).toBe(1);
    expect(result.metrics.getProposalCalls).toBe(1);
    expect(result.metrics.ownerOfCalls).toBe(1);
    expect(result.metrics.addProposalCalls).toBe(1);
    expect(result.metrics.contractOnEvents.filter((event) => event === 'Transfer')).toHaveLength(2);
    expect(result.metrics.contractOffEvents).toContain('Transfer');
    expect(result.metrics.refreshCount).toBeGreaterThanOrEqual(3);
    expect(result.metrics.showButtonCount).toBeGreaterThanOrEqual(3);
    expect(result.metrics.statusMessages).toContain('Syncing proposals from blockchain...');
    expect(result.metrics.statusMessages).toContain('Synced 1 proposal from blockchain');
    expect(result.syncStatus).toMatchObject({
      hasEventListeners: true,
      hasPeriodicSync: true,
    });
    expect(result.addedProposals[0]).toMatchObject({
      proposalId: '31337-0x8a791620dd6260079bf849dc5567adc3f2fdc318-7',
      parentParcelIds: ['HR-335754-1234'],
      status: 'Active',
      isMinted: true,
      nft: {
        chain: '31337',
        contract: '0x8a791620dd6260079bf849dc5567adc3f2fdc318',
        tokenId: '7',
      },
    });
  });

  test('SolanaBlockchainSync.sync imports matching proposals into proposalStorage', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'solana-phantom');

    const result = await page.evaluate(async () => {
      const globalWindow = window as typeof window & {
        SolanaBlockchainSync?: {
          sync?: () => Promise<unknown>;
        };
        SolanaChainDataLoader?: {
          getAllProposals?: (cluster: string, programAddress: string) => Promise<Array<{ proposalId: string }>>;
          getConnection?: (cluster: string) => {
            getAccountInfo?: (publicKey: unknown) => Promise<{ data: Uint8Array } | null>;
          };
          parseProposalAccount?: (data: Uint8Array, address: string) => Record<string, unknown> | null;
        };
        solanaWeb3?: {
          PublicKey?: new (value: string) => unknown;
        };
        proposalStorage?: unknown;
        getCityConfig?: () => unknown;
        refreshProposalsLayer?: () => void;
        updateStatus?: (message: string) => void;
      };

      if (!globalWindow.SolanaBlockchainSync || !globalWindow.SolanaChainDataLoader || !globalWindow.solanaWeb3?.PublicKey) {
        throw new Error('Solana sync dependencies are not available');
      }

      const metrics = {
        refreshCount: 0,
        statusMessages: [] as string[],
        importCalls: [] as Array<Record<string, unknown>>,
        addProposalCalls: 0,
        saveCalls: 0,
      };

      const existingProposal = {
        proposalId: 'local-solana-proposal',
        parentParcelIds: ['HR-335754-1234'],
      };

      globalWindow.getCityConfig = () => ({
        blockchain: {
          solanaProposalContracts: [
            {
              cluster: 'devnet',
              programAddress: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
            },
          ],
        },
      });

      globalWindow.proposalStorage = {
        getAllProposals: () => [existingProposal],
        getProposal: () => null,
        importOnChainProposal: (payload: Record<string, unknown>) => {
          metrics.importCalls.push(payload);
          return existingProposal.proposalId;
        },
        addProposal: () => {
          metrics.addProposalCalls += 1;
          return 'unexpected-add';
        },
        save: () => {
          metrics.saveCalls += 1;
        },
      };

      globalWindow.refreshProposalsLayer = () => {
        metrics.refreshCount += 1;
      };
      globalWindow.updateStatus = (message: string) => {
        metrics.statusMessages.push(message);
      };

      globalWindow.SolanaChainDataLoader.getAllProposals = async () => ([
        { proposalId: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT' },
      ]);
      globalWindow.SolanaChainDataLoader.getConnection = () => ({
        getAccountInfo: async () => ({ data: new Uint8Array([1, 2, 3, 4]) }),
      });
      globalWindow.SolanaChainDataLoader.parseProposalAccount = (_data: Uint8Array, address: string) => ({
        proposalId: address,
        parentParcelIds: ['HR-335754-1234'],
        isConditional: false,
        imageURI: 'ipfs://solana-proposal',
        acceptancePossible: true,
        status: 'Active',
        statusCode: 0,
        solBalance: '500000000',
        tokenBalance: '0',
        acceptanceCount: '1',
        expiryTimestamp: '1700000000',
        expiringPercentage: '5',
        acceptedParcels: [],
        owner: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      });

      const syncResult = await globalWindow.SolanaBlockchainSync.sync?.();

      return {
        syncResult,
        metrics,
      };
    });

    expect(result.syncResult).toEqual({
      totalSynced: 1,
      contracts: [
        {
          cluster: 'devnet',
          programAddress: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
          synced: 1,
          total: 1,
        },
      ],
    });
    expect(result.metrics.refreshCount).toBe(1);
    expect(result.metrics.statusMessages).toContain('Synced 1 proposal(s) from Solana');
    expect(result.metrics.addProposalCalls).toBe(0);
    expect(result.metrics.saveCalls).toBe(0);
    expect(result.metrics.importCalls).toHaveLength(1);
    expect(result.metrics.importCalls[0]).toMatchObject({
      proposalId: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      parentParcelIds: ['HR-335754-1234'],
      status: 'Active',
      chainId: 'solana-devnet',
      contractAddress: '3wsvs6lklo4yslalvxkdwud37fccje2yu9fvh1nmfxbg',
    });
    expect(result.metrics.importCalls[0]).toMatchObject({
      onchain: {
        chainId: 'solana-devnet',
        contractAddress: '3wsvs6lklo4yslalvxkdwud37fccje2yu9fvh1nmfxbg',
        proposalId: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
        acceptanceCount: '1',
        solBalance: '500000000',
        ethBalance: '500000000',
      },
    });
  });
});
