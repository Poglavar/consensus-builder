// Unit tests for frontend/js/solana/acceptance-client.js, the pure codec for the lens-model v2
// instructions of proposal_nft and parcel_nft. Instruction data and account bytes are produced by an
// independent borsh encoder driven by the committed IDLs, discriminators are re-derived from sha256,
// account metas are compared with the IDL's own order and flags, and the SAS attestation parser is
// run against the backend's reference account builder (backend/oracle/lens-schemas.js).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as web3 from '@solana/web3.js';
import { encodeBase58 } from '../solana/tx-decoder.js';
import { buildSasAttestationAccount, encodeLensPayload, deriveCredentialPda as backendCredentialPda } from '../oracle/lens-schemas.js';

const require = createRequire(import.meta.url);
globalThis.solanaWeb3 = web3;
const client = require('../../frontend/js/solana/acceptance-client.js');
const { PublicKey } = web3;

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const idl = name => JSON.parse(readFileSync(path.join(REPO, `blockchain/solana/idl/${name}.json`), 'utf8'));
const PROPOSAL_IDL = idl('proposal_nft');
const PARCEL_IDL = idl('parcel_nft');
const ixOf = (doc, name) => doc.instructions.find(ix => ix.name === name);
const typeOf = (doc, name) => doc.types.find(type => type.name === name).type;

const keyOf = byte => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
const OWNER = keyOf(3);
const PAYER = keyOf(4);
const PROPOSAL = keyOf(7);
const MEMBER = keyOf(9);
const PAYOUT = keyOf(11);
const ATTESTATION = keyOf(13);
const CREDENTIAL = keyOf(15);
const PARCEL_ID = 'HR-335550-1/1';

// ---- independent IDL-driven borsh encoder ---------------------------------------------------------

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function encodeType(type, value) {
    if (type === 'bool') return Buffer.from([value ? 1 : 0]);
    if (type === 'u8') return Buffer.from([value]);
    if (type === 'u64') { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; }
    if (type === 'i64') { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
    if (type === 'pubkey') return new PublicKey(value).toBuffer();
    if (type === 'string') { const s = Buffer.from(value, 'utf8'); return Buffer.concat([u32(s.length), s]); }
    if (type.vec) return Buffer.concat([u32(value.length), ...value.map(item => encodeType(type.vec, item))]);
    if (type.option) return value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encodeType(type.option, value)]);
    if (type.array) return Buffer.from(value);
    if (type.defined) return Buffer.from([value]);
    throw new Error(`unhandled IDL type ${JSON.stringify(type)}`);
}
function encodeIxData(doc, name, values) {
    const ix = ixOf(doc, name);
    return Buffer.concat([Buffer.from(ix.discriminator), ...ix.args.map(arg => {
        if (!(arg.name in values)) throw new Error(`test value missing for ${arg.name}`);
        return encodeType(arg.type, values[arg.name]);
    })]);
}
function encodeAccount(doc, name, values, pad = 0) {
    const disc = doc.accounts.find(account => account.name === name).discriminator;
    const body = Buffer.concat([Buffer.from(disc), ...typeOf(doc, name).fields.map(field => {
        if (!(field.name in values)) throw new Error(`test value missing for ${field.name}`);
        return encodeType(field.type, values[field.name]);
    })]);
    return pad > body.length ? Buffer.concat([body, Buffer.alloc(pad - body.length)]) : body;
}
const sha8 = text => [...createHash('sha256').update(text).digest().subarray(0, 8)];
const metasOf = ix => ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }));
const idlFlags = (doc, name) => ixOf(doc, name).accounts.map(a => ({ name: a.name, isSigner: !!a.signer, isWritable: !!a.writable }));

// ---- discriminators -------------------------------------------------------------------------------

describe('discriminators', () => {
    it('instruction discriminators equal sha256("global:<name>") and the IDLs', () => {
        for (const [name, bytes] of Object.entries(client.IX_DISCRIMINATORS)) {
            expect(bytes, name).toEqual(sha8(`global:${name}`));
            const doc = name === 'mint_parcel' ? PARCEL_IDL : PROPOSAL_IDL;
            expect(bytes, name).toEqual(ixOf(doc, name).discriminator);
        }
    });

    it('account discriminators equal sha256("account:<Name>") and the IDL', () => {
        for (const [name, bytes] of Object.entries(client.ACCOUNT_DISCRIMINATORS)) {
            expect(bytes, name).toEqual(sha8(`account:${name}`));
            expect(bytes, name).toEqual(PROPOSAL_IDL.accounts.find(a => a.name === name).discriminator);
        }
    });

    it('program ids match the IDLs', () => {
        expect(client.constants.PROPOSAL_NFT_PROGRAM_ID).toBe(PROPOSAL_IDL.address);
        expect(client.constants.PARCEL_NFT_PROGRAM_ID).toBe(PARCEL_IDL.address);
    });

    it('v1 owner-accept instructions are gone from the IDL (nothing to call)', () => {
        expect(ixOf(PROPOSAL_IDL, 'accept_proposal')).toBeUndefined();
        expect(ixOf(PROPOSAL_IDL, 'withdraw_acceptance')).toBeUndefined();
    });
});

// ---- instruction data -----------------------------------------------------------------------------

describe('instruction data', () => {
    const mintArgs = {
        parcelIds: [PARCEL_ID, 'HR-335550-2/1'], isConditional: true, imageUri: 'ipfs://meta', solLamports: 1500000000n,
        lens: [MEMBER, keyOf(21)]
    };
    const mintIdlValues = verdict => ({
        parcel_ids: mintArgs.parcelIds, is_conditional: true, image_uri: 'ipfs://meta', sol_amount: 1500000000n,
        lens: mintArgs.lens, verdict_may_execute: verdict
    });

    it('mint_and_fund ends with verdict_may_execute, false by default', () => {
        const bytes = Buffer.from(client.encodeMintAndFundData(mintArgs));
        expect(bytes.equals(encodeIxData(PROPOSAL_IDL, 'mint_and_fund', mintIdlValues(false)))).toBe(true);
        expect(bytes[bytes.length - 1]).toBe(0);
    });

    it('mint_and_fund with verdictMayExecute true sets the trailing byte', () => {
        const bytes = Buffer.from(client.encodeMintAndFundData({ ...mintArgs, verdictMayExecute: true }));
        expect(bytes.equals(encodeIxData(PROPOSAL_IDL, 'mint_and_fund', mintIdlValues(true)))).toBe(true);
        expect(bytes[bytes.length - 1]).toBe(1);
    });

    it('mint_and_fund refuses an empty lens or non-key lens entries', () => {
        expect(() => client.encodeMintAndFundData({ ...mintArgs, lens: [] })).toThrow(/lens/);
        expect(() => client.encodeMintAndFundData({ ...mintArgs, lens: ['0xabc'] })).toThrow(/lens\[0\]/);
    });

    it('mint_parcel is (parcel_id, metadata_uri)', () => {
        const bytes = Buffer.from(client.encodeMintParcelData(PARCEL_ID, 'https://api.example/parcels/x'));
        expect(bytes.equals(encodeIxData(PARCEL_IDL, 'mint_parcel', { parcel_id: PARCEL_ID, metadata_uri: 'https://api.example/parcels/x' }))).toBe(true);
    });

    it('accept_with_attestations encodes Option<Pubkey> as 0 or 1 + 32 bytes', () => {
        const none = Buffer.from(client.encodeAcceptWithAttestationsData(PARCEL_ID, null));
        expect(none.equals(encodeIxData(PROPOSAL_IDL, 'accept_with_attestations', { parcel_id: PARCEL_ID, payout: null }))).toBe(true);
        expect(none[none.length - 1]).toBe(0);
        const some = Buffer.from(client.encodeAcceptWithAttestationsData(PARCEL_ID, PAYOUT));
        expect(some.equals(encodeIxData(PROPOSAL_IDL, 'accept_with_attestations', { parcel_id: PARCEL_ID, payout: PAYOUT }))).toBe(true);
        expect(some.length).toBe(none.length + 32);
        expect(some[none.length - 1]).toBe(1);
    });

    it('settle_with_verdict and distribute_funds are the bare discriminator', () => {
        expect([...client.encodeSettleWithVerdictData()]).toEqual(ixOf(PROPOSAL_IDL, 'settle_with_verdict').discriminator);
        expect([...client.encodeDistributeFundsData()]).toEqual(ixOf(PROPOSAL_IDL, 'distribute_funds').discriminator);
    });
});

// ---- account metas and PDAs -----------------------------------------------------------------------

describe('instruction accounts', () => {
    const proposalProgram = new PublicKey(PROPOSAL_IDL.address);
    const parcelProgram = new PublicKey(PARCEL_IDL.address);
    const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();

    it('accept_with_attestations follows the IDL account order, flags and seeds', () => {
        const built = client.buildAcceptWithAttestationsIx({
            proposal: PROPOSAL, parcelId: PARCEL_ID, ownership: ATTESTATION, ownershipCredential: CREDENTIAL, owner: OWNER, payer: PAYER, payout: PAYOUT
        });
        const metas = metasOf(built.instruction);
        const flags = idlFlags(PROPOSAL_IDL, 'accept_with_attestations');
        expect(metas.map(({ isSigner, isWritable }) => ({ isSigner, isWritable }))).toEqual(flags.map(({ isSigner, isWritable }) => ({ isSigner, isWritable })));
        expect(flags.map(f => f.name)).toEqual(['proposal', 'parcel', 'ownership', 'ownership_credential', 'tally', 'record', 'owner', 'payer', 'system_program']);
        expect(metas.map(m => m.pubkey)).toEqual([
            PROPOSAL,
            pda([Buffer.from('parcel'), Buffer.from(PARCEL_ID)], parcelProgram),
            ATTESTATION,
            CREDENTIAL,
            pda([Buffer.from('consent'), new PublicKey(PROPOSAL).toBuffer(), Buffer.from(PARCEL_ID)], proposalProgram),
            pda([Buffer.from('acceptance'), new PublicKey(PROPOSAL).toBuffer(), Buffer.from(PARCEL_ID), new PublicKey(OWNER).toBuffer()], proposalProgram),
            OWNER,
            PAYER,
            web3.SystemProgram.programId.toBase58()
        ]);
        expect(built.instruction.programId.toBase58()).toBe(PROPOSAL_IDL.address);
        expect(Buffer.from(built.instruction.data).equals(encodeIxData(PROPOSAL_IDL, 'accept_with_attestations', { parcel_id: PARCEL_ID, payout: PAYOUT }))).toBe(true);
        // the IDL's own seed constants are the strings used above
        const seeds = name => ixOf(PROPOSAL_IDL, 'accept_with_attestations').accounts.find(a => a.name === name).pda.seeds[0].value;
        expect(Buffer.from(seeds('tally')).toString()).toBe('consent');
        expect(Buffer.from(seeds('record')).toString()).toBe('acceptance');
    });

    it('the owner pays when no payer is given', () => {
        const built = client.buildAcceptWithAttestationsIx({ proposal: PROPOSAL, parcelId: PARCEL_ID, ownership: ATTESTATION, ownershipCredential: CREDENTIAL, owner: OWNER });
        expect(metasOf(built.instruction)[7]).toEqual({ pubkey: OWNER, isSigner: true, isWritable: true });
        expect(built.instruction.data[built.instruction.data.length - 1]).toBe(0);
    });

    it('a parcel id longer than a PDA seed is refused before any signing', () => {
        expect(() => client.getConsentTallyPda(PROPOSAL, 'x'.repeat(33))).toThrow(/PDA seed/);
    });

    it('settle_with_verdict follows the IDL account order, flags and verdict record seeds', () => {
        const ix = client.buildSettleWithVerdictIx({ proposal: PROPOSAL, verdict: ATTESTATION, verdictCredential: CREDENTIAL, submitter: PAYER });
        const flags = idlFlags(PROPOSAL_IDL, 'settle_with_verdict');
        expect(flags.map(f => f.name)).toEqual(['proposal', 'verdict', 'verdict_credential', 'verdict_record', 'submitter', 'system_program']);
        const record = pda([Buffer.from('verdict'), new PublicKey(PROPOSAL).toBuffer(), new PublicKey(ATTESTATION).toBuffer()], proposalProgram);
        expect(metasOf(ix)).toEqual([PROPOSAL, ATTESTATION, CREDENTIAL, record, PAYER, web3.SystemProgram.programId.toBase58()]
            .map((pubkey, i) => ({ pubkey, isSigner: flags[i].isSigner, isWritable: flags[i].isWritable })));
        expect(metasOf(ix)[4]).toEqual({ pubkey: PAYER, isSigner: true, isWritable: true });
        expect(client.getVerdictRecordPda(PROPOSAL, ATTESTATION)[0].toBase58()).toBe(record);
        // the IDL's own seeds are ["verdict", proposal, verdict] in that order
        const seeds = ixOf(PROPOSAL_IDL, 'settle_with_verdict').accounts.find(a => a.name === 'verdict_record').pda.seeds;
        expect(Buffer.from(seeds[0].value).toString()).toBe('verdict');
        expect(seeds.slice(1).map(seed => seed.path)).toEqual(['proposal', 'verdict']);
        expect([...ix.data]).toEqual(ixOf(PROPOSAL_IDL, 'settle_with_verdict').discriminator);
    });

    it('mint_parcel v2 is ownerless: parcel, payer, system_program', () => {
        const { instruction, parcel } = client.buildMintParcelIx({ parcelId: PARCEL_ID, metadataUri: 'u', payer: PAYER });
        const flags = idlFlags(PARCEL_IDL, 'mint_parcel');
        expect(flags.map(f => f.name)).toEqual(['parcel', 'payer', 'system_program']);
        expect(metasOf(instruction)).toEqual([parcel.toBase58(), PAYER, web3.SystemProgram.programId.toBase58()]
            .map((pubkey, i) => ({ pubkey, isSigner: flags[i].isSigner, isWritable: flags[i].isWritable })));
        expect(parcel.toBase58()).toBe(pda([Buffer.from('parcel'), Buffer.from(PARCEL_ID)], parcelProgram));
    });

    it('mint_and_fund derives the proposal PDA from the counter value', () => {
        const { instruction, proposal } = client.buildMintAndFundIx({ owner: OWNER, proposalCount: 38n, parcelIds: [PARCEL_ID], lens: [MEMBER] });
        const count = Buffer.alloc(8); count.writeBigUInt64LE(38n);
        expect(proposal.toBase58()).toBe(pda([Buffer.from('proposal'), count], proposalProgram));
        const flags = idlFlags(PROPOSAL_IDL, 'mint_and_fund');
        expect(metasOf(instruction)).toEqual([proposal.toBase58(), pda([Buffer.from('proposal_counter')], proposalProgram), OWNER, web3.SystemProgram.programId.toBase58()]
            .map((pubkey, i) => ({ pubkey, isSigner: flags[i].isSigner, isWritable: flags[i].isWritable })));
    });

    it('credential PDA matches the backend derivation (sas-lib)', () => {
        expect(client.deriveCredentialPda(MEMBER, 'LensMember').toBase58()).toBe(backendCredentialPda({ authority: MEMBER, name: 'LensMember' }));
    });
});

// ---- account decoders -----------------------------------------------------------------------------

const PROPOSAL_VALUES = {
    proposal_id: 42, owner: OWNER, parcel_ids: [PARCEL_ID, 'HR-335550-2/1'], is_conditional: false, image_uri: 'ipfs://m',
    acceptance_possible: true, status: 0, sol_balance: 5, token_balance: 0, acceptance_count: 1,
    accepted_parcels: ['HR-335550-2/1'], lens: [MEMBER], bump: 254, verdict_may_execute: true
};

describe('account decoders', () => {
    it('readProposalV2 decodes every field including verdict_may_execute', () => {
        const parsed = client.readProposalV2(encodeAccount(PROPOSAL_IDL, 'Proposal', PROPOSAL_VALUES, 4096), PROPOSAL);
        expect(parsed).toMatchObject({
            address: PROPOSAL, proposalId: '42', owner: OWNER, parcelIds: PROPOSAL_VALUES.parcel_ids, acceptancePossible: true,
            statusCode: 0, status: 'Active', solBalance: 5n, acceptanceCount: 1n, acceptedParcels: ['HR-335550-2/1'],
            lens: [MEMBER], bump: 254, verdictMayExecute: true
        });
    });

    it('a v1-era account (zero byte after bump) reads verdict_may_execute false; Expired decodes', () => {
        const parsed = client.readProposalV2(encodeAccount(PROPOSAL_IDL, 'Proposal', { ...PROPOSAL_VALUES, verdict_may_execute: false, status: 3 }, 4096));
        expect(parsed.verdictMayExecute).toBe(false);
        expect(parsed.status).toBe('Expired');
    });

    it('a truncated proposal throws; another account type returns null', () => {
        const full = encodeAccount(PROPOSAL_IDL, 'Proposal', PROPOSAL_VALUES);
        expect(() => client.readProposalV2(full.subarray(0, full.length - 1))).toThrow(/verdict_may_execute/);
        const tally = encodeAccount(PROPOSAL_IDL, 'ConsentTally', { proposal: PROPOSAL, parcel_id: PARCEL_ID, member: MEMBER, required: 2, accepted: 1, bump: 250 });
        expect(client.readProposalV2(tally)).toBeNull();
    });

    it('readConsentTally', () => {
        const bytes = encodeAccount(PROPOSAL_IDL, 'ConsentTally', { proposal: PROPOSAL, parcel_id: PARCEL_ID, member: MEMBER, required: 2, accepted: 1, bump: 250 }, 111);
        expect(client.readConsentTally(bytes, 'T')).toEqual({ address: 'T', proposal: PROPOSAL, parcelId: PARCEL_ID, member: MEMBER, required: 2, accepted: 1, bump: 250 });
    });

    it('readAcceptanceRecord maps the default payout key to null', () => {
        const values = {
            proposal: PROPOSAL, parcel_id: PARCEL_ID, owner: OWNER, member: MEMBER, ownership_attestation: ATTESTATION,
            ownership_hash: Array.from({ length: 32 }, (_, i) => i), payout: PublicKey.default.toBase58(), accepted_at: 1759300000, bump: 251
        };
        const record = client.readAcceptanceRecord(encodeAccount(PROPOSAL_IDL, 'AcceptanceRecord', values, 245), 'R');
        expect(record).toMatchObject({ address: 'R', owner: OWNER, member: MEMBER, ownershipAttestation: ATTESTATION, payout: null, acceptedAt: 1759300000, bump: 251 });
        expect(record.ownershipHash).toBe(Buffer.from(values.ownership_hash).toString('hex'));
        const paid = client.readAcceptanceRecord(encodeAccount(PROPOSAL_IDL, 'AcceptanceRecord', { ...values, payout: PAYOUT }));
        expect(paid.payout).toBe(PAYOUT);
    });

    it('readVerdictRecord decodes every field; a truncated record throws, another kind is null', () => {
        const values = {
            proposal: PROPOSAL, member: MEMBER, verdict_attestation: ATTESTATION,
            verdict_hash: Array.from({ length: 32 }, (_, i) => 255 - i), verdict: 3, settled_at: 1759400000, bump: 249
        };
        const bytes = encodeAccount(PROPOSAL_IDL, 'VerdictRecord', values);
        expect(bytes.length).toBe(8 + 32 * 4 + 1 + 8 + 1);
        expect(client.readVerdictRecord(bytes, 'V')).toEqual({
            address: 'V', proposal: PROPOSAL, member: MEMBER, verdictAttestation: ATTESTATION,
            verdictHash: Buffer.from(values.verdict_hash).toString('hex'), verdictCode: 3, verdict: 'Expired', settledAt: 1759400000, bump: 249
        });
        expect(client.readVerdictRecord(encodeAccount(PROPOSAL_IDL, 'VerdictRecord', { ...values, verdict: 1 })).verdict).toBe('Executed');
        expect(() => client.readVerdictRecord(bytes.subarray(0, bytes.length - 1))).toThrow(/bump/);
        const tally = encodeAccount(PROPOSAL_IDL, 'ConsentTally', { proposal: PROPOSAL, parcel_id: PARCEL_ID, member: MEMBER, required: 2, accepted: 1, bump: 250 });
        expect(client.readVerdictRecord(tally)).toBeNull();
    });

    it('fetchVerdictRecords filters program accounts by the VerdictRecord discriminator and proposal', async () => {
        const bytes = encodeAccount(PROPOSAL_IDL, 'VerdictRecord', {
            proposal: PROPOSAL, member: MEMBER, verdict_attestation: ATTESTATION, verdict_hash: Array(32).fill(1), verdict: 3, settled_at: 1759400000, bump: 249
        });
        const calls = [];
        const connection = {
            async getProgramAccounts(programId, config) {
                calls.push({ programId: programId.toBase58(), config });
                return [{ pubkey: new PublicKey(keyOf(21)), account: { data: bytes } }];
            }
        };
        const records = await client.fetchVerdictRecords(connection, { proposal: PROPOSAL });
        expect(records.map(r => [r.address, r.verdictAttestation])).toEqual([[keyOf(21), ATTESTATION]]);
        expect(calls[0].programId).toBe(PROPOSAL_IDL.address);
        expect(calls[0].config.filters).toEqual([
            { memcmp: { offset: 0, bytes: encodeBase58(Buffer.from(PROPOSAL_IDL.accounts.find(a => a.name === 'VerdictRecord').discriminator)) } },
            { memcmp: { offset: 8, bytes: PROPOSAL } }
        ]);
    });
});

// ---- SAS attestations -----------------------------------------------------------------------------

describe('SAS lens attestations', () => {
    const ownershipFields = { parcelUid: PARCEL_ID, owner: OWNER, ownerCount: 2, evidenceRef: 'case-17', sourceObservedAt: 1759200000 };
    const account = (kind, fields, expiry = 1790000000) => buildSasAttestationAccount({
        nonce: keyOf(1), credential: CREDENTIAL, schema: keyOf(2), payload: encodeLensPayload(kind, fields), authority: MEMBER, expiry
    });

    it('parses the backend reference account and decodes the ownership payload', () => {
        const parsed = client.parseSasAttestation(account('ownership', ownershipFields));
        expect(parsed).toMatchObject({ nonce: keyOf(1), credential: CREDENTIAL, schema: keyOf(2), authority: MEMBER, expiry: 1790000000 });
        expect(client.decodeLensPayload('ownership', parsed.payload)).toEqual(ownershipFields);
    });

    it('decodes a verdict payload and rejects trailing bytes', () => {
        const verdict = { proposalAccount: PROPOSAL, verdict: 'expired', evidenceRef: '', sourceObservedAt: 1759200000 };
        const parsed = client.parseSasAttestation(account('verdict', verdict));
        expect(client.decodeLensPayload('verdict', parsed.payload)).toEqual(verdict);
        expect(() => client.decodeLensPayload('verdict', Buffer.concat([Buffer.from(parsed.payload), Buffer.from([0])]))).toThrow(/trailing/);
        expect(() => client.parseSasAttestation(Buffer.from([1, 2, 3]))).toThrow(/not a SAS attestation/);
    });

    const proposal = () => client.readProposalV2(encodeAccount(PROPOSAL_IDL, 'Proposal', { ...PROPOSAL_VALUES, verdict_may_execute: false }), PROPOSAL);
    const now = 1759300000;
    const check = (overrides = {}, fields = ownershipFields) => client.checkOwnershipForAccept({
        attestation: { authority: MEMBER, expiry: 1790000000, ...overrides }, fields, proposal: proposal(), parcelId: PARCEL_ID, owner: OWNER, nowSeconds: now
    });

    it('checkOwnershipForAccept mirrors the program checks', () => {
        expect(check()).toBeNull();
        expect(check({ authority: keyOf(99) })).toBe('member_not_in_lens');
        expect(check({ expiry: now })).toBe('attestation_expired');
        expect(check({}, { ...ownershipFields, owner: PAYER })).toBe('wrong_owner');
        expect(check({}, { ...ownershipFields, parcelUid: 'other' })).toBe('wrong_parcel');
        expect(check({}, { ...ownershipFields, sourceObservedAt: now + 1 })).toBe('observed_in_future');
        expect(client.checkOwnershipForAccept({ attestation: { authority: MEMBER, expiry: 1790000000 }, fields: ownershipFields, proposal: proposal(), parcelId: 'HR-335550-2/1', owner: OWNER, nowSeconds: now })).toBe('parcel_already_accepted');
    });

    it('checkVerdictForSettle: executed needs verdict_may_execute', () => {
        const verdict = { proposalAccount: PROPOSAL, verdict: 'executed', evidenceRef: '', sourceObservedAt: 1759200000 };
        const run = (p, fields) => client.checkVerdictForSettle({ attestation: { authority: MEMBER, expiry: 1790000000 }, fields, proposal: p, proposalAddress: PROPOSAL, nowSeconds: now });
        expect(run(proposal(), verdict)).toBe('verdict_cannot_execute');
        expect(run({ ...proposal(), verdictMayExecute: true }, verdict)).toBeNull();
        expect(run(proposal(), { ...verdict, verdict: 'expired' })).toBeNull();
        expect(run(proposal(), { ...verdict, proposalAccount: keyOf(5) })).toBe('wrong_proposal');
    });

    it('checkVerdictForSettle refuses an attestation that already has a verdict record', () => {
        const fields = { proposalAccount: PROPOSAL, verdict: 'expired', evidenceRef: '', sourceObservedAt: 1759200000 };
        const run = verdictRecords => client.checkVerdictForSettle({
            attestation: { address: ATTESTATION, authority: MEMBER, expiry: 1790000000 }, fields, proposal: proposal(), proposalAddress: PROPOSAL, verdictRecords, nowSeconds: now
        });
        expect(run([])).toBeNull();
        expect(run([{ verdictAttestation: keyOf(17) }])).toBeNull();
        expect(run([{ verdictAttestation: keyOf(17) }, { verdictAttestation: ATTESTATION }])).toBe('verdict_already_settled');
    });
});

// ---- distribute_funds -----------------------------------------------------------------------------

describe('distribute_funds planning', () => {
    const proposal = { owner: OWNER, acceptedParcels: ['A', 'B'] };
    const tallies = [{ address: keyOf(40), parcelId: 'B', accepted: 1 }, { address: keyOf(41), parcelId: 'A', accepted: 2 }];
    const records = [
        { address: keyOf(50), parcelId: 'A', payout: PAYOUT, acceptedAt: 20 },
        { address: keyOf(51), parcelId: 'A', payout: null, acceptedAt: 10 },
        { address: keyOf(52), parcelId: 'B', payout: null, acceptedAt: 5 }
    ];

    it('orders per accepted parcel: tally, then (record, recipient) pairs; no payout pays the proposal owner', () => {
        const plan = client.planDistribution({ proposal, tallies, records });
        expect(plan.map(e => [e.role, e.pubkey, e.isWritable])).toEqual([
            ['tally', keyOf(41), false], ['record', keyOf(51), false], ['recipient', OWNER, true], ['record', keyOf(50), false], ['recipient', PAYOUT, true],
            ['tally', keyOf(40), false], ['record', keyOf(52), false], ['recipient', OWNER, true]
        ]);
        const ix = client.buildDistributeFundsIx({ proposal: PROPOSAL, remaining: plan });
        expect(metasOf(ix)[0]).toEqual({ pubkey: PROPOSAL, isSigner: false, isWritable: true });
        expect(ix.keys).toHaveLength(1 + plan.length);
    });

    it('refuses when records and the tally disagree; no accepted parcels pays the owner', () => {
        expect(() => client.planDistribution({ proposal, tallies, records: records.slice(1) })).toThrow(/tally says 2/);
        expect(client.planDistribution({ proposal: { owner: OWNER, acceptedParcels: [] } })).toEqual([{ pubkey: OWNER, role: 'owner', isWritable: true }]);
    });
});
