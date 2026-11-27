// Unit tests for frontend/js/solana/parcel-client.js, the pure codec of the parcel_nft program that
// solana/parcel-mint.js signs with (it took over mint_parcel from the deleted acceptance client, M3):
// the ownerless parcel anchor PDA ["parcel", sha256(parcel_id)] and the byte-exact mint_parcel instruction,
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
const APARTMENT_HASH = createHash('sha256').update(JSON.stringify(['apartment/v1', 'xray-building', 'unit-1'])).digest('hex');

const sha256 = text => createHash('sha256').update(text).digest();

// Reads mint_parcel's data back by the IDL's argument types (two borsh strings and a 32-byte hash).
function decode(data) {
    const bytes = Buffer.from(data);
    expect(Array.from(bytes.subarray(0, 8))).toEqual(MINT.discriminator);
    let offset = 8;
    const out = {};
    for (const arg of MINT.args) {
        if (arg.type === 'string') {
            const length = bytes.readUInt32LE(offset);
            out[arg.name] = bytes.subarray(offset + 4, offset + 4 + length).toString('utf8');
            offset += 4 + length;
        } else {
            expect(arg.type).toEqual({ array: ['u8', 32] });
            out[arg.name] = bytes.subarray(offset, offset + 32).toString('hex');
            offset += 32;
        }
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

    it('encodes mint_parcel as (parcel_id, metadata_uri, parcel_hash = sha256(parcel_id))', () => {
        expect(decode(client.encodeMintParcelData(PARCEL_ID, URI))).toEqual({ parcel_id: PARCEL_ID, metadata_uri: URI, parcel_hash: sha256(PARCEL_ID).toString('hex') });
        expect(decode(client.encodeMintParcelData('Šibenik 12/3', ''))).toEqual({ parcel_id: 'Šibenik 12/3', metadata_uri: '', parcel_hash: sha256('Šibenik 12/3').toString('hex') });
    });

    it('anchors a parcel at ["parcel", sha256(parcel_id)], the seeds the IDL declares', () => {
        const seeds = MINT.accounts.find(account => account.name === 'parcel').pda.seeds;
        expect(Buffer.from(seeds[0].value).toString()).toBe('parcel');
        expect(seeds[1]).toMatchObject({ kind: 'arg', path: 'parcel_hash' });
        const [expected, bump] = PublicKey.findProgramAddressSync([Buffer.from('parcel'), sha256(PARCEL_ID)], new PublicKey(IDL.address));
        const [anchor, anchorBump] = client.getParcelPda(PARCEL_ID);
        expect(anchor.toBase58()).toBe(expected.toBase58());
        expect(anchorBump).toBe(bump);
        expect(client.getParcelPda('HR-335550-1/2')[0].toBase58()).not.toBe(expected.toBase58());
    });

    it('anchors ids longer than a raw seed, and refuses one that does not fit the account: empty, or more than 256 bytes', () => {
        const kazakh = 'kz-pkk::20-321-001-234::parcel-0042';
        expect(Buffer.byteLength(kazakh)).toBeGreaterThan(32);
        expect(client.getParcelPda(kazakh)[0].toBase58()).toBe(PublicKey.findProgramAddressSync([Buffer.from('parcel'), sha256(kazakh)], new PublicKey(IDL.address))[0].toBase58());
        expect(client.getParcelPda('x'.repeat(256))[0]).toBeInstanceOf(PublicKey);
        expect(() => client.getParcelPda('')).toThrow(/1-256 bytes/);
        expect(() => client.getParcelPda('x'.repeat(257))).toThrow(/1-256 bytes/);
        // Bytes, not characters: 129 two-byte letters are 258 bytes.
        expect(() => client.getParcelPda('č'.repeat(129))).toThrow(/1-256 bytes/);
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
        expect(decode(instruction.data)).toEqual({ parcel_id: PARCEL_ID, metadata_uri: URI, parcel_hash: sha256(PARCEL_ID).toString('hex') });
        expect(client.constants.DEFAULT_PUBKEY).toBe(web3.PublicKey.default.toBase58());
    });

    it('takes another program id, and refuses a payer that is not a canonical key', () => {
        const other = new PublicKey(Uint8Array.from({ length: 32 }, () => 9)).toBase58();
        const { parcel, instruction } = client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: URI, payer: PAYER, programId: other });
        expect(instruction.programId.toBase58()).toBe(other);
        expect(parcel.toBase58()).toBe(PublicKey.findProgramAddressSync([Buffer.from('parcel'), sha256(PARCEL_ID)], new PublicKey(other))[0].toBase58());
        expect(() => client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: URI, payer: 'payer' })).toThrow(/payer must be a base58 public key/);
        expect(client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: URI, payer: new PublicKey(PAYER) }).instruction.keys[1].pubkey.toBase58()).toBe(PAYER);
    });

    it('derives distinct apartment PDAs and encodes the hash-only mint instruction', () => {
        const second = createHash('sha256').update('second apartment').digest('hex');
        const a = client.getApartmentPda(APARTMENT_HASH); const b = client.getApartmentPda(second);
        expect(a[0].toBase58()).not.toBe(b[0].toBase58());
        const built = client.buildMintApartmentIx({ identityHash: APARTMENT_HASH, payer: PAYER });
        expect(built.apartment.toBase58()).toBe(a[0].toBase58());
        expect(built.instruction.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
            [built.apartment.toBase58(), false, true], [PAYER, true, true], [web3.SystemProgram.programId.toBase58(), false, false]
        ]);
        expect(Buffer.from(built.instruction.data).subarray(0, 8)).toEqual(Buffer.from(client.IX_DISCRIMINATORS.mint_apartment));
        expect(Buffer.from(built.instruction.data).subarray(8).toString('hex')).toBe(APARTMENT_HASH);
    });

    it.each([
        ['wrong owner', { owner: PublicKey.default }],
        ['executable', { executable: true }],
        ['wrong discriminator', { discriminator: Buffer.alloc(8) }],
        ['wrong size', { size: 40 }],
        ['wrong hash', { wrongHash: true }],
        ['wrong bump', { wrongBump: true }],
    ])('rejects apartment evidence with %s', async (_label, change) => {
        const [address, bump] = client.getApartmentPda(APARTMENT_HASH);
        const discriminator = Buffer.from([228, 251, 95, 117, 86, 31, 42, 43]);
        const body = Buffer.concat([discriminator, Buffer.from(APARTMENT_HASH, 'hex'), Buffer.from([bump])]);
        if (change.discriminator) change.discriminator.copy(body, 0);
        if (change.size) body[39] = 0;
        if (change.wrongHash) body[8] ^= 1;
        if (change.wrongBump) body[40] ^= 1;
        const info = { owner: change.owner || new PublicKey(IDL.address), executable: !!change.executable, data: body };
        await expect(client.readApartmentAnchor({ getAccountInfo: async () => info }, APARTMENT_HASH)).rejects.toThrow();
    });

    it('reads a valid apartment anchor and returns null for an absent account', async () => {
        const [address, bump] = client.getApartmentPda(APARTMENT_HASH);
        const info = { owner: new PublicKey(IDL.address), executable: false, data: Buffer.concat([Buffer.from([228, 251, 95, 117, 86, 31, 42, 43]), Buffer.from(APARTMENT_HASH, 'hex'), Buffer.from([bump])]) };
        const connection = { getAccountInfo: async (key, commitment) => { expect(key.toBase58()).toBe(address.toBase58()); expect(commitment).toBe('confirmed'); return info; } };
        await expect(client.readApartmentAnchor(connection, APARTMENT_HASH)).resolves.toEqual({ address: address.toBase58(), identityHash: APARTMENT_HASH, bump });
        await expect(client.readApartmentAnchor({ getAccountInfo: async () => null }, APARTMENT_HASH)).resolves.toBeNull();
    });
});
