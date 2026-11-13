// The parcel anchor reader of GET /parcels/:parcelUid/history: a devnet-only, exact ParcelAnchor account
// check (the ugt program, discriminator, parcel identity) before an anchor is reported to exist.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { createAnchorReader } from '../routes/parcel-history.js';
import { deriveParcelAnchor, parcelAnchorAccountMatches, PARCEL_PROGRAM_ID } from '../oracle/parcel-history.js';
import { DEVNET_GENESIS_HASH } from '../agreements/onchain.js';
import { readSolana, rustStructFields } from './helpers/agreement-layout.js';

const require = createRequire(import.meta.url);
const UgtClient = require('../../frontend/js/solana/ugt-client.js');

const UID = 'source-parcel-1';
const ANCHORED_BY = new PublicKey(Uint8Array.from({ length: 32 }, () => 7));
const discriminator = createHash('sha256').update('account:ParcelAnchor').digest().subarray(0, 8);
const borshString = value => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
};
const account = (parcelUid = UID) => ({
    owner: new PublicKey(PARCEL_PROGRAM_ID), executable: false,
    // anchored_by, anchored_at (i64), bump, parcel_id, metadata_uri: the struct's order (anchors.rs).
    data: Buffer.concat([discriminator, ANCHORED_BY.toBuffer(), Buffer.from([0x80, 0x5c, 0xe8, 0x68, 0, 0, 0, 0]), Buffer.from([255]),
        borshString(parcelUid), borshString('https://app.example.test/parcels/source-parcel-1')])
});
const connectionFor = info => ({
    getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH),
    getAccountInfo: vi.fn(async () => info)
});

describe('parcel anchor evidence reader', () => {
    it('reads the ugt program\'s ParcelAnchor account, laid out as its Rust struct declares it', () => {
        expect(PARCEL_PROGRAM_ID).toBe('95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9');
        expect([...discriminator]).toEqual([21, 240, 237, 186, 245, 40, 164, 227]);
        expect([...discriminator]).toEqual([...UgtClient.ACCOUNT_DISCRIMINATORS.ParcelAnchor]);
        const source = readSolana('programs/ugt/src/anchors.rs');
        expect(source).toMatch(/#\[account\]\npub struct ParcelAnchor \{/);
        expect(rustStructFields(source, 'pub struct ParcelAnchor {')).toEqual([
            { name: 'anchored_by', type: 'Pubkey' }, { name: 'anchored_at', type: 'i64' }, { name: 'bump', type: 'u8' },
            { name: 'parcel_id', type: 'String' }, { name: 'metadata_uri', type: 'String' }
        ]);
        expect(parcelAnchorAccountMatches(account(), UID)).toBe(true);
    });

    it('validates the network and exact account before reporting existence', async () => {
        const connection = connectionFor(account());
        const read = createAnchorReader({ connection });
        expect(await read(deriveParcelAnchor(UID), UID)).toBe(true);
        expect(connection.getAccountInfo).toHaveBeenCalledWith(new PublicKey(deriveParcelAnchor(UID)), 'confirmed');
        connection.getGenesisHash.mockResolvedValueOnce('another-network');
        await expect(read(deriveParcelAnchor(UID), UID)).rejects.toThrow(/devnet/);
        expect(connection.getAccountInfo).toHaveBeenCalledTimes(1);
    });

    it('reports a missing account only after a successful devnet read', async () => {
        const connection = connectionFor(null);
        expect(await createAnchorReader({ connection })(deriveParcelAnchor(UID), UID)).toBe(false);
        connection.getAccountInfo.mockRejectedValueOnce(new Error('rpc unavailable'));
        await expect(createAnchorReader({ connection })(deriveParcelAnchor(UID), UID)).rejects.toThrow(/rpc unavailable/);
    });

    it.each([
        ['wrong program', () => ({ ...account(), owner: PublicKey.default })],
        ['executable account', () => ({ ...account(), executable: true })],
        ['wrong parcel', () => account('different-parcel')],
        ['wrong discriminator', () => ({ ...account(), data: Buffer.alloc(100) })],
        ['truncated body', () => ({ ...account(), data: account().data.subarray(0, -1) })],
        ['truncated string length', () => ({ ...account(), data: discriminator })],
        ['empty metadata URI', () => ({ ...account(), data: Buffer.concat([account().data.subarray(0, 8 + 32 + 8 + 1 + 4 + UID.length), borshString('')]) })],
        ['invalid UTF-8', () => {
            // The first byte of parcel_id, after anchored_by, anchored_at, bump and its u32 length.
            const info = account(); info.data[8 + 32 + 8 + 1 + 4] = 0xff; return info;
        }]
    ])('rejects %s instead of manufacturing an existence observation', async (_name, info) => {
        expect(parcelAnchorAccountMatches(info(), UID)).toBe(false);
        await expect(createAnchorReader({ connection: connectionFor(info()) })(deriveParcelAnchor(UID), UID))
            .rejects.toThrow(/program, type or parcel identity/);
    });
});
