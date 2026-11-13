// The chain loaders' parcel reads: the Solana program address per cluster, the parcels a wallet
// anchored on EVM and on Solana (ParcelAnchor, ownerless, in the ugt program). Designs are
// not minted (plan-design-agreement.md, M3).
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import {
  connectWalletByConnectorId,
  injectMockEvmWallet,
  injectMockSolanaWallet,
  stubEvmChainDataReads,
  waitForBlockchainRuntime,
} from '../helpers/blockchain';

test.describe('Chain data loaders @features', () => {
  // The loader resolves the ugt program, whose ParcelAnchor accounts it reads (agreements are read
  // through agreement-bridge.js): a cluster without an address of its own resolves none, never devnet's.
  test('SolanaChainDataLoader does not fall back to devnet program IDs on mainnet', async ({ mockApi: page }) => {
    await page.route('**/contracts/addresses.json', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          solana: {
            Ugt: '95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9',
          },
          'solana-devnet': {
            Ugt: '95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9',
          },
          'solana-mainnet-beta': {},
        }),
      });
    });

    await page.goto('/');
    await waitForMapReady(page);

    const addresses = await page.evaluate(async () => {
      const loader = (window as typeof window & {
        SolanaChainDataLoader?: {
          resolveProgramAddress?: (chainKey: string, contractName: string) => Promise<string | null>;
        };
      }).SolanaChainDataLoader;

      if (!loader || typeof loader.resolveProgramAddress !== 'function') {
        throw new Error('SolanaChainDataLoader.resolveProgramAddress is not available');
      }

      return {
        devnetParcel: await loader.resolveProgramAddress('solana-devnet', 'Ugt'),
        mainnetParcel: await loader.resolveProgramAddress('solana-mainnet-beta', 'Ugt'),
        mainnetAliasParcel: await loader.resolveProgramAddress('mainnet', 'Ugt'),
      };
    });

    expect(addresses.devnetParcel).toBe('95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9');
    expect(addresses.mainnetParcel).toBeNull();
    expect(addresses.mainnetAliasParcel).toBeNull();
  });

  test('ChainDataLoader reads the parcels a wallet anchored and pages every anchor', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x7a69',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');
    await waitForBlockchainRuntime(page, ['ChainDataLoader', 'ethers']);
    await stubEvmChainDataReads(page);

    const reads = await page.evaluate(async () => {
      const contract = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
      const w = window as typeof window & {
        __anchorPageCalls?: unknown[];
        ChainDataLoader?: {
          getParcelsFromChain?: (walletAddress: string, chainId: string, contractAddress: string) => Promise<unknown>;
          getTotalMintedParcels?: (chainId: string, contractAddress: string) => Promise<number>;
          getAllMintedParcelIds?: (chainId: string, contractAddress: string) => Promise<string[]>;
        };
      };
      const loader = w.ChainDataLoader;
      if (!loader || typeof loader.getParcelsFromChain !== 'function') {
        throw new Error('ChainDataLoader.getParcelsFromChain is not available');
      }

      const parcels = await loader.getParcelsFromChain('0x1234567890abcdef1234567890abcdef12345678', '31337', contract);
      const total = await loader.getTotalMintedParcels!('31337', contract);
      const allIds = await loader.getAllMintedParcelIds!('31337', contract);
      return { parcels, total, allIds, pageCalls: w.__anchorPageCalls };
    });

    // tokenId is the anchor key, uint256(keccak256(parcelId)).
    expect(reads.parcels).toEqual([
      {
        tokenId: '19350770297095790550223906069705959789076232857012598002208937639658530522144',
        parcelId: 'HR-335754-1234',
        metadataURI: 'ipfs://parcel-1234',
      },
      {
        tokenId: '103363224167337974859022471245194697249406235042456520813990736398944233172257',
        parcelId: 'HR-335754-1235',
        metadataURI: null,
      },
    ]);
    expect(reads.total).toBe(201);
    expect(reads.allIds).toHaveLength(201);
    expect(reads.allIds.slice(0, 3)).toEqual(['HR-335754-1234', 'HR-335754-1235', 'HR-1-0']);
    expect(reads.allIds[200]).toBe('HR-1-198');
    expect(reads.pageCalls).toEqual([['anchoredBy', 0, 200], ['anchors', 0, 200], ['anchors', 200, 200]]);
  });

  test('SolanaChainDataLoader.getParcelsFromChain reads the ugt ParcelAnchor accounts a wallet anchored', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'UgtClient', 'solanaWeb3']);

    const reads = await page.evaluate(async () => {
      const globalWindow = window as typeof window & {
        solanaWeb3?: {
          Connection?: { prototype: { getProgramAccounts?: (programId: unknown, config?: unknown) => Promise<unknown> } };
          PublicKey?: new (value: string | Uint8Array) => { toBytes: () => Uint8Array; toString: () => string };
        };
        UgtClient?: { base58Of: (bytes: Uint8Array) => string };
        SolanaChainDataLoader?: {
          getParcelsFromChain?: (walletAddress: string, cluster: string, programId: string) => Promise<unknown>;
        };
      };

      if (!globalWindow.solanaWeb3 || !globalWindow.solanaWeb3.Connection || !globalWindow.solanaWeb3.PublicKey || !globalWindow.UgtClient || !globalWindow.SolanaChainDataLoader || !globalWindow.SolanaChainDataLoader.getParcelsFromChain) {
        throw new Error('Solana loader dependencies are not available');
      }

      const wallet = new globalWindow.solanaWeb3.PublicKey('7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT');
      const otherWallet = new globalWindow.solanaWeb3.PublicKey('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg');
      const encoder = new TextEncoder();
      const discriminator = [21, 240, 237, 186, 245, 40, 164, 227];

      const encodeString = (value: string) => {
        const bytes = encoder.encode(value);
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, bytes.length, true);
        return Array.from(len).concat(Array.from(bytes));
      };

      // ugt ParcelAnchor: discriminator, anchored_by (32), anchored_at i64, bump u8, parcel_id, metadata_uri.
      const buildAnchorData = (parcelId: string, metadataUri: string, anchoredBy: { toBytes: () => Uint8Array }) => {
        const anchoredAt = new Uint8Array(8);
        new DataView(anchoredAt.buffer).setUint32(0, 1767225600, true);
        return Uint8Array.from([
          ...discriminator,
          ...Array.from(anchoredBy.toBytes()),
          ...Array.from(anchoredAt),
          254,
          ...encodeString(parcelId),
          ...encodeString(metadataUri),
        ]);
      };

      const calls: Array<{ programId: string; config: unknown }> = [];
      const original = globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts;
      // The stub ignores the filters, so the loader's own anchoredBy check must drop the other wallet's anchor.
      globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts = async (programId: unknown, config?: unknown) => {
        calls.push({ programId: String(programId), config });
        return [
          {
            pubkey: new globalWindow.solanaWeb3!.PublicKey!('95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9'),
            account: { data: buildAnchorData('HR-335754-1234', 'ipfs://parcel-1234', wallet) },
          },
          {
            pubkey: new globalWindow.solanaWeb3!.PublicKey!('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg'),
            account: { data: buildAnchorData('HR-335754-9999', 'ipfs://parcel-9999', otherWallet) },
          },
        ];
      };

      try {
        const parcels = await globalWindow.SolanaChainDataLoader.getParcelsFromChain(
          '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
          'devnet',
          '95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9'
        );
        return { parcels, calls, discriminatorBase58: globalWindow.UgtClient.base58Of(Uint8Array.from(discriminator)) };
      } finally {
        if (original) {
          globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts = original;
        }
      }
    });

    expect(reads.calls).toEqual([
      {
        programId: '95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9',
        config: {
          filters: [
            { memcmp: { offset: 0, bytes: reads.discriminatorBase58 } },
            { memcmp: { offset: 8, bytes: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT' } },
          ],
        },
      },
    ]);
    expect(reads.parcels).toEqual([
      {
        tokenId: '95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9',
        parcelId: 'HR-335754-1234',
        metadataURI: 'ipfs://parcel-1234',
      },
    ]);
  });
});
