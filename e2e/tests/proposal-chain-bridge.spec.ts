import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import {
  connectWalletByConnectorId,
  injectMockEvmWallet,
  injectMockSolanaWallet,
  stubEvmAcceptWithdrawSuccess,
  stubEvmProposalMintSuccess,
  stubSolanaBridgeSuccess,
} from '../helpers/blockchain';

test.describe('Proposal chain bridge @features', () => {
  test('EVM ProposalChainBridge mintProposal returns minted transaction details', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x7a69',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');
    await stubEvmProposalMintSuccess(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdDec: '31337',
      contractAddress: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
      txHash: '0xfeedbeef',
      proposalId: '42',
      blockNumber: 321,
    });

    const result = await page.evaluate(async () => {
      const bridge = (window as typeof window & {
        ProposalChainBridge?: { mintProposal?: (options: unknown) => Promise<unknown> };
      }).ProposalChainBridge;

      if (!bridge || typeof bridge.mintProposal !== 'function') {
        throw new Error('ProposalChainBridge.mintProposal is not available');
      }

      return bridge.mintProposal({
        parcelIds: ['HR-335754-1234'],
        isConditional: false,
        imageURI: 'ipfs://proposal-image',
        lens: [{ address: '0x1234567890abcdef1234567890abcdef12345678' }],
      });
    });

    expect(result).toMatchObject({
      transactionHash: '0xfeedbeef',
      proposalId: '42',
      chainId: '31337',
      contractAddress: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
      account: '0x1234567890abcdef1234567890abcdef12345678',
      blockNumber: 321,
    });
  });

  test('EVM ProposalChainBridge contributeToProposal reports wrong-network failures before contract calls', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x1',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');

    const result = await page.evaluate(async () => {
      const bridge = (window as typeof window & {
        ProposalChainBridge?: { contributeToProposal?: (options: unknown) => Promise<unknown> };
      }).ProposalChainBridge;

      if (!bridge || typeof bridge.contributeToProposal !== 'function') {
        throw new Error('ProposalChainBridge.contributeToProposal is not available');
      }

      try {
        await bridge.contributeToProposal({
          proposalId: '1',
          chainId: '84532',
          amount: '0.5',
          currency: 'ETH',
        });
        return { ok: true };
      } catch (error) {
        const err = error as { message?: string; code?: string; expectedChainId?: string; walletChainId?: string };
        return {
          ok: false,
          message: err.message || null,
          code: err.code || null,
          expectedChainId: err.expectedChainId || null,
          walletChainId: err.walletChainId || null,
        };
      }
    });

    expect(result).toEqual({
      ok: false,
      message: 'Wrong network. Switch to chain 84532.',
      code: 'WRONG_NETWORK',
      expectedChainId: '84532',
      walletChainId: '1',
    });
  });

  test('ProposalChainBridge routes minting to the Solana bridge when a Solana wallet is active', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'solana-phantom');

    const result = await page.evaluate(async () => {
      (window as typeof window & {
        SolanaProposalChainBridge?: {
          isSupported?: () => boolean;
          mintProposal?: (options: { parcelIds: string[] }) => Promise<unknown>;
        };
      }).SolanaProposalChainBridge = {
        isSupported: () => true,
        mintProposal: async (options: { parcelIds: string[] }) => ({
          route: 'solana',
          parcelIds: options.parcelIds,
          chainId: 'solana-devnet',
        }),
      };

      const bridge = (window as typeof window & {
        ProposalChainBridge?: { mintProposal?: (options: unknown) => Promise<unknown> };
      }).ProposalChainBridge;

      if (!bridge || typeof bridge.mintProposal !== 'function') {
        throw new Error('ProposalChainBridge.mintProposal is not available');
      }

      return bridge.mintProposal({
        parcelIds: ['HR-335754-1234'],
        lens: ['ignored-by-routing-test'],
      });
    });

    expect(result).toEqual({
      route: 'solana',
      parcelIds: ['HR-335754-1234'],
      chainId: 'solana-devnet',
    });
  });

  test('EVM ProposalChainBridge acceptProposal returns explorer metadata', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x14a34',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');
    await stubEvmAcceptWithdrawSuccess(page, {
      chainIdDec: '84532',
      contractAddress: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
      txHash: '0xaccept123',
    });

    const result = await page.evaluate(async () => {
      const bridge = (window as typeof window & {
        ProposalChainBridge?: { acceptProposal?: (options: unknown) => Promise<unknown> };
      }).ProposalChainBridge;

      if (!bridge || typeof bridge.acceptProposal !== 'function') {
        throw new Error('ProposalChainBridge.acceptProposal is not available');
      }

      return bridge.acceptProposal({
        proposalId: '5',
        parcelId: 'HR-335754-1234',
        chainId: '84532',
        contractAddress: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
      });
    });

    expect(result).toEqual({
      transactionHash: '0xaccept123',
      chainId: '84532',
      contractAddress: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
      explorerUrl: 'https://sepolia.basescan.org/tx/0xaccept123',
    });
  });

  test('EVM ProposalChainBridge withdrawAcceptance returns explorer metadata', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x14a34',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');
    await stubEvmAcceptWithdrawSuccess(page, {
      chainIdDec: '84532',
      contractAddress: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
      txHash: '0xwithdraw123',
    });

    const result = await page.evaluate(async () => {
      const bridge = (window as typeof window & {
        ProposalChainBridge?: { withdrawAcceptance?: (options: unknown) => Promise<unknown> };
      }).ProposalChainBridge;

      if (!bridge || typeof bridge.withdrawAcceptance !== 'function') {
        throw new Error('ProposalChainBridge.withdrawAcceptance is not available');
      }

      return bridge.withdrawAcceptance({
        proposalId: '5',
        parcelId: 'HR-335754-1234',
        chainId: '84532',
        contractAddress: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
      });
    });

    expect(result).toEqual({
      transactionHash: '0xwithdraw123',
      chainId: '84532',
      contractAddress: '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709',
      explorerUrl: 'https://sepolia.basescan.org/tx/0xwithdraw123',
    });
  });

  test('SolanaProposalChainBridge supports mint, contribute, accept, and withdraw with mocked connection methods', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await stubSolanaBridgeSuccess(page, {
      signature: '5N2o4X1mockSignature',
      cluster: 'devnet',
      proposalProgramId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
      parcelProgramId: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
      proposalId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
    });

    const result = await page.evaluate(async () => {
      const bridge = (window as typeof window & {
        SolanaProposalChainBridge?: {
          mintProposal?: (options: unknown) => Promise<unknown>;
          contributeToProposal?: (options: unknown) => Promise<unknown>;
          acceptProposal?: (options: unknown) => Promise<unknown>;
          withdrawAcceptance?: (options: unknown) => Promise<unknown>;
        };
      }).SolanaProposalChainBridge;

      if (!bridge || !bridge.mintProposal || !bridge.contributeToProposal || !bridge.acceptProposal || !bridge.withdrawAcceptance) {
        throw new Error('SolanaProposalChainBridge is not fully available');
      }

      const minted = await bridge.mintProposal({
        parcelIds: ['HR-335754-1234'],
        lens: ['7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT'],
        imageURI: 'ipfs://proposal-image',
      });
      const contributed = await bridge.contributeToProposal({
        proposalId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
        amount: '0.5',
      });
      const accepted = await bridge.acceptProposal({
        proposalId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
        parcelId: 'HR-335754-1234',
      });
      const withdrawn = await bridge.withdrawAcceptance({
        proposalId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
        parcelId: 'HR-335754-1234',
      });

      return { minted, contributed, accepted, withdrawn };
    });

    expect(result.minted).toMatchObject({
      transactionHash: '5N2o4X1mockSignature',
      chainId: 'solana-devnet',
      cluster: 'devnet',
      contractAddress: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
      account: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
    });
    expect(typeof (result.minted as { proposalId?: unknown }).proposalId).toBe('string');
    expect((result.minted as { proposalId?: string }).proposalId).toBeTruthy();
    expect(result.contributed).toEqual({
      transactionHash: '5N2o4X1mockSignature',
      chainId: 'solana-devnet',
      cluster: 'devnet',
      contractAddress: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
      explorerUrl: 'https://explorer.solana.com/tx/5N2o4X1mockSignature?cluster=devnet',
    });
    expect(result.accepted).toEqual({
      transactionHash: '5N2o4X1mockSignature',
      chainId: 'solana-devnet',
      cluster: 'devnet',
      contractAddress: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
      explorerUrl: 'https://explorer.solana.com/tx/5N2o4X1mockSignature?cluster=devnet',
    });
    expect(result.withdrawn).toEqual({
      transactionHash: '5N2o4X1mockSignature',
      chainId: 'solana-devnet',
      cluster: 'devnet',
      contractAddress: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
      explorerUrl: 'https://explorer.solana.com/tx/5N2o4X1mockSignature?cluster=devnet',
    });
  });

  test('SolanaProposalChainBridge encodes SOL amounts exactly and simulates before signing', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await stubSolanaBridgeSuccess(page, {
      signature: '5N2o4X1mockSignature',
      cluster: 'devnet',
      proposalProgramId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
      parcelProgramId: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
    });

    const result = await page.evaluate(async () => {
      const globalWindow = window as typeof window & {
        solanaWalletManager?: {
          getProvider?: () => {
            signTransaction?: (tx: unknown) => Promise<unknown>;
          };
        };
        SolanaChainDataLoader?: {
          getConnection?: (cluster: string) => unknown;
          resolveProgramAddress?: (chainKey: string, contractName: string) => Promise<string | null>;
        };
        SolanaProposalChainBridge?: {
          mintProposal?: (options: unknown) => Promise<unknown>;
          contributeToProposal?: (options: unknown) => Promise<unknown>;
          acceptProposal?: (options: unknown) => Promise<unknown>;
          withdrawAcceptance?: (options: unknown) => Promise<unknown>;
          distributeFunds?: (options: unknown) => Promise<unknown>;
        };
      };

      const bridge = globalWindow.SolanaProposalChainBridge;
      const loader = globalWindow.SolanaChainDataLoader;
      const provider = globalWindow.solanaWalletManager?.getProvider?.();
      if (!bridge || !bridge.mintProposal || !bridge.contributeToProposal || !bridge.acceptProposal || !bridge.withdrawAcceptance || !bridge.distributeFunds || !loader || !provider) {
        throw new Error('Solana bridge test dependencies are not available');
      }

      const proposalProgramId = '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg';
      const parcelProgramId = '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1';
      const walletAddress = '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT';
      const events: string[] = [];
      const simulatedInstructions: Array<{ data: number[]; keys: string[] }> = [];

      const readString = (data: number[], offsetRef: { offset: number }) => {
        const view = new DataView(new Uint8Array(data).buffer);
        const len = view.getUint32(offsetRef.offset, true);
        offsetRef.offset += 4;
        offsetRef.offset += len;
      };
      const readMintLamports = (data: number[]) => {
        const view = new DataView(new Uint8Array(data).buffer);
        const offsetRef = { offset: 8 };
        const parcelCount = view.getUint32(offsetRef.offset, true);
        offsetRef.offset += 4;
        for (let index = 0; index < parcelCount; index += 1) readString(data, offsetRef);
        offsetRef.offset += 1;
        readString(data, offsetRef);
        return view.getBigUint64(offsetRef.offset, true).toString();
      };
      const readContributeLamports = (data: number[]) => {
        const view = new DataView(new Uint8Array(data).buffer);
        return view.getBigUint64(8, true).toString();
      };

      const connection = {
        getLatestBlockhash: async () => ({
          blockhash: 'EkSnNWid2cvwEVnVx9aBqpiCpY1QoUW63D2Hp31e4gwJ',
          lastValidBlockHeight: 1000,
        }),
        getAccountInfo: async () => {
          const data = new Uint8Array(16);
          new DataView(data.buffer).setBigUint64(8, 0n, true);
          return { data };
        },
        simulateTransaction: async (tx: { instructions?: Array<{ data: Uint8Array; keys: Array<{ pubkey: { toString: () => string } }> }> }) => {
          events.push('simulate');
          const instruction = tx.instructions?.[0];
          if (instruction) {
            simulatedInstructions.push({
              data: Array.from(instruction.data),
              keys: instruction.keys.map(key => key.pubkey.toString()),
            });
          }
          return { value: { err: null, logs: [] } };
        },
        sendRawTransaction: async () => {
          events.push('send');
          return '5N2o4X1mockSignature';
        },
        confirmTransaction: async () => {
          events.push('confirm');
          return { value: { err: null } };
        },
      };

      provider.signTransaction = async <T>(transaction: T) => {
        events.push('sign');
        const tx = transaction as T & { serialize?: () => Uint8Array };
        tx.serialize = () => new Uint8Array([1, 2, 3]);
        return tx;
      };
      loader.getConnection = () => connection;
      loader.resolveProgramAddress = async (_chainKey: string, contractName: string) => {
        if (contractName === 'ProposalNFT') return proposalProgramId;
        if (contractName === 'ParcelNFT') return parcelProgramId;
        return null;
      };

      await bridge.mintProposal({
        parcelIds: ['HR-335754-1234'],
        lens: ['7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT'],
        imageURI: 'ipfs://proposal-image',
        solAmount: '0.5',
      });
      await bridge.contributeToProposal({
        proposalId: proposalProgramId,
        amount: '1.25',
      });
      await bridge.acceptProposal({
        proposalId: proposalProgramId,
        parcelId: 'HR-335754-1234',
      });
      await bridge.withdrawAcceptance({
        proposalId: proposalProgramId,
        parcelId: 'HR-335754-1234',
      });
      await bridge.distributeFunds({
        proposalId: proposalProgramId,
        acceptedParcels: ['HR-335754-1234'],
        recipientAccounts: {
          'HR-335754-1234': walletAddress,
        },
      });

      return {
        events,
        mintLamports: readMintLamports(simulatedInstructions[0].data),
        contributeLamports: readContributeLamports(simulatedInstructions[1].data),
        acceptKeys: simulatedInstructions[2].keys,
        withdrawKeys: simulatedInstructions[3].keys,
        distributeKeys: simulatedInstructions[4].keys,
        parcelProgramId,
        walletAddress,
      };
    });

    expect(result.mintLamports).toBe('500000000');
    expect(result.contributeLamports).toBe('1250000000');
    expect(result.events.slice(0, 4)).toEqual(['simulate', 'sign', 'send', 'confirm']);
    expect(result.acceptKeys).toHaveLength(4);
    expect(result.withdrawKeys).toHaveLength(4);
    expect(result.acceptKeys[2]).toBe(result.parcelProgramId);
    expect(result.withdrawKeys[2]).toBe(result.parcelProgramId);
    expect(result.distributeKeys).toHaveLength(4);
    expect(result.distributeKeys[1]).toBe(result.parcelProgramId);
    expect(result.distributeKeys[3]).toBe(result.walletAddress);
  });

  test('mintParcelSolana short-circuits when the parcel is already minted and caches the result', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'solana-phantom');
    await stubSolanaBridgeSuccess(page, {
      alreadyMinted: true,
      parcelProgramId: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
      proposalId: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
    });

    const result = await page.evaluate(async () => {
      const mintParcel = (window as typeof window & {
        mintParcelSolana?: (parcelId: string, metadataUri: string, programId: string, cluster: string) => Promise<unknown>;
      }).mintParcelSolana;
      const loader = (window as typeof window & {
        SolanaChainDataLoader?: { setParcelMintStatusCache?: (...args: unknown[]) => unknown };
      }).SolanaChainDataLoader;

      if (typeof mintParcel !== 'function') {
        throw new Error('mintParcelSolana is not available');
      }
      if (!loader || typeof loader.setParcelMintStatusCache !== 'function') {
        throw new Error('SolanaChainDataLoader.setParcelMintStatusCache is not available');
      }

      const setCalls: unknown[][] = [];
      const originalSet = loader.setParcelMintStatusCache;
      loader.setParcelMintStatusCache = (...args: unknown[]) => {
        setCalls.push(args);
        return args;
      };

      const minted = await mintParcel(
        'HR-335754-1234',
        'ipfs://parcel-image',
        '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
        'devnet'
      );

      loader.setParcelMintStatusCache = originalSet;

      return { minted, setCalls };
    });

    expect(result.minted).toMatchObject({
      txHash: null,
      alreadyMinted: true,
    });
    expect(typeof (result.minted as { tokenId?: unknown }).tokenId).toBe('string');
    expect((result.minted as { tokenId?: string }).tokenId).toBeTruthy();
    expect((result.setCalls as unknown[][])).toHaveLength(1);
    expect((result.setCalls as unknown[][])[0][0]).toBe('HR-335754-1234');
    expect((result.setCalls as unknown[][])[0][1]).toBe('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1');
    expect((result.setCalls as unknown[][])[0][2]).toBe('devnet');
    expect((result.setCalls as unknown[][])[0][3]).toMatchObject({ minted: true });
  });
});
