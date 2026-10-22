// The parcel anchor reader of GET /parcels/:parcelUid/history: a devnet-only, exact Parcel account check
// (program, discriminator, parcel identity) before an anchor is reported to exist.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { createAnchorReader } from '../routes/parcel-history.js';
import { deriveParcelAnchor, parcelAnchorAccountMatches, PARCEL_PROGRAM_ID } from '../oracle/parcel-history.js';
import { DEVNET_GENESIS_HASH } from '../agreements/onchain.js';

const UID = 'source-parcel-1';
const discriminator = createHash('sha256').update('account:Parcel').digest().subarray(0, 8);
const borshString = value => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
};
const account = (parcelUid = UID) => ({
    owner: new PublicKey(PARCEL_PROGRAM_ID), executable: false,
    data: Buffer.concat([discriminator, borshString(parcelUid), borshString('ipfs://parcel-metadata'), Buffer.alloc(32), Buffer.from([255])])
});
const connectionFor = info => ({
    getGenesisHash: vi.fn(async () => DEVNET_GENESIS_HASH),
    getAccountInfo: vi.fn(async () => info)
});

describe('parcel anchor evidence reader', () => {
    it('uses the Parcel discriminator defined by the current IDL', () => {
        const idl = JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/parcel_nft.json', import.meta.url), 'utf8'));
        expect([...discriminator]).toEqual(idl.accounts.find(item => item.name === 'Parcel').discriminator);
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
        ['invalid UTF-8', () => {
            const info = account(); info.data[12] = 0xff; return info;
        }]
    ])('rejects %s instead of manufacturing an existence observation', async (_name, info) => {
        expect(parcelAnchorAccountMatches(info(), UID)).toBe(false);
        await expect(createAnchorReader({ connection: connectionFor(info()) })(deriveParcelAnchor(UID), UID))
            .rejects.toThrow(/program, type or parcel identity/);
    });
});
