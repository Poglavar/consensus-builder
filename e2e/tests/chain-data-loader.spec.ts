// The chain loaders' reads of parcel NFTs: the Solana program address per cluster and the parcels a
// wallet holds on EVM and on Solana. Designs are not minted (plan-design-agreement.md, M3).
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
  // The loader resolves the ParcelNFT program, the one program it reads (agreements are read through
  // agreement-bridge.js): a cluster without an address of its own resolves none, never devnet's.
  test('SolanaChainDataLoader does not fall back to devnet program IDs on mainnet', async ({ mockApi: page }) => {
    await page.route('**/contracts/addresses.json', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          solana: {
            ParcelNFT: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
          },
          'solana-devnet': {
            ParcelNFT: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
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
        devnetParcel: await loader.resolveProgramAddress('solana-devnet', 'ParcelNFT'),
        mainnetParcel: await loader.resolveProgramAddress('solana-mainnet-beta', 'ParcelNFT'),
        mainnetAliasParcel: await loader.resolveProgramAddress('mainnet', 'ParcelNFT'),
      };
    });

    expect(addresses.devnetParcel).toBe('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1');
    expect(addresses.mainnetParcel).toBeNull();
    expect(addresses.mainnetAliasParcel).toBeNull();
  });

  test('ChainDataLoader.getParcelsFromChain returns parcel data and fallback parcel ids', async ({ mockApi: page }) => {
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

    const parcels = await page.evaluate(async () => {
      const loader = (window as typeof window & {
        ChainDataLoader?: { getParcelsFromChain?: (walletAddress: string, chainId: string, contractAddress: string) => Promise<unknown> };
      }).ChainDataLoader;

      if (!loader || typeof loader.getParcelsFromChain !== 'function') {
        throw new Error('ChainDataLoader.getParcelsFromChain is not available');
      }

      return loader.getParcelsFromChain(
        '0x1234567890abcdef1234567890abcdef12345678',
        '31337',
        '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'
      );
    });

    expect(parcels).toEqual([
      {
        tokenId: '1',
        parcelId: 'HR-335754-1234',
        metadataURI: 'ipfs://parcel-1234',
      },
      {
        tokenId: '2',
        parcelId: 'HR-335754-1235',
        metadataURI: null,
      },
    ]);
  });

  test('SolanaChainDataLoader.getParcelsFromChain parses owned parcel accounts', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await waitForBlockchainRuntime(page, ['SolanaChainDataLoader', 'solanaWeb3']);

    const parcels = await page.evaluate(async () => {
      const globalWindow = window as typeof window & {
        solanaWeb3?: {
          Connection?: { prototype: { getProgramAccounts?: (programId: unknown) => Promise<unknown> } };
          PublicKey?: new (value: string | Uint8Array) => { toBytes: () => Uint8Array; toString: () => string } & {
            constructor: { findProgramAddressSync?: (seeds: Uint8Array[], programId: unknown) => [unknown] };
          };
        };
        SolanaChainDataLoader?: {
          getParcelsFromChain?: (walletAddress: string, cluster: string, programId: string) => Promise<unknown>;
        };
      };

      if (!globalWindow.solanaWeb3 || !globalWindow.solanaWeb3.Connection || !globalWindow.solanaWeb3.PublicKey || !globalWindow.SolanaChainDataLoader || !globalWindow.SolanaChainDataLoader.getParcelsFromChain) {
        throw new Error('Solana loader dependencies are not available');
      }

      const owner = new globalWindow.solanaWeb3.PublicKey('7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT');
      const otherOwner = new globalWindow.solanaWeb3.PublicKey('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg');
      const encoder = new TextEncoder();

      const encodeString = (value: string) => {
        const bytes = encoder.encode(value);
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, bytes.length, true);
        return Array.from(len).concat(Array.from(bytes));
      };

      const buildParcelData = (parcelId: string, metadataUri: string, ownerKey: { toBytes: () => Uint8Array }) => {
        const payload = new Uint8Array(8 + encodeString(parcelId).length + encodeString(metadataUri).length + 32);
        let offset = 8;
        payload.set(encodeString(parcelId), offset);
        offset += encodeString(parcelId).length;
        payload.set(encodeString(metadataUri), offset);
        offset += encodeString(metadataUri).length;
        payload.set(ownerKey.toBytes(), offset);
        return payload;
      };

      const original = globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts;
      globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts = async () => ([
        {
          pubkey: new globalWindow.solanaWeb3.PublicKey('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1'),
          account: { data: buildParcelData('HR-335754-1234', 'ipfs://parcel-1234', owner) },
        },
        {
          pubkey: new globalWindow.solanaWeb3.PublicKey('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg'),
          account: { data: buildParcelData('HR-335754-9999', 'ipfs://parcel-9999', otherOwner) },
        },
      ]);

      try {
        return await globalWindow.SolanaChainDataLoader.getParcelsFromChain(
          '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
          'devnet',
          '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1'
        );
      } finally {
        if (original) {
          globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts = original;
        }
      }
    });

    expect(parcels).toEqual([
      {
        tokenId: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
        parcelId: 'HR-335754-1234',
        metadataURI: 'ipfs://parcel-1234',
      },
    ]);
  });
});
