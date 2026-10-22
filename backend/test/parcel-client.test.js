// Unit tests for frontend/js/solana/parcel-client.js, the pure codec of the parcel_nft program that
// solana/parcel-mint.js signs with (it took over mint_parcel from the deleted acceptance client, M3):
// the ownerless parcel anchor PDA ["parcel", parcel_id] and the byte-exact mint_parcel instruction,
// with the discriminator re-derived from sha256 and the data, accounts and seeds checked against the
// generated IDL.
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/parcel-client.js');

// The module resolves web3 relative to frontend/js/solana, where @solana/web3.js is not installed.
client.configure({ web3 });
afterAll(() => { client.configure({ web3: null }); });

const { PublicKey } = web3;
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/parcel_nft.json'), 'utf8'));
const MINT = IDL.instructions.find(ix => ix.name === 'mint_parcel');
const PAYER = new PublicKey(Uint8Array.from({ length: 32 }, () => 4)).toBase58();
const PARCEL_ID = 'HR-335550-1/1';
const URI = 'https://api.example/parcels/HR-335550-1%2F1';

// Reads mint_parcel's data back by the IDL's argument types (two borsh strings).
function decode(data) {
    const bytes = Buffer.from(data);
    expect(Array.from(bytes.subarray(0, 8))).toEqual(MINT.discriminator);
    let offset = 8;
    const out = {};
    for (const arg of MINT.args) {
        expect(arg.type).toBe('string');
        const length = bytes.readUInt32LE(offset);
        out[arg.name] = bytes.subarray(offset + 4, offset + 4 + length).toString('utf8');
        offset += 4 + length;
    }
    expect(offset).toBe(bytes.length);
    return out;
}

describe('parcel_nft codec', () => {
    it('knows mint_parcel by sha256("global:mint_parcel"), as the IDL lists it, at the IDL\'s program', () => {
        const sha8 = Array.from(createHash('sha256').update('global:mint_parcel').digest().subarray(0, 8));
        expect(Array.from(client.IX_DISCRIMINATORS.mint_parcel)).toEqual(sha8);
        expect(Array.from(client.IX_DISCRIMINATORS.mint_parcel)).toEqual(MINT.discriminator);
        expect(client.constants.PARCEL_NFT_PROGRAM_ID).toBe(IDL.address);
        expect(client.constants.SYSTEM_PROGRAM_ID).toBe(web3.SystemProgram.programId.toBase58());
    });

    it('encodes mint_parcel as (parcel_id, metadata_uri)', () => {
        expect(decode(client.encodeMintParcelData(PARCEL_ID, URI))).toEqual({ parcel_id: PARCEL_ID, metadata_uri: URI });
        expect(decode(client.encodeMintParcelData('Šibenik 12/3', ''))).toEqual({ parcel_id: 'Šibenik 12/3', metadata_uri: '' });
    });

    it('anchors a parcel at ["parcel", parcel_id], the seeds the IDL declares', () => {
        const seeds = MINT.accounts.find(account => account.name === 'parcel').pda.seeds;
        expect(Buffer.from(seeds[0].value).toString()).toBe('parcel');
        expect(seeds[1]).toMatchObject({ kind: 'arg', path: 'parcel_id' });
        const [expected, bump] = PublicKey.findProgramAddressSync([Buffer.from('parcel'), Buffer.from(PARCEL_ID)], new PublicKey(IDL.address));
        const [anchor, anchorBump] = client.getParcelPda(PARCEL_ID);
        expect(anchor.toBase58()).toBe(expected.toBase58());
        expect(anchorBump).toBe(bump);
        expect(client.getParcelPda('HR-335550-1/2')[0].toBase58()).not.toBe(expected.toBase58());
    });

    it('refuses a parcel id that cannot be a PDA seed: empty, or more than 32 bytes', () => {
        expect(client.getParcelPda('x'.repeat(32))[0]).toBeInstanceOf(PublicKey);
        expect(() => client.getParcelPda('')).toThrow(/1-32 bytes/);
        expect(() => client.getParcelPda('x'.repeat(33))).toThrow(/1-32 bytes/);
        // Bytes, not characters: 17 two-byte letters are 34 bytes.
        expect(() => client.getParcelPda('č'.repeat(17))).toThrow(/1-32 bytes/);
    });

    it('builds an ownerless mint: the parcel anchor, the payer paying rent, the system program', () => {
        const { parcel, instruction } = client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: URI, payer: PAYER });
        expect(parcel.toBase58()).toBe(client.getParcelPda(PARCEL_ID)[0].toBase58());
        expect(instruction.programId.toBase58()).toBe(IDL.address);
        expect(instruction.keys.map(key => ({ pubkey: key.pubkey.toBase58(), isSigner: key.isSigner, isWritable: key.isWritable })))
            .toEqual(MINT.accounts.map((account, index) => ({
                pubkey: [parcel.toBase58(), PAYER, web3.SystemProgram.programId.toBase58()][index],
                isSigner: !!account.signer,
                isWritable: !!account.writable
            })));
        expect(MINT.accounts.map(account => account.name)).toEqual(['parcel', 'payer', 'system_program']);
        expect(decode(instruction.data)).toEqual({ parcel_id: PARCEL_ID, metadata_uri: URI });
        expect(client.constants.DEFAULT_PUBKEY).toBe(web3.PublicKey.default.toBase58());
    });

    it('takes another program id, and refuses a payer that is not a canonical key', () => {
        const other = new PublicKey(Uint8Array.from({ length: 32 }, () => 9)).toBase58();
        const { parcel, instruction } = client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: URI, payer: PAYER, programId: other });
        expect(instruction.programId.toBase58()).toBe(other);
        expect(parcel.toBase58()).toBe(PublicKey.findProgramAddressSync([Buffer.from('parcel'), Buffer.from(PARCEL_ID)], new PublicKey(other))[0].toBase58());
        expect(() => client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: URI, payer: 'payer' })).toThrow(/payer must be a base58 public key/);
        expect(client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: URI, payer: new PublicKey(PAYER) }).instruction.keys[1].pubkey.toBase58()).toBe(PAYER);
    });
});
