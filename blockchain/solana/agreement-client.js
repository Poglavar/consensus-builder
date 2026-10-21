// Pure client codec for the agreement program (programs/agreement, README there): the Agreement PDA
// from its sponsor and CID, byte-exact Anchor/borsh instruction builders for create, fund, attest,
// execute, cancel and expire, and the Agreement account decoder. CommonJS, no DOM, no wallet: @solana/web3.js
// and sha256 are resolved or injected (configure), and fetchAgreement only reads through a passed
// connection.
'use strict';

// COPIED from the program, never computed at runtime: sha256("global:<instruction>")[..8] and
// sha256("account:Agreement")[..8], the values the generated IDL lists (idl/agreement.json).
const IX_DISCRIMINATORS = Object.freeze({
    create: Object.freeze([24, 30, 200, 40, 5, 28, 7, 119]),
    fund: Object.freeze([218, 188, 111, 221, 152, 113, 174, 7]),
    attest: Object.freeze([83, 148, 120, 119, 144, 139, 117, 160]),
    execute: Object.freeze([130, 221, 242, 154, 13, 193, 189, 29]),
    cancel: Object.freeze([232, 219, 223, 41, 219, 236, 220, 190]),
    expire: Object.freeze([243, 83, 205, 58, 57, 201, 247, 146])
});

const ACCOUNT_DISCRIMINATORS = Object.freeze({
    Agreement: Object.freeze([83, 212, 5, 110, 225, 249, 197, 84])
});

const constants = Object.freeze({
    // Placeholder, not deployed: replace with the deployed id (programs/agreement/README.md, "Program id").
    AGREEMENT_PROGRAM_ID: 'Agreement1111111111111111111111111111111111',
    SAS_PROGRAM_ID: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
    SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
    DEFAULT_PUBKEY: '11111111111111111111111111111111',
    AGREEMENT_SEED: 'agreement',
    MAX_CID_BYTES: 64,
    NO_DEADLINE: 0,
    DECISION_SCHEMA_NAME: 'AgreementDecision',
    DECISION_SCHEMA_VERSION: 1,
    // 8-byte discriminator + Agreement::INIT_SPACE (288).
    AGREEMENT_ACCOUNT_SPACE: 296,
    STATUS_ACTIVE: 0,
    STATUS_EXECUTED: 1,
    STATUS_CANCELLED: 2,
    STATUS_EXPIRED: 3,
    DECISION_PENDING: 0,
    DECISION_SATISFIED: 1,
    DECISION_REFUSED: 2
});

const STATUS_NAMES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired']);
const DECISION_NAMES = Object.freeze(['Pending', 'Satisfied', 'Refused']);

// Offsets of the fixed fields, which all precede the trailing cid: memcmp filters for
// getProgramAccounts (e.g. every agreement a lens settles: { offset: AGREEMENT_OFFSETS.lens, bytes }).
const AGREEMENT_OFFSETS = Object.freeze({
    authority: 8,
    lens: 40,
    payout: 72,
    deadline: 104,
    status: 136,
    decision: 138,
    cid: 228
});

let injectedWeb3 = null;
let injectedSha256Hex = null;
let api = null;

// Injected, the browser's vendored build (window.solanaWeb3), then the package.
function resolveWeb3() {
    if (injectedWeb3) return injectedWeb3;
    if (globalThis.solanaWeb3 && globalThis.solanaWeb3.PublicKey) return globalThis.solanaWeb3;
    let loaded = null;
    try { loaded = require('@solana/web3.js'); } catch (_) { loaded = null; }
    if (loaded && loaded.PublicKey) return loaded;
    throw new Error('@solana/web3.js is not available: pass it to AgreementClient.configure({ web3 })');
}

// sha256 of a UTF-8 string as lowercase hex: injected, the frontend's vendored noble build
// (window.__consentSha256.sha256Hex, frontend/vendor/noble-hashes-1.8.0/sha256.js), then node:crypto.
function resolveSha256Hex() {
    if (injectedSha256Hex) return injectedSha256Hex;
    const vendored = globalThis.__consentSha256;
    if (vendored && typeof vendored.sha256Hex === 'function') return vendored.sha256Hex;
    let nodeCrypto = null;
    try { nodeCrypto = require('crypto'); } catch (_) { nodeCrypto = null; }
    if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
        return text => nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');
    }
    throw new Error('no sha256 is available: pass sha256Hex to AgreementClient.configure({ sha256Hex })');
}

function configure(options) {
    const opts = options || {};
    if (Object.prototype.hasOwnProperty.call(opts, 'web3')) injectedWeb3 = opts.web3 || null;
    if (Object.prototype.hasOwnProperty.call(opts, 'sha256Hex')) injectedSha256Hex = opts.sha256Hex || null;
    return api;
}

// A canonical base58 key (web3 alone also accepts short strings and pads them).
function toKey(value, label) {
    const { PublicKey } = resolveWeb3();
    if (value instanceof PublicKey) return value;
    if (value && typeof value.toBase58 === 'function') return new PublicKey(value.toBase58());
    if (typeof value === 'string') {
        let key = null;
        try { key = new PublicKey(value.trim()); } catch (_) { key = null; }
        if (key && key.toBase58() === value.trim()) return key;
    }
    throw new Error(`${label} must be a base58 public key`);
}

// ---- borsh encoders -----------------------------------------------------------------------------

const utf8 = text => new TextEncoder().encode(text);

function concat(parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function u32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}

function u64(value, label) {
    const big = typeof value === 'bigint' ? value : BigInt(value);
    if (big < 0n || big >= (1n << 64n)) throw new Error(`${label} does not fit u64`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, big, true);
    return out;
}

function i64(value, label) {
    const big = typeof value === 'bigint' ? value : BigInt(value);
    if (big < -(1n << 63n) || big >= (1n << 63n)) throw new Error(`${label} does not fit i64`);
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, big, true);
    return out;
}

function encodeString(value) {
    const bytes = utf8(value);
    return concat([u32(bytes.length), bytes]);
}

function encodeBool(value, label) {
    if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
    return Uint8Array.of(value ? 1 : 0);
}

function encodePubkey(value, label) {
    return Uint8Array.from(toKey(value, label).toBytes());
}

function disc(name) {
    return Uint8Array.from(IX_DISCRIMINATORS[name]);
}

function hexToBytes(hex) {
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw new Error('sha256Hex must return 64 lowercase hex digits');
    return Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
}

// ---- CID and PDA ----------------------------------------------------------------------------------

// The program's rule: 1-64 ASCII letters and digits (a raw sha2-256 CIDv1, `bafkrei…`, is 59).
function requireCid(cid) {
    if (typeof cid !== 'string' || !/^[A-Za-z0-9]+$/.test(cid)) throw new Error('cid must be 1-64 ASCII letters and digits');
    if (cid.length > constants.MAX_CID_BYTES) throw new Error(`cid is ${cid.length} bytes; the program stores at most ${constants.MAX_CID_BYTES}`);
    return cid;
}

// The last PDA seed: sha256 over the CID's UTF-8 bytes (the program's cid_seed).
function cidSeed(cid) {
    return hexToBytes(resolveSha256Hex()(requireCid(cid)));
}

// ["agreement", authority, sha256(cid)] under the agreement program. `authority` is the sponsor that
// creates the account: agreement/v1 carries its wallet as `sponsor` (base58), so the address follows
// from the agreement object alone. Another wallet's account for the same CID is not the agreement's
// and can never record its decision (AgreementDecision-v1 names the sponsor).
function getAgreementPda(cid, authority, programId = constants.AGREEMENT_PROGRAM_ID) {
    const { PublicKey } = resolveWeb3();
    return PublicKey.findProgramAddressSync(
        [utf8(constants.AGREEMENT_SEED), toKey(authority, 'authority').toBytes(), cidSeed(cid)],
        toKey(programId, 'programId')
    );
}

// The agreement/v1 object's `deadline` (ISO string or null) as create's argument: unix seconds, or
// NO_DEADLINE (0) for none.
function toDeadlineSeconds(deadline) {
    if (deadline === null || deadline === undefined || deadline === '') return constants.NO_DEADLINE;
    const ms = Date.parse(deadline);
    if (!Number.isFinite(ms)) throw new Error(`deadline ${JSON.stringify(deadline)} is not a date`);
    return Math.floor(ms / 1000);
}

// ---- instruction data -----------------------------------------------------------------------------

// create(cid: String, lens: Pubkey, deadline: i64, open_ground: bool, required_lamports: u64, payout: Pubkey).
// Mirrors the program's argument checks that need no clock, so a wallet never signs a create the
// program refuses for its arguments (a deadline in the past is still the program's call).
function encodeCreateData({ cid, lens, deadline = constants.NO_DEADLINE, openGround = false, requiredLamports = 0n, payout } = {}) {
    requireCid(cid);
    if (toKey(lens, 'lens').toBase58() === constants.DEFAULT_PUBKEY) throw new Error('lens must not be the default key');
    if (toKey(payout, 'payout').toBase58() === constants.DEFAULT_PUBKEY) throw new Error('payout must not be the default key');
    if (!(typeof deadline === 'bigint' ? deadline >= 0n : Number.isSafeInteger(deadline) && deadline >= 0)) {
        throw new Error('deadline must be unix seconds, or 0 for none');
    }
    return concat([
        disc('create'),
        encodeString(cid),
        encodePubkey(lens, 'lens'),
        i64(deadline, 'deadline'),
        encodeBool(openGround, 'openGround'),
        u64(requiredLamports, 'requiredLamports'),
        encodePubkey(payout, 'payout')
    ]);
}

// fund(lamports: u64)
function encodeFundData(lamports) {
    const data = u64(lamports, 'lamports');
    if (data.every(byte => byte === 0)) throw new Error('lamports must be greater than zero');
    return concat([disc('fund'), data]);
}

// attest(), execute(), cancel() and expire() take no arguments.
const encodeAttestData = () => disc('attest');
const encodeExecuteData = () => disc('execute');
const encodeCancelData = () => disc('cancel');
const encodeExpireData = () => disc('expire');

// ---- instruction builders -------------------------------------------------------------------------

function meta(pubkey, isSigner, isWritable) {
    return { pubkey, isSigner, isWritable };
}

function instruction(programId, keys, data) {
    const { TransactionInstruction } = resolveWeb3();
    return new TransactionInstruction({
        programId: toKey(programId, 'programId'),
        keys,
        data: typeof Buffer === 'function' ? Buffer.from(data) : data
    });
}

// The agreement account, given directly or derived from its CID and authority (the sponsor).
function agreementKey({ agreement, cid, authority, programId }) {
    if (agreement) return toKey(agreement, 'agreement');
    if (cid && authority) return getAgreementPda(cid, authority, programId)[0];
    throw new Error('agreement (address), or cid and authority, is required');
}

const systemProgram = () => toKey(constants.SYSTEM_PROGRAM_ID, 'system program');

// Accounts: agreement (mut, PDA of this authority and cid), authority (signer, mut: the sponsor, pays
// the rent), system_program.
function buildCreateIx({ authority, programId = constants.AGREEMENT_PROGRAM_ID, ...args } = {}) {
    const [agreement] = getAgreementPda(args.cid, authority, programId);
    if (toKey(args.payout, 'payout').equals(agreement)) throw new Error('payout must not be the agreement itself');
    return {
        agreement,
        instruction: instruction(programId, [
            meta(agreement, false, true),
            meta(toKey(authority, 'authority'), true, true),
            meta(systemProgram(), false, false)
        ], encodeCreateData(args))
    };
}

// Accounts: agreement (mut), authority (signer, mut: the agreement's authority, its only funder),
// system_program.
function buildFundIx({ agreement, cid, authority, lamports, programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
    return instruction(programId, [
        meta(agreementKey({ agreement, cid, authority, programId }), false, true),
        meta(toKey(authority, 'authority'), true, true),
        meta(systemProgram(), false, false)
    ], encodeFundData(lamports));
}

// Accounts: agreement (mut), attestation (the lens's AgreementDecision-v1 SAS account), credential
// (the SAS credential it was issued under: bytes 33..65 of the attestation). No signer of its own;
// `authority` only derives the address when `agreement` is not given.
function buildAttestIx({ agreement, cid, authority, attestation, credential, programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
    return instruction(programId, [
        meta(agreementKey({ agreement, cid, authority, programId }), false, true),
        meta(toKey(attestation, 'attestation'), false, false),
        meta(toKey(credential, 'credential'), false, false)
    ], encodeAttestData());
}

// Accounts: agreement (mut), payout (mut: must be the agreement's payout). `authority` only derives
// the address when `agreement` is not given.
function buildExecuteIx({ agreement, cid, authority, payout, programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
    return instruction(programId, [
        meta(agreementKey({ agreement, cid, authority, programId }), false, true),
        meta(toKey(payout, 'payout'), false, true)
    ], encodeExecuteData());
}

// Accounts: agreement (mut), authority (signer, mut: receives the refund).
function buildCancelIx({ agreement, cid, authority, programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
    return instruction(programId, [
        meta(agreementKey({ agreement, cid, authority, programId }), false, true),
        meta(toKey(authority, 'authority'), true, true)
    ], encodeCancelData());
}

// Accounts: agreement (mut), authority (mut, not a signer: the agreement's authority receives the
// refund). Anyone may send it.
function buildExpireIx({ agreement, cid, authority, programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
    return instruction(programId, [
        meta(agreementKey({ agreement, cid, authority, programId }), false, true),
        meta(toKey(authority, 'authority'), false, true)
    ], encodeExpireData());
}

// ---- decoder --------------------------------------------------------------------------------------
// Truncation throws; a wrong discriminator returns null (it is some other account).

function reader(bytes, start) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = start;
    const need = (count, label) => {
        if (offset + count > bytes.length) throw new RangeError(`account truncated reading ${label} at byte ${offset}`);
    };
    const take = (count, label) => {
        need(count, label);
        const out = bytes.slice(offset, offset + count);
        offset += count;
        return out;
    };
    return {
        u8(label) { need(1, label); return bytes[offset++]; },
        bool(label) {
            need(1, label);
            const value = bytes[offset++];
            if (value > 1) throw new RangeError(`${label} is not a bool`);
            return value === 1;
        },
        u64(label) { need(8, label); const value = view.getBigUint64(offset, true); offset += 8; return value; },
        i64(label) {
            need(8, label);
            const value = view.getBigInt64(offset, true);
            offset += 8;
            if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
                throw new RangeError(`${label} exceeds the safe integer range`);
            }
            return Number(value);
        },
        bytes: take,
        pubkey(label) {
            const { PublicKey } = resolveWeb3();
            return new PublicKey(take(32, label)).toBase58();
        },
        string(label) {
            need(4, label);
            const length = view.getUint32(offset, true);
            offset += 4;
            return new TextDecoder('utf-8', { fatal: true }).decode(take(length, label));
        }
    };
}

function hasDiscriminator(bytes, expected) {
    if (!bytes || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== expected[i]) return false;
    return true;
}

const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

// The whole Agreement account, in field order (programs/agreement/README.md, "Agreement account").
// Lamport amounts are BigInt; times are unix seconds (0 = not yet / no deadline).
function readAgreement(data, address = null) {
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
    if (!hasDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.Agreement)) return null;
    const r = reader(bytes, 8);
    const authority = r.pubkey('authority');
    const lens = r.pubkey('lens');
    const payout = r.pubkey('payout');
    const deadline = r.i64('deadline');
    const createdAt = r.i64('created_at');
    const requiredLamports = r.u64('required_lamports');
    const escrowLamports = r.u64('escrow_lamports');
    const statusCode = r.u8('status');
    const openGround = r.bool('open_ground');
    const decisionCode = r.u8('decision');
    const decisionAttestedAt = r.i64('decision_attested_at');
    const decisionObservedAt = r.i64('decision_observed_at');
    const decisionAttestation = r.pubkey('decision_attestation');
    const decisionHash = r.bytes(32, 'decision_hash');
    const executedAt = r.i64('executed_at');
    const bump = r.u8('bump');
    const cid = r.string('cid');
    const pending = decisionCode === constants.DECISION_PENDING;
    return {
        address,
        cid,
        authority,
        lens,
        payout,
        deadline,
        createdAt,
        requiredLamports,
        escrowLamports,
        statusCode,
        status: STATUS_NAMES[statusCode] || `Unknown(${statusCode})`,
        openGround,
        decisionCode,
        decision: DECISION_NAMES[decisionCode] || `Unknown(${decisionCode})`,
        decisionAttestedAt,
        decisionObservedAt,
        decisionAttestation: pending ? null : decisionAttestation,
        decisionHash: pending ? null : toHex(decisionHash),
        executedAt,
        bump
    };
}

// ---- read (connection injected) -------------------------------------------------------------------

// By { cid, authority } (derives the PDA; the authority is agreement/v1's `sponsor`) or by { address }.
// Checks the owner program and, when given, the stored CID and authority. null when the account is absent.
async function fetchAgreement(connection, { cid, authority, address, programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
    if (!address && !(cid && authority)) throw new Error('fetchAgreement needs { cid, authority } or { address }');
    const key = address ? toKey(address, 'address') : getAgreementPda(cid, authority, programId)[0];
    const info = await connection.getAccountInfo(key, 'confirmed');
    if (!info || !info.data) return null;
    if (!toKey(info.owner, 'owner').equals(toKey(programId, 'programId'))) {
        throw new Error(`account ${key.toBase58()} belongs to another program`);
    }
    const value = readAgreement(new Uint8Array(info.data), key.toBase58());
    if (!value) throw new Error(`account ${key.toBase58()} does not have the Agreement discriminator`);
    if (cid && value.cid !== cid) throw new Error(`agreement ${key.toBase58()} stores CID ${value.cid}, not ${cid}`);
    if (authority && value.authority !== toKey(authority, 'authority').toBase58()) {
        throw new Error(`agreement ${key.toBase58()} belongs to ${value.authority}, not ${toKey(authority, 'authority').toBase58()}`);
    }
    return value;
}

api = {
    constants,
    IX_DISCRIMINATORS,
    ACCOUNT_DISCRIMINATORS,
    STATUS_NAMES,
    DECISION_NAMES,
    AGREEMENT_OFFSETS,
    configure,
    requireCid,
    cidSeed,
    getAgreementPda,
    toDeadlineSeconds,
    encodeCreateData,
    encodeFundData,
    encodeAttestData,
    encodeExecuteData,
    encodeCancelData,
    encodeExpireData,
    buildCreateIx,
    buildFundIx,
    buildAttestIx,
    buildExecuteIx,
    buildCancelIx,
    buildExpireIx,
    readAgreement,
    fetchAgreement
};

module.exports = api;
