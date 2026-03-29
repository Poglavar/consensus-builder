import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { connectWalletByConnectorId, injectMockEvmWallet } from '../helpers/blockchain';

test.describe('Minted proposals modal @features', () => {
  test('openMintedProposalsModal shows a wallet-required error when no wallet is connected', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(async () => {
      const openModal = (window as typeof window & {
        openMintedProposalsModal?: () => Promise<void>;
      }).openMintedProposalsModal;

      if (typeof openModal !== 'function') {
        throw new Error('openMintedProposalsModal is not available');
      }

      await openModal();
    });

    await expect(page.locator('.minted-proposals-overlay')).toBeVisible();
    await expect(page.locator('.minted-proposals-status')).toContainText('Connect a wallet to view minted proposals.');
  });

  test('openMintedProposalsModal renders minted proposals for the connected wallet', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x14a34',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');

    await page.evaluate(() => {
      const globalWindow = window as typeof window & {
        ChainDataLoader?: {
          resolveContractAddress?: (chainId: string, contractName: string) => Promise<string | null>;
          getProposalTokenIdsForOwner?: (walletAddress: string, chainId: string, contractAddress: string) => Promise<string[]>;
          getProposalsFromChain?: (walletAddress: string, chainId: string, contractAddress: string, opts?: { tokenIds?: string[] }) => Promise<unknown[]>;
        };
      };

      if (!globalWindow.ChainDataLoader) {
        throw new Error('ChainDataLoader is not available');
      }

      globalWindow.ChainDataLoader.resolveContractAddress = async () => '0x6c3AdE19a8947bC4CC75B2AE3F2E25F4cBb23709';
      globalWindow.ChainDataLoader.getProposalTokenIdsForOwner = async () => ['11', '12'];
      globalWindow.ChainDataLoader.getProposalsFromChain = async () => ([
        {
          proposalId: '11',
          parentParcelIds: ['HR-335754-1234'],
          imageURI: '/uploads/metadata/proposal-11.json',
          status: 'Active',
          lens: ['0x1234567890abcdef1234567890abcdef12345678'],
          acceptancePossible: true,
          isConditional: false,
          owner: '0x1234567890abcdef1234567890abcdef12345678',
        },
        {
          proposalId: '12',
          parentParcelIds: ['HR-335754-1235', 'HR-335754-1236'],
          imageURI: '/uploads/metadata/proposal-12.json',
          status: 'Executed',
          lens: ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'],
          acceptancePossible: false,
          isConditional: true,
          owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        },
      ]);

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/uploads/metadata/proposal-11.json')) {
          return new Response(JSON.stringify({
            name: 'Transit Garden',
            description: 'A transit-linked housing proposal.',
            image: '/uploads/images/proposal-11.png',
            createdAt: '2026-03-28T10:00:00.000Z',
            author: 'Planner One',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.includes('/uploads/metadata/proposal-12.json')) {
          return new Response(JSON.stringify({
            name: 'Canal Edge Retrofit',
            description: 'Retrofitting the canal edge with mixed use.',
            image: '/uploads/images/proposal-12.png',
            createdAt: '2026-03-28T09:00:00.000Z',
            author: 'Planner Two',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return originalFetch(input, init);
      };
    });

    await page.evaluate(async () => {
      const openModal = (window as typeof window & {
        openMintedProposalsModal?: () => Promise<void>;
      }).openMintedProposalsModal;

      if (typeof openModal !== 'function') {
        throw new Error('openMintedProposalsModal is not available');
      }

      await openModal();
    });

    await expect(page.locator('.minted-proposals-overlay')).toBeVisible();
    await expect(page.locator('.minted-proposal-card')).toHaveCount(2);
    await expect(page.locator('.minted-proposal-title').first()).toContainText('Transit Garden');
    await expect(page.locator('.minted-proposal-title').nth(1)).toContainText('Canal Edge Retrofit');
    await expect(page.locator('.minted-proposal-status').first()).toContainText('Status: Active');
    await expect(page.locator('.minted-proposal-status').nth(1)).toContainText('Status: Executed');
    await expect(page.locator('.minted-proposal-meta').first()).toContainText('Parcels: 1');
    await expect(page.locator('.minted-proposal-meta').nth(1)).toContainText('Parcels: 2');
    await expect(page.locator('.minted-proposal-actions a').first()).toHaveAttribute('href', /basescan/);
  });
});