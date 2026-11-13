// Unit tests for frontend/js/solana/ugt-client.js, the codec of the ugt program's parcel anchors and
// design/plan records: discriminators equal the checked-in IDL's, PDAs follow the program's seeds,
// instruction bytes are borsh in the IDL's argument order, the client refuses what the program
// refuses, and the account decoders read the program's layouts.
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/ugt-client.js');
client.configure({ web3 });
afterAll(() => { client.configure({ web3: null }); });

const idl = JSON.parse(readFileSync(new URL('../../blockchain/solana/idl/ugt.json', import.meta.url), 'utf8'));
const PROGRAM = new web3.PublicKey(client.constants.UGT_PROGRAM_ID);
const CID = 'bafkreicubjb3aj3kvia2zucre4rs4dano5jzkf2iq6sclzm5z35e55wuwq';
const PAYER = new web3.PublicKey(Uint8Array.from({ length: 32 }, () => 7)).toBase58();
const sha = text => createHash('sha256').update(text, 'utf8').digest();
const disc = (prefix, name) => Array.from(sha(`${prefix}:${name}`).subarray(0, 8));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = s => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

describe('ugt client constants', () => {
    it('carries the IDL program id and the discriminators Anchor derives', () => {
        expect(idl.address).toBe(client.constants.UGT_PROGRAM_ID);
        for (const name of ['anchor_parcels', 'create_record']) {
            expect(client.IX_DISCRIMINATORS[name]).toEqual(idl.instructions.find(ix => ix.name === name).discriminator);
        }
        expect(client.ACCOUNT_DISCRIMINATORS.Record).toEqual(idl.accounts.find(account => account.name === 'Record').discriminator);
        // ParcelAnchor is not in the IDL's accounts (no instruction takes it typed): Anchor's own rule.
        expect(client.ACCOUNT_DISCRIMINATORS.ParcelAnchor).toEqual(disc('account', 'ParcelAnchor'));
    });

    it('sizes a record as the program does: 8 + kind, minter, created_at, asset, two bumps and a 64-byte CID', () => {
        expect(client.constants.RECORD_ACCOUNT_SPACE).toBe(8 + 1 + 32 + 8 + 32 + 1 + 1 + 4 + 64);
        expect(client.RECORD_OFFSETS).toMatchObject({ kind: 8, minter: 9, createdAt: 41, asset: 49, cid: 83 });
    });
});

describe('ugt PDAs', () => {
    it('derives anchors, records and assets from the program seeds', () => {
        expect(client.getParcelPda('HR-1').toString()).toBe(web3.PublicKey.findProgramAddressSync([Buffer.from('parcel'), Buffer.from('HR-1')], PROGRAM).toString());
        expect(client.getRecordPda('plan', CID)[0].toBase58()).toBe(web3.PublicKey.findProgramAddressSync([Buffer.from('record'), Buffer.from([2]), sha(CID)], PROGRAM)[0].toBase58());
        expect(client.getAssetPda('design', CID)[0].toBase58()).toBe(web3.PublicKey.findProgramAddressSync([Buffer.from('asset'), Buffer.from([1]), sha(CID)], PROGRAM)[0].toBase58());
    });

    it('refuses a parcel id that cannot seed a PDA and a kind other than design or plan', () => {
        expect(() => client.getParcelPda('')).toThrow(/1-32 bytes/);
        expect(() => client.getParcelPda('x'.repeat(33))).toThrow(/1-32 bytes/);
        expect(() => client.getRecordPda('agreement', CID)).toThrow(/design or plan/);
        expect(() => client.getRecordPda('design', 'bafk-rei')).toThrow(/ASCII letters and digits/);
    });
});

describe('ugt instructions', () => {
    it('encodes anchor_parcels with the payer, the system program and one writable anchor per id', () => {
        const ids = ['HR-1', 'HR-2'];
        const uris = ['https://a/1', 'https://a/2'];
        const { parcels, instruction } = client.buildAnchorParcelsIx({ parcelIds: ids, metadataUris: uris, payer: PAYER });
        expect(Buffer.from(instruction.data)).toEqual(Buffer.concat([Buffer.from(client.IX_DISCRIMINATORS.anchor_parcels), u32(2), str('HR-1'), str('HR-2'), u32(2), str('https://a/1'), str('https://a/2')]));
        expect(instruction.keys.map(key => [key.pubkey.toBase58(), key.isSigner, key.isWritable])).toEqual([
            [PAYER, true, true], ['11111111111111111111111111111111', false, false],
            ...parcels.map(parcel => [parcel.toBase58(), false, true])
        ]);
    });

    it('refuses batches the program refuses: none, more than 16, unequal URIs, an empty or long URI', () => {
        expect(() => client.encodeAnchorParcelsData([], [])).toThrow(/1-16/);
        const many = Array.from({ length: 17 }, (_, i) => `p${i}`);
        expect(() => client.encodeAnchorParcelsData(many, many)).toThrow(/1-16/);
        expect(() => client.encodeAnchorParcelsData(['a'], [])).toThrow(/one metadata URI/);
        expect(() => client.encodeAnchorParcelsData(['a'], [''])).toThrow(/1-200 bytes/);
        expect(() => client.encodeAnchorParcelsData(['a'], ['u'.repeat(201)])).toThrow(/1-200 bytes/);
    });

    it('encodes create_record with the record, its asset, the minter, Metaplex Core and the system program', () => {
        const { record, asset, instruction } = client.buildCreateRecordIx({ kind: 'design', cid: CID, name: 'Park', uri: 'data:x', minter: PAYER });
        expect(Buffer.from(instruction.data)).toEqual(Buffer.concat([Buffer.from(client.IX_DISCRIMINATORS.create_record), Buffer.from([1]), str(CID), str('Park'), str('data:x')]));
        expect(instruction.keys.map(key => [key.pubkey.toBase58(), key.isSigner, key.isWritable])).toEqual([
            [record.toBase58(), false, true], [asset.toBase58(), false, true], [PAYER, true, true],
            ['CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', false, false], ['11111111111111111111111111111111', false, false]
        ]);
        expect(idl.instructions.find(ix => ix.name === 'create_record').args.map(arg => arg.name)).toEqual(['kind', 'cid', 'name', 'uri']);
    });

    it('refuses an empty or long name and URI', () => {
        expect(() => client.encodeCreateRecordData('design', CID, '', 'u')).toThrow(/name/);
        expect(() => client.encodeCreateRecordData('design', CID, 'n'.repeat(101), 'u')).toThrow(/name/);
        expect(() => client.encodeCreateRecordData('design', CID, 'n', '')).toThrow(/uri/);
        expect(() => client.encodeCreateRecordData('design', CID, 'n', 'u'.repeat(1001))).toThrow(/uri/);
    });
});

describe('ugt account decoders', () => {
    const key = byte => Buffer.alloc(32, byte);
    const i64 = n => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

    it('reads a parcel anchor and returns null for another account', () => {
        const bytes = Buffer.concat([Buffer.from(client.ACCOUNT_DISCRIMINATORS.ParcelAnchor), key(3), i64(1_763_000_000), Buffer.from([254]), str('HR-1'), str('https://a/1')]);
        expect(client.readParcelAnchor(bytes, 'addr')).toEqual({
            address: 'addr', parcelId: 'HR-1', metadataUri: 'https://a/1', anchoredBy: new web3.PublicKey(key(3)).toBase58(), anchoredAt: 1_763_000_000, bump: 254
        });
        expect(client.readParcelAnchor(Buffer.concat([Buffer.alloc(8), bytes.subarray(8)]))).toBeNull();
    });

    it('reads a record padded to its account size', () => {
        const content = Buffer.concat([Buffer.from(client.ACCOUNT_DISCRIMINATORS.Record), Buffer.from([2]), key(4), i64(1_763_000_001), key(5), Buffer.from([250, 251]), str(CID)]);
        const bytes = Buffer.concat([content, Buffer.alloc(client.constants.RECORD_ACCOUNT_SPACE - content.length)]);
        expect(client.readRecord(bytes, 'rec')).toEqual({
            address: 'rec', kind: 'plan', kindCode: 2, cid: CID, minter: new web3.PublicKey(key(4)).toBase58(),
            createdAt: 1_763_000_001, asset: new web3.PublicKey(key(5)).toBase58(), bump: 250
        });
    });

    it('lists records by size and kind, skipping an account that is not a record at its own PDA', async () => {
        const recordBytes = (kind, cid) => {
            const content = Buffer.concat([Buffer.from(client.ACCOUNT_DISCRIMINATORS.Record), Buffer.from([kind]), key(4), i64(10), key(5), Buffer.from([1, 1]), str(cid)]);
            return Buffer.concat([content, Buffer.alloc(client.constants.RECORD_ACCOUNT_SPACE - content.length)]);
        };
        const calls = [];
        const connection = {
            getProgramAccounts: async (program, options) => {
                calls.push({ program: program.toBase58(), options });
                return [
                    { pubkey: client.getRecordPda('design', CID)[0], account: { data: recordBytes(1, CID) } },
                    { pubkey: new web3.PublicKey(key(9)), account: { data: recordBytes(1, CID) } }
                ];
            }
        };
        const rows = await client.listRecords(connection, { kind: 'design' });
        expect(rows.map(row => row.cid)).toEqual([CID]);
        expect(calls[0].program).toBe(client.constants.UGT_PROGRAM_ID);
        expect(calls[0].options.filters).toEqual([{ dataSize: 151 }, { memcmp: { offset: 8, bytes: client.base58Of(Uint8Array.of(1)) } }]);
        expect(client.base58Of(Uint8Array.of(1))).toBe('2');
    });
});
