import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import {
  connectWalletByConnectorId,
  injectMockEvmWallet,
  injectMockSolanaWallet,
  stubEvmChainDataReads,
} from '../helpers/blockchain';

test.describe('Chain data loaders @features', () => {
  test('ChainDataLoader.getParcelsFromChain returns parcel data and fallback parcel ids', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x7a69',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');
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

  test('ChainDataLoader.getProposalsFromChain returns proposal summaries with owner and lens data', async ({ mockApi: page }) => {
    await injectMockEvmWallet(page, {
      account: '0x1234567890abcdef1234567890abcdef12345678',
      chainIdHex: '0x7a69',
      walletKind: 'metamask',
    });

    await page.goto('/');
    await waitForMapReady(page);
    await connectWalletByConnectorId(page, 'metamask');
    await stubEvmChainDataReads(page);

    const proposals = await page.evaluate(async () => {
      const loader = (window as typeof window & {
        ChainDataLoader?: { getProposalsFromChain?: (walletAddress: string, chainId: string, contractAddress: string) => Promise<unknown> };
      }).ChainDataLoader;

      if (!loader || typeof loader.getProposalsFromChain !== 'function') {
        throw new Error('ChainDataLoader.getProposalsFromChain is not available');
      }

      return loader.getProposalsFromChain(
        '0x1234567890abcdef1234567890abcdef12345678',
        '31337',
        '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318'
      );
    });

    expect(proposals).toEqual([
      {
        proposalId: '11',
        parentParcelIds: ['HR-335754-1234'],
        isConditional: false,
        imageURI: 'ipfs://proposal-1',
        acceptancePossible: true,
        status: 'Active',
        statusCode: 0,
        ethBalance: '0',
        tokenBalance: '100',
        acceptanceCount: '1',
        expiryTimestamp: '1000',
        expiringPercentage: '5',
        owner: '0x1234567890abcdef1234567890abcdef12345678',
        lens: ['0x1234567890abcdef1234567890abcdef12345678'],
      },
      {
        proposalId: '12',
        parentParcelIds: ['HR-335754-1235'],
        isConditional: true,
        imageURI: 'ipfs://proposal-2',
        acceptancePossible: false,
        status: 'Executed',
        statusCode: 1,
        ethBalance: '10',
        tokenBalance: '200',
        acceptanceCount: '2',
        expiryTimestamp: '2000',
        expiringPercentage: '10',
        owner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        lens: ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'],
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

  test('SolanaChainDataLoader.getProposalsFromChain parses owned proposal accounts', async ({ mockApi: page }) => {
    await injectMockSolanaWallet(page, {
      publicKey: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
      providerName: 'phantom',
    });

    await page.goto('/');
    await waitForMapReady(page);

    const proposals = await page.evaluate(async () => {
      const globalWindow = window as typeof window & {
        solanaWeb3?: {
          Connection?: { prototype: { getProgramAccounts?: (programId: unknown) => Promise<unknown> } };
          PublicKey?: new (value: string | Uint8Array) => { toBytes: () => Uint8Array; toString: () => string };
        };
        SolanaChainDataLoader?: {
          getProposalsFromChain?: (walletAddress: string, cluster: string, programId: string) => Promise<unknown>;
        };
      };

      if (!globalWindow.solanaWeb3 || !globalWindow.solanaWeb3.Connection || !globalWindow.solanaWeb3.PublicKey || !globalWindow.SolanaChainDataLoader || !globalWindow.SolanaChainDataLoader.getProposalsFromChain) {
        throw new Error('Solana loader dependencies are not available');
      }

      const owner = new globalWindow.solanaWeb3.PublicKey('7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT');
      const otherOwner = new globalWindow.solanaWeb3.PublicKey('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1');
      const encoder = new TextEncoder();

      const encodeString = (value: string) => {
        const bytes = encoder.encode(value);
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, bytes.length, true);
        return Array.from(len).concat(Array.from(bytes));
      };

      const encodeVecString = (values: string[]) => {
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, values.length, true);
        return Array.from(len).concat(values.flatMap((value) => encodeString(value)));
      };

      const encodeU64 = (value: bigint) => {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, value, true);
        return Array.from(bytes);
      };

      const buildProposalData = (proposalIdNum: bigint, ownerKey: { toBytes: () => Uint8Array }, parcelIds: string[]) => {
        const bytes = [
          ...new Uint8Array(8),
          ...encodeU64(proposalIdNum),
          ...ownerKey.toBytes(),
          ...encodeVecString(parcelIds),
          0,
          ...encodeString('ipfs://proposal-image'),
          1,
          0,
          ...encodeU64(5n),
          ...encodeU64(10n),
          ...encodeU64(2n),
          ...encodeVecString([]),
        ];
        return new Uint8Array(bytes);
      };

      const original = globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts;
      globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts = async () => ([
        {
          pubkey: new globalWindow.solanaWeb3.PublicKey('3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg'),
          account: { data: buildProposalData(1n, owner, ['HR-335754-1234']) },
        },
        {
          pubkey: new globalWindow.solanaWeb3.PublicKey('4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1'),
          account: { data: buildProposalData(2n, otherOwner, ['HR-335754-9999']) },
        },
      ]);

      try {
        return await globalWindow.SolanaChainDataLoader.getProposalsFromChain(
          '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
          'devnet',
          '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg'
        );
      } finally {
        if (original) {
          globalWindow.solanaWeb3.Connection.prototype.getProgramAccounts = original;
        }
      }
    });

    expect(proposals).toEqual([
      {
        proposalId: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
        proposalIdNum: '1',
        parentParcelIds: ['HR-335754-1234'],
        isConditional: false,
        imageURI: 'ipfs://proposal-image',
        acceptancePossible: true,
        status: 'Active',
        statusCode: 0,
        solBalance: '5',
        ethBalance: '5',
        tokenBalance: '10',
        acceptanceCount: '2',
        expiryTimestamp: '0',
        expiringPercentage: '0',
        owner: '7xKXtg2CWYcy6EH8d9xvPht4JyhV46Lxgq6vN6hS9wZT',
        acceptedParcels: [],
        lens: [],
      },
    ]);
  });
});