import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import {
  connectWalletByConnectorId,
  injectMockEvmWallet,
  injectMockSolanaWallet,
  stubEvmProposalMintSuccess,
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
});