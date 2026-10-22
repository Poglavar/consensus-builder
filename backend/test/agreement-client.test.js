// Unit tests for frontend/js/solana/agreement-client.js, the pure codec of the `agreement` program
// (blockchain/solana/programs/agreement, README "Agreement account", "Instructions" and
// "AgreementDecision-v1"): discriminators re-derived from sha256 and checked against the generated
// IDL, the PDA from the sponsor and the CID, instruction data decoded back by the IDL's argument
// types and account metas against the IDL's flags, the Agreement account decoded from bytes written
// at the README's offsets, the lens's SAS attestation, and the program's attest checks.
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const web3 = require('@solana/web3.js');
const client = require('../../frontend/js/solana/agreement-client.js');

const { PublicKey } = web3;
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/agreement.json'), 'utf8'));
const README = readFileSync(path.join(REPO, 'blockchain/solana/programs/agreement/README.md'), 'utf8');
const C = client.constants;

// The module resolves web3 relative to frontend/js/solana, where @solana/web3.js is not installed:
// the tests hand it over the way the browser's vendored build would (before the describes, which
// derive addresses while they are collected).
client.configure({ web3 });
afterAll(() => { client.configure({ web3: null }); });

const keyOf = byte => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
const SPONSOR = keyOf(7);
const OTHER = keyOf(9);
const LENS = keyOf(11);
const PAYOUT = keyOf(13);
const CREDENTIAL = keyOf(17);
const CID = 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq';
const NOW = 1_790_000_000;
const sha256 = text => createHash('sha256').update(text).digest();
const anchor = (prefix, name) => Array.from(sha256(`${prefix}:${name}`).subarray(0, 8));
const idlInstruction = name => IDL.instructions.find(ix => ix.name === name);
const idlType = name => IDL.types.find(type => type.name === name);

// ---- byte builders, by the README's layout ------------------------------------------------------

const u32 = value => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
const i64 = value => { const out = Buffer.alloc(8); out.writeBigInt64LE(BigInt(value)); return out; };
const str = text => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text, 'utf8')]);
const keyBytes = key => new PublicKey(key).toBuffer();

// An Agreement account: every fixed field written at its README offset, padded to the 296-byte account.
function agreementBytes(fields = {}) {
    const f = {
        authority: SPONSOR, lens: LENS, payout: PAYOUT, deadline: 0, createdAt: NOW - 600, requiredLamports: 2_000_000_000n,
        escrowLamports: 500_000_000n, status: 0, openGround: 0, decision: 0, decisionAttestedAt: 0, decisionObservedAt: 0,
        decisionAttestation: keyOf(0), decisionHash: Buffer.alloc(32), executedAt: 0, bump: 253, cid: CID, ...fields
    };
    const bytes = Buffer.alloc(C.AGREEMENT_ACCOUNT_SPACE);
    Buffer.from(client.ACCOUNT_DISCRIMINATORS.Agreement).copy(bytes, 0);
    keyBytes(f.authority).copy(bytes, 8);
    keyBytes(f.lens).copy(bytes, 40);
    keyBytes(f.payout).copy(bytes, 72);
    bytes.writeBigInt64LE(BigInt(f.deadline), 104);
    bytes.writeBigInt64LE(BigInt(f.createdAt), 112);
    bytes.writeBigUInt64LE(BigInt(f.requiredLamports), 120);
    bytes.writeBigUInt64LE(BigInt(f.escrowLamports), 128);
    bytes[136] = f.status;
    bytes[137] = f.openGround;
    bytes[138] = f.decision;
    bytes.writeBigInt64LE(BigInt(f.decisionAttestedAt), 139);
    bytes.writeBigInt64LE(BigInt(f.decisionObservedAt), 147);
    keyBytes(f.decisionAttestation).copy(bytes, 155);
    Buffer.from(f.decisionHash).copy(bytes, 187);
    bytes.writeBigInt64LE(BigInt(f.executedAt), 219);
    bytes[227] = f.bump;
    str(f.cid).copy(bytes, 228);
    return bytes;
}

// A SAS attestation account: 2 | nonce | credential | schema | data (u32 + bytes) | signer | expiry | token_account.
function attestationBytes({
    credential = CREDENTIAL, schema = client.getDecisionSchemaPda(CREDENTIAL)[0].toBase58(), signer = LENS, expiry = NOW + 3600,
    agreementCid = CID, sponsor = SPONSOR, decision = 'satisfied', evidenceRef = 'sha256:abc', sourceObservedAt = NOW - 60, trailing = Buffer.alloc(0)
} = {}) {
    const payload = Buffer.concat([str(agreementCid), str(sponsor), str(decision), str(evidenceRef), i64(sourceObservedAt), trailing]);
    return Buffer.concat([Buffer.from([2]), keyBytes(keyOf(21)), keyBytes(credential), keyBytes(schema), u32(payload.length), payload,
        keyBytes(signer), i64(expiry), keyBytes(keyOf(0))]);
}

// Reads instruction data back by the IDL's argument types (borsh), so the encoder cannot drift from it.
function decodeArgs(name, data) {
    const bytes = Buffer.from(data);
    expect(Array.from(bytes.subarray(0, 8)), `${name} discriminator`).toEqual(idlInstruction(name).discriminator);
    let offset = 8;
    const out = {};
    for (const arg of idlInstruction(name).args) {
        if (arg.type === 'string') { const length = bytes.readUInt32LE(offset); out[arg.name] = bytes.subarray(offset + 4, offset + 4 + length).toString('utf8'); offset += 4 + length; }
        else if (arg.type === 'pubkey') { out[arg.name] = new PublicKey(bytes.subarray(offset, offset + 32)).toBase58(); offset += 32; }
        else if (arg.type === 'i64') { out[arg.name] = bytes.readBigInt64LE(offset); offset += 8; }
        else if (arg.type === 'u64') { out[arg.name] = bytes.readBigUInt64LE(offset); offset += 8; }
        else if (arg.type === 'bool') { out[arg.name] = bytes[offset] === 1; offset += 1; }
        else throw new Error(`unhandled IDL type ${JSON.stringify(arg.type)}`);
    }
    expect(offset, `${name} data has trailing bytes`).toBe(bytes.length);
    return out;
}

// Each account meta against the IDL's: same order, same signer and writable flags.
function metas(name, instruction) {
    const expected = idlInstruction(name).accounts.map(account => ({ name: account.name, signer: Boolean(account.signer), writable: Boolean(account.writable) }));
    expect(instruction.keys.map((key, index) => ({ name: expected[index]?.name, signer: key.isSigner, writable: key.isWritable })), name).toEqual(expected);
    return Object.fromEntries(idlInstruction(name).accounts.map((account, index) => [account.name, instruction.keys[index].pubkey.toBase58()]));
}

describe('discriminators and names', () => {
    it('are sha256("global:<instruction>") and sha256("account:Agreement"), as the generated IDL lists them', () => {
        expect(Object.keys(client.IX_DISCRIMINATORS).sort()).toEqual(IDL.instructions.map(ix => ix.name).sort());
        for (const ix of IDL.instructions) {
            expect(Array.from(client.IX_DISCRIMINATORS[ix.name]), ix.name).toEqual(anchor('global', ix.name));
            expect(Array.from(client.IX_DISCRIMINATORS[ix.name]), ix.name).toEqual(ix.discriminator);
        }
        expect(IDL.accounts.map(account => account.name)).toEqual(['Agreement']);
        expect(Array.from(client.ACCOUNT_DISCRIMINATORS.Agreement)).toEqual(anchor('account', 'Agreement'));
        expect(Array.from(client.ACCOUNT_DISCRIMINATORS.Agreement)).toEqual(IDL.accounts[0].discriminator);
    });

    it('name the program, the statuses and the decisions as the IDL does: a decision is Pending until Satisfied', () => {
        expect(C.AGREEMENT_PROGRAM_ID).toBe(IDL.address);
        expect(client.STATUS_NAMES).toEqual(idlType('AgreementStatus').type.variants.map(variant => variant.name));
        expect(client.DECISION_NAMES).toEqual(['Pending', 'Satisfied']);
        expect(client.DECISION_NAMES).toEqual(idlType('Decision').type.variants.map(variant => variant.name));
        expect([C.STATUS_ACTIVE, C.STATUS_EXECUTED, C.STATUS_CANCELLED, C.STATUS_EXPIRED]).toEqual([0, 1, 2, 3]);
        expect([C.DECISION_PENDING, C.DECISION_SATISFIED]).toEqual([0, 1]);
        expect(C.SYSTEM_PROGRAM_ID).toBe(web3.SystemProgram.programId.toBase58());
        expect(C.SYSTEM_PROGRAM_ID).toBe(idlInstruction('create').accounts.find(account => account.name === 'system_program').address);
    });
});

describe('the Agreement account layout', () => {
    it('puts every fixed field at the README\'s offset, which the IDL\'s field sizes add up to', () => {
        const readme = Object.fromEntries([...README.matchAll(/^\| (\d+) \| `(\w+)` \|/gm)].map(match => [match[2], Number(match[1])]));
        const sizes = { pubkey: 32, i64: 8, u64: 8, bool: 1, u8: 1 };
        let offset = 8;
        const fromIdl = {};
        for (const field of idlType('Agreement').type.fields) {
            fromIdl[field.name] = offset;
            if (field.type === 'string') break;
            offset += field.type.defined ? 1 : field.type.array ? field.type.array[1] : sizes[field.type];
        }
        expect(fromIdl).toEqual(readme);
        expect(client.AGREEMENT_OFFSETS).toEqual({
            authority: readme.authority, lens: readme.lens, payout: readme.payout, deadline: readme.deadline,
            status: readme.status, decision: readme.decision, cid: readme.cid
        });
        // 8 + Agreement::INIT_SPACE, with the cid at most 64 bytes behind its u32 length.
        expect(C.AGREEMENT_ACCOUNT_SPACE).toBe(readme.cid + 4 + C.MAX_CID_BYTES);
        expect(README).toContain(`8-byte discriminator + ${C.AGREEMENT_ACCOUNT_SPACE - 8} bytes = ${C.AGREEMENT_ACCOUNT_SPACE}`);
    });
});

describe('the agreement address', () => {
    it('is ["agreement", sponsor, sha256(cid)] under the agreement program', () => {
        const [address, bump] = client.getAgreementPda(CID, SPONSOR);
        const [expected, expectedBump] = PublicKey.findProgramAddressSync(
            [Buffer.from('agreement'), new PublicKey(SPONSOR).toBuffer(), sha256(CID)], new PublicKey(IDL.address));
        expect(address.toBase58()).toBe(expected.toBase58());
        expect(bump).toBe(expectedBump);
        expect(Buffer.from(client.cidSeed(CID))).toEqual(sha256(CID));
        expect(client.getAgreementPda(CID, new PublicKey(SPONSOR))[0].toBase58()).toBe(expected.toBase58());
    });

    it('belongs to one sponsor and one CID: another wallet\'s account for the CID is another address', () => {
        const mine = client.getAgreementPda(CID, SPONSOR)[0].toBase58();
        expect(client.getAgreementPda(CID, OTHER)[0].toBase58()).not.toBe(mine);
        expect(client.getAgreementPda(`${CID.slice(0, -1)}a`, SPONSOR)[0].toBase58()).not.toBe(mine);
        expect(client.getAgreementPda(CID, SPONSOR, keyOf(5))[0].toBase58()).not.toBe(mine);
    });

    it('refuses a CID the program would refuse: 1-64 ASCII letters and digits', () => {
        expect(client.requireCid('a'.repeat(64))).toBe('a'.repeat(64));
        for (const bad of ['', 'a'.repeat(65), 'bafy-kre', 'čid', ' bafkrei', null, 42]) {
            expect(() => client.getAgreementPda(bad, SPONSOR), String(bad)).toThrow(/cid/);
        }
        expect(() => client.getAgreementPda(CID, 'not-a-key')).toThrow(/authority must be a base58 public key/);
    });
});

describe('instructions', () => {
    it('create carries cid, lens, deadline, open ground, required lamports and payout in the IDL\'s order', () => {
        const { agreement, instruction } = client.buildCreateIx({
            authority: SPONSOR, cid: CID, lens: LENS, deadline: NOW + 86400, openGround: true, requiredLamports: 2_500_000_000n, payout: PAYOUT
        });
        expect(agreement.toBase58()).toBe(client.getAgreementPda(CID, SPONSOR)[0].toBase58());
        expect(instruction.programId.toBase58()).toBe(IDL.address);
        expect(decodeArgs('create', instruction.data)).toEqual({
            cid: CID, lens: LENS, deadline: BigInt(NOW + 86400), open_ground: true, required_lamports: 2_500_000_000n, payout: PAYOUT
        });
        expect(metas('create', instruction)).toEqual({ agreement: agreement.toBase58(), authority: SPONSOR, system_program: C.SYSTEM_PROGRAM_ID });
        // Defaults: no deadline, closed land, no escrow needed.
        expect(decodeArgs('create', client.encodeCreateData({ cid: CID, lens: LENS, payout: PAYOUT })))
            .toMatchObject({ deadline: 0n, open_ground: false, required_lamports: 0n });
    });

    it('create refuses what the program refuses for its arguments, before any wallet signs', () => {
        const args = { authority: SPONSOR, cid: CID, lens: LENS, payout: PAYOUT };
        expect(() => client.buildCreateIx({ ...args, lens: C.DEFAULT_PUBKEY })).toThrow(/lens must not be the default key/);
        expect(() => client.buildCreateIx({ ...args, payout: C.DEFAULT_PUBKEY })).toThrow(/payout must not be the default key/);
        expect(() => client.buildCreateIx({ ...args, payout: client.getAgreementPda(CID, SPONSOR)[0] })).toThrow(/payout must not be the agreement itself/);
        expect(() => client.buildCreateIx({ ...args, deadline: -1 })).toThrow(/deadline/);
        expect(() => client.buildCreateIx({ ...args, deadline: 1.5 })).toThrow(/deadline/);
        expect(() => client.buildCreateIx({ ...args, requiredLamports: -1n })).toThrow(/u64/);
        expect(() => client.buildCreateIx({ ...args, openGround: 'yes' })).toThrow(/boolean/);
    });

    it('fund carries the lamports, and never zero', () => {
        const instruction = client.buildFundIx({ cid: CID, authority: SPONSOR, lamports: 750_000_000n });
        expect(decodeArgs('fund', instruction.data)).toEqual({ lamports: 750_000_000n });
        expect(metas('fund', instruction)).toEqual({ agreement: client.getAgreementPda(CID, SPONSOR)[0].toBase58(), authority: SPONSOR, system_program: C.SYSTEM_PROGRAM_ID });
        expect(() => client.buildFundIx({ cid: CID, authority: SPONSOR, lamports: 0n })).toThrow(/greater than zero/);
    });

    it('attest, execute, cancel and expire carry no arguments, with the IDL\'s accounts', () => {
        const agreement = keyOf(31);
        const attest = client.buildAttestIx({ agreement, attestation: keyOf(33), credential: CREDENTIAL });
        expect(decodeArgs('attest', attest.data)).toEqual({});
        expect(metas('attest', attest)).toEqual({ agreement, attestation: keyOf(33), credential: CREDENTIAL });
        const execute = client.buildExecuteIx({ agreement, payout: PAYOUT });
        expect(decodeArgs('execute', execute.data)).toEqual({});
        expect(metas('execute', execute)).toEqual({ agreement, payout: PAYOUT });
        const cancel = client.buildCancelIx({ agreement, authority: SPONSOR });
        expect(decodeArgs('cancel', cancel.data)).toEqual({});
        expect(metas('cancel', cancel)).toEqual({ agreement, authority: SPONSOR });
        // Expire is anyone's: the authority receives the refund and does not sign.
        const expire = client.buildExpireIx({ agreement, authority: SPONSOR });
        expect(decodeArgs('expire', expire.data)).toEqual({});
        expect(metas('expire', expire)).toEqual({ agreement, authority: SPONSOR });
        // Without the account, its address is derived from the CID and the sponsor.
        expect(client.buildExecuteIx({ cid: CID, authority: SPONSOR, payout: PAYOUT }).keys[0].pubkey.toBase58())
            .toBe(client.getAgreementPda(CID, SPONSOR)[0].toBase58());
        expect(() => client.buildExecuteIx({ payout: PAYOUT })).toThrow(/agreement \(address\), or cid and authority, is required/);
    });

    it('turns an agreement/v1 deadline into create\'s unix seconds, none being 0', () => {
        expect(client.toDeadlineSeconds(null)).toBe(0);
        expect(client.toDeadlineSeconds(undefined)).toBe(0);
        expect(client.toDeadlineSeconds('')).toBe(0);
        expect(client.toDeadlineSeconds('2026-12-31T23:59:59.999Z')).toBe(Math.floor(Date.parse('2026-12-31T23:59:59.999Z') / 1000));
        expect(() => client.toDeadlineSeconds('end of year')).toThrow(/not a date/);
    });
});

describe('reading an Agreement account', () => {
    it('decodes every field from the bytes the program writes', () => {
        const hash = Buffer.alloc(32, 0xab);
        const value = client.readAgreement(agreementBytes({
            deadline: NOW + 86400, status: 0, openGround: 1, decision: 1, decisionAttestedAt: NOW - 30, decisionObservedAt: NOW - 90,
            decisionAttestation: keyOf(41), decisionHash: hash
        }), 'Account1');
        expect(value).toEqual({
            address: 'Account1', cid: CID, authority: SPONSOR, lens: LENS, payout: PAYOUT, deadline: NOW + 86400, createdAt: NOW - 600,
            requiredLamports: 2_000_000_000n, escrowLamports: 500_000_000n, statusCode: 0, status: 'Active', openGround: true,
            decisionCode: 1, decision: 'Satisfied', decisionAttestedAt: NOW - 30, decisionObservedAt: NOW - 90,
            decisionAttestation: keyOf(41), decisionHash: 'ab'.repeat(32), executedAt: 0, bump: 253
        });
    });

    it('has no recorded attestation while the decision is pending, and names every status', () => {
        const pending = client.readAgreement(agreementBytes({ decisionAttestation: keyOf(41), decisionHash: Buffer.alloc(32, 1) }));
        expect(pending).toMatchObject({ decision: 'Pending', decisionAttestation: null, decisionHash: null, address: null });
        expect([0, 1, 2, 3, 7].map(status => client.readAgreement(agreementBytes({ status })).status))
            .toEqual(['Active', 'Executed', 'Cancelled', 'Expired', 'Unknown(7)']);
        expect(client.readAgreement(agreementBytes({ decision: 5 })).decision).toBe('Unknown(5)');
    });

    it('reads an account without its padding, and refuses another account or a truncated one', () => {
        const exact = agreementBytes().subarray(0, 228 + 4 + CID.length);
        expect(client.readAgreement(exact).cid).toBe(CID);
        const other = agreementBytes();
        other[0] ^= 0xff;
        expect(client.readAgreement(other)).toBeNull();
        expect(client.readAgreement(new Uint8Array(4))).toBeNull();
        expect(() => client.readAgreement(agreementBytes().subarray(0, 200))).toThrow(RangeError);
        expect(() => client.readAgreement(exact.subarray(0, exact.length - 1))).toThrow(RangeError);
        const notBool = agreementBytes();
        notBool[137] = 2;
        expect(() => client.readAgreement(notBool)).toThrow(/open_ground is not a bool/);
    });

    it('tells when a deadline has passed: one is set and the chain time is after it', () => {
        expect(client.deadlinePassed({ deadline: 0 }, NOW)).toBe(false);
        expect(client.deadlinePassed({ deadline: NOW }, NOW)).toBe(false);
        expect(client.deadlinePassed({ deadline: NOW - 1 }, NOW)).toBe(true);
        expect(client.deadlinePassed(null, NOW)).toBe(false);
    });
});

describe('the lens\'s AgreementDecision-v1 attestation', () => {
    it('reads the SAS account and its payload as the program consumes them', () => {
        const value = client.readDecisionAttestation(attestationBytes(), 'Attestation1');
        expect(value).toEqual({
            address: 'Attestation1', nonce: keyOf(21), credential: CREDENTIAL, schema: client.getDecisionSchemaPda(CREDENTIAL)[0].toBase58(),
            signer: LENS, expiry: NOW + 3600,
            fields: { agreementCid: CID, sponsor: SPONSOR, decision: 'satisfied', evidenceRef: 'sha256:abc', sourceObservedAt: NOW - 60 }
        });
    });

    it('refuses an account that is not a SAS attestation, and a payload with trailing bytes', () => {
        const bytes = attestationBytes();
        bytes[0] = 1;
        expect(() => client.readDecisionAttestation(bytes)).toThrow(/not a SAS attestation/);
        expect(() => client.readDecisionAttestation(attestationBytes({ trailing: Buffer.from([0]) }))).toThrow(/trailing bytes/);
        expect(() => client.readDecisionAttestation(attestationBytes().subarray(0, 120))).toThrow(RangeError);
    });

    it('names its schema ["schema", credential, "AgreementDecision", [1]] under SAS', () => {
        const [schema] = PublicKey.findProgramAddressSync(
            [Buffer.from('schema'), new PublicKey(CREDENTIAL).toBuffer(), Buffer.from('AgreementDecision'), Buffer.from([1])], new PublicKey(C.SAS_PROGRAM_ID));
        expect(client.getDecisionSchemaPda(CREDENTIAL)[0].toBase58()).toBe(schema.toBase58());
        expect(client.getDecisionSchemaPda(OTHER)[0].toBase58()).not.toBe(schema.toBase58());
    });
});

describe('the attest checks the two accounts can answer', () => {
    const account = fields => client.readAgreement(agreementBytes(fields));
    const attestation = fields => client.readDecisionAttestation(attestationBytes(fields));
    const check = (agreementFields = {}, attestationFields = {}) => client.checkDecisionForAttest({
        agreement: account(agreementFields), attestation: attestation(attestationFields), nowSeconds: NOW
    });

    it('pass a satisfied decision by the agreement\'s lens, about this CID and sponsor, while it is active and pending', () => {
        expect(check()).toBeNull();
        expect(check({ deadline: NOW + 60 })).toBeNull();
    });

    it('accept "satisfied" only: the lens never refuses', () => {
        for (const decision of ['refused', 'rejected', 'Satisfied', 'pending', '']) {
            expect(check({}, { decision }), decision).toBe('unknown-decision');
        }
    });

    it('name the first thing the program would refuse', () => {
        expect(client.checkDecisionForAttest({ agreement: null, attestation: attestation(), nowSeconds: NOW })).toBe('agreement-missing');
        expect(check({ status: 2 })).toBe('not-active');
        expect(check({ decision: 1 })).toBe('decision-recorded');
        expect(check({ deadline: NOW - 1 })).toBe('deadline-passed');
        expect(client.checkDecisionForAttest({ agreement: account(), attestation: null, nowSeconds: NOW })).toBe('attestation-missing');
        expect(check({}, { expiry: NOW })).toBe('attestation-expired');
        expect(check({}, { schema: keyOf(51) })).toBe('wrong-schema');
        expect(check({}, { signer: OTHER })).toBe('wrong-lens');
        expect(check({}, { agreementCid: `${CID.slice(0, -1)}a` })).toBe('wrong-cid');
        expect(check({}, { sponsor: OTHER })).toBe('wrong-sponsor');
        expect(check({}, { sourceObservedAt: NOW + 1 })).toBe('observed-in-future');
    });
});

describe('fetching through a connection', () => {
    const programKey = new PublicKey(C.AGREEMENT_PROGRAM_ID);
    const sasKey = new PublicKey(C.SAS_PROGRAM_ID);
    function connection(accounts) {
        const asked = [];
        return {
            asked,
            getAccountInfo: async (key, commitment) => { asked.push([key.toBase58(), commitment]); return accounts.get(key.toBase58()) || null; }
        };
    }
    const address = client.getAgreementPda(CID, SPONSOR)[0].toBase58();

    it('reads the agreement at the sponsor\'s address by CID, or at a given address, and null when absent', async () => {
        const chain = connection(new Map([[address, { owner: programKey, data: agreementBytes() }]]));
        await expect(client.fetchAgreement(chain, { cid: CID, authority: SPONSOR })).resolves.toMatchObject({ address, cid: CID, authority: SPONSOR, status: 'Active' });
        expect(chain.asked).toEqual([[address, 'confirmed']]);
        await expect(client.fetchAgreement(chain, { address })).resolves.toMatchObject({ address, cid: CID });
        await expect(client.fetchAgreement(chain, { cid: CID, authority: OTHER })).resolves.toBeNull();
        await expect(client.fetchAgreement(chain, {})).rejects.toThrow(/needs \{ cid, authority \} or \{ address \}/);
    });

    it('refuses an account of another program, without the discriminator, or holding another CID or sponsor', async () => {
        const foreign = connection(new Map([[address, { owner: sasKey, data: agreementBytes() }]]));
        await expect(client.fetchAgreement(foreign, { address })).rejects.toThrow(/belongs to another program/);
        const garbled = agreementBytes();
        garbled[1] ^= 1;
        await expect(client.fetchAgreement(connection(new Map([[address, { owner: programKey, data: garbled }]])), { address })).rejects.toThrow(/discriminator/);
        const chain = connection(new Map([[address, { owner: programKey, data: agreementBytes({ cid: 'bafkreiother' }) }]]));
        await expect(client.fetchAgreement(chain, { address, cid: CID })).rejects.toThrow(/stores CID bafkreiother/);
        const squatted = connection(new Map([[address, { owner: programKey, data: agreementBytes({ authority: OTHER }) }]]));
        await expect(client.fetchAgreement(squatted, { address, authority: SPONSOR })).rejects.toThrow(/belongs to/);
    });

    it('reads the lens\'s attestation only from a SAS account', async () => {
        const at = keyOf(61);
        await expect(client.fetchDecisionAttestation(connection(new Map([[at, { owner: sasKey, data: attestationBytes() }]])), at))
            .resolves.toMatchObject({ address: at, signer: LENS, fields: { decision: 'satisfied' } });
        await expect(client.fetchDecisionAttestation(connection(new Map()), at)).resolves.toBeNull();
        await expect(client.fetchDecisionAttestation(connection(new Map([[at, { owner: programKey, data: attestationBytes() }]])), at))
            .rejects.toThrow(/not a SAS attestation/);
    });
});
