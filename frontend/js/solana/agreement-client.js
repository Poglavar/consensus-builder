// Pure client codec for the agreement program (blockchain/solana/programs/agreement, README there):
// the Agreement PDA from its sponsor and CID, byte-exact Anchor/borsh instruction builders for
// create, fund, attest, execute, cancel and expire, the Agreement account decoder, the reader of a
// plan's agreements (memcmp on the plan CID hash) and the reader of the lens's AgreementDecision-v1
// SAS attestation. No DOM and no wallet: @solana/web3.js and sha256
// are injected (configure), the browser's vendored builds, or the node packages; fetchAgreement only
// reads through a passed connection. UMD like market-client.js: window.AgreementClient in the
// browser (frontend/js/solana/agreement-bridge.js drives it), module.exports for node.
(function attachAgreementClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AgreementClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function agreementClientFactory() {
    'use strict';

    // COPIED from the program, never computed at runtime: sha256("global:<instruction>")[..8] and
    // sha256("account:Agreement")[..8], the values the generated IDL lists (idl/agreement.json).
    const IX_DISCRIMINATORS = Object.freeze({
        create: Object.freeze([24, 30, 200, 40, 5, 28, 7, 119]),
        fund: Object.freeze([218, 188, 111, 221, 152, 113, 174, 7]),
        attest: Object.freeze([83, 148, 120, 119, 144, 139, 117, 160]),
        confirm_funding: Object.freeze([30, 31, 203, 65, 164, 189, 67, 48]),
        execute: Object.freeze([130, 221, 242, 154, 13, 193, 189, 29]),
        cancel: Object.freeze([232, 219, 223, 41, 219, 236, 220, 190]),
        expire: Object.freeze([243, 83, 205, 58, 57, 201, 247, 146])
    });

    const ACCOUNT_DISCRIMINATORS = Object.freeze({
        Agreement: Object.freeze([83, 212, 5, 110, 225, 249, 197, 84])
    });

    // The program ids live in program-ids.js (window.SolanaProgramIds, loaded before this file).
    const programIds = globalThis.SolanaProgramIds || (typeof require === 'function' ? require('./program-ids.js') : null);
    if (!programIds) throw new Error('SolanaProgramIds (js/solana/program-ids.js) must load before agreement-client.js');

    const constants = Object.freeze({
        AGREEMENT_PROGRAM_ID: programIds.AGREEMENT_PROGRAM_ID,
        // Earlier agreement programs, newest first: their accounts are another layout and read as unminted here.
        RETIRED_AGREEMENT_PROGRAM_IDS: programIds.RETIRED_AGREEMENT_PROGRAM_IDS,
        SAS_PROGRAM_ID: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
        DEFAULT_PUBKEY: '11111111111111111111111111111111',
        AGREEMENT_SEED: 'agreement',
        MAX_CID_BYTES: 64,
        // Accounts created before create required a deadline may still carry 0 (no deadline); it is
        // only ever read, never sent.
        NO_DEADLINE: 0,
        // The deadline a new agreement gets when its agreement/v1 object names none: 90 days.
        DEFAULT_DEADLINE_SECONDS: 90 * 86_400,
        DECISION_SCHEMA_NAME: 'AgreementDecision',
        DECISION_SCHEMA_VERSION: 1,
        // The SAS schema a member registers once under its own credential, as backend/oracle/lens-schemas.js
        // defines AgreementDecision-v1 (agreement-client.test.js asserts the two agree): its description,
        // field names and SAS layout bytes (String 12, I64 8).
        DECISION_SCHEMA_DESCRIPTION: 'A lens member attests that the decision rule of an agreement is satisfied as of a source time.',
        DECISION_SCHEMA_FIELDS: Object.freeze(['agreementCid', 'sponsor', 'decision', 'evidenceRef', 'sourceObservedAt']),
        DECISION_SCHEMA_LAYOUT: Object.freeze([12, 12, 12, 12, 8]),
        // The credential name every lens member issues under (backend/lens/member.js DEFAULT_CREDENTIAL_NAME).
        LENS_CREDENTIAL_NAME: 'LensMember',
        // How long a member's own decision stays recordable: a year, as the reference member issues them.
        DECISION_EXPIRY_SECONDS: 365 * 24 * 3600,
        // SAS instruction discriminators (sas-lib 1.0.10: createCredential 0, createSchema 1, createAttestation 6).
        SAS_CREATE_CREDENTIAL: 0,
        SAS_CREATE_SCHEMA: 1,
        SAS_CREATE_ATTESTATION: 6,
        SAS_ATTESTATION_DISCRIMINATOR: 2,
        // 8-byte discriminator + Agreement::INIT_SPACE (604).
        AGREEMENT_ACCOUNT_SPACE: 612,
        // Most lens members an agreement names; its threshold is 1..members (0 with none).
        MAX_LENSES: 8,
        // The devnet USDC mint a crowdfunding agreement's contribution target is counted in; the same
        // key as pledge-client.js USDC_DEVNET_MINT (agreement-client.test.js asserts it), restated so
        // reading an agreement does not need the lazily loaded pledge client.
        USDC_DEVNET_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        STATUS_ACTIVE: 0,
        STATUS_EXECUTED: 1,
        STATUS_CANCELLED: 2,
        STATUS_EXPIRED: 3,
        // The lens never refuses: a decision is Pending until the satisfied attestation is recorded.
        DECISION_PENDING: 0,
        DECISION_SATISFIED: 1
    });

    const STATUS_NAMES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired']);
    const DECISION_NAMES = Object.freeze(['Pending', 'Satisfied']);

    // Offsets of the fixed fields, which all precede the trailing cid: memcmp filters for
    // getProgramAccounts (e.g. every agreement a lens settles: { offset: AGREEMENT_OFFSETS.lens, bytes },
    // every agreement of a plan: fetchAgreementsForPlan).
    const AGREEMENT_OFFSETS = Object.freeze({
        authority: 8,
        lens: 40,
        payout: 72,
        deadline: 104,
        status: 136,
        decision: 138,
        lensCount: 228,
        lensThreshold: 229,
        lensConfirmed: 230,
        moreLenses: 231,
        fundingMint: 455,
        requiredFunding: 487,
        planCidHash: 512,
        cid: 544
    });

    let injectedWeb3 = null;
    let injectedSha256Hex = null;
    let api = null;

    // Injected, the browser's vendored build (window.solanaWeb3), then the package.
    function resolveWeb3() {
        if (injectedWeb3) return injectedWeb3;
        if (globalThis.solanaWeb3 && globalThis.solanaWeb3.PublicKey) return globalThis.solanaWeb3;
        let loaded = null;
        if (typeof require === 'function') {
            try { loaded = require('@solana/web3.js'); } catch (_) { loaded = null; }
        }
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
        if (typeof require === 'function') {
            try { nodeCrypto = require('crypto'); } catch (_) { nodeCrypto = null; }
        }
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

    // The program's rule: 1-64 ASCII letters and digits (CIDv1 UnixFS file CIDs with raw leaves
    // and fixed 256 KiB chunks are 59 characters: raw `bafkrei…` for one chunk, dag-pb `bafybei…` for more).
    function requireCid(cid) {
        if (typeof cid !== 'string' || !/^[A-Za-z0-9]+$/.test(cid)) throw new Error('cid must be 1-64 ASCII letters and digits');
        if (cid.length > constants.MAX_CID_BYTES) throw new Error(`cid is ${cid.length} bytes; the program stores at most ${constants.MAX_CID_BYTES}`);
        return cid;
    }

    // The last PDA seed: sha256 over the CID's UTF-8 bytes (the program's cid_seed).
    function cidSeed(cid) {
        return hexToBytes(resolveSha256Hex()(requireCid(cid)));
    }

    // The account's plan_cid_hash for a plan CID: the same sha256 over its UTF-8 bytes, as lowercase hex.
    function planCidHash(planCid) {
        return toHex(cidSeed(planCid));
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

    // The agreement/v1 object's `deadline` (ISO string or null) as create's argument, in unix seconds.
    // The program requires a deadline in the future, so a missing one becomes nowSeconds +
    // DEFAULT_DEADLINE_SECONDS (90 days); nowSeconds is required for that case.
    function toDeadlineSeconds(deadline, nowSeconds) {
        if (deadline === null || deadline === undefined || deadline === '') {
            if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
                throw new Error('nowSeconds (unix seconds) is required to default a missing deadline');
            }
            return nowSeconds + constants.DEFAULT_DEADLINE_SECONDS;
        }
        const ms = Date.parse(deadline);
        if (!Number.isFinite(ms)) throw new Error(`deadline ${JSON.stringify(deadline)} is not a date`);
        return Math.floor(ms / 1000);
    }

    // ---- instruction data -----------------------------------------------------------------------------

    // The program's lens rule: 0-8 distinct real member keys and a threshold of 1..members, or no
    // members (threshold 0) only with a contribution target. Returns the keys in order, else throws.
    function requireLensSet(lenses, threshold, requiredFunding = 0n) {
        if (!Array.isArray(lenses)) throw new Error('lenses must be a list of base58 keys');
        const keys = lenses.map((key, index) => toKey(key, `lenses[${index}]`).toBase58());
        if (keys.length > constants.MAX_LENSES) throw new Error(`a lens has at most ${constants.MAX_LENSES} members`);
        if (keys.some(key => key === constants.DEFAULT_PUBKEY)) throw new Error('a lens member must not be the default key');
        if (new Set(keys).size !== keys.length) throw new Error('a lens names each member once');
        if (!Number.isInteger(threshold)) throw new Error('lensThreshold must be a whole number');
        if (!keys.length) {
            if (!(BigInt(requiredFunding) > 0n)) throw new Error('an agreement without a lens needs a contribution target');
            if (threshold !== 0) throw new Error('an agreement without a lens has threshold 0');
        } else if (threshold < 1 || threshold > keys.length) {
            throw new Error(`lensThreshold must be between 1 and ${keys.length}`);
        }
        return keys;
    }

    // create(cid: String, plan_cid: String, lenses: Vec<Pubkey>, lens_threshold: u8, deadline: i64,
    // open_ground: bool, required_lamports: u64, payout: Pubkey, funding_mint: Pubkey, required_funding: u64).
    // `planCid` is the agreement/v1 object's `planCid` (the program stores its sha256).
    // Mirrors the program's argument checks that need no clock, so a wallet never signs a create the
    // program refuses for its arguments. The deadline is required and positive (NO_DEADLINE is refused);
    // whether it is still in the future is checked by the callers against their clock and finally by the
    // program against the chain's. A contribution target (requiredFunding > 0) needs its fundingMint,
    // and a mint needs a target.
    function encodeCreateData({ cid, planCid, lenses, lensThreshold, deadline, openGround = false, requiredLamports = 0n, payout,
        fundingMint = null, requiredFunding = 0n } = {}) {
        requireCid(cid);
        if (planCid === undefined || planCid === null) throw new Error('planCid (the plan the agreement names) is required');
        requireCid(planCid);
        const funding = BigInt(requiredFunding);
        const keys = requireLensSet(lenses, lensThreshold ?? (Array.isArray(lenses) && lenses.length ? 1 : 0), funding);
        const threshold = lensThreshold ?? (keys.length ? 1 : 0);
        const mint = fundingMint ? toKey(fundingMint, 'fundingMint').toBase58() : constants.DEFAULT_PUBKEY;
        if ((funding > 0n) !== (mint !== constants.DEFAULT_PUBKEY)) throw new Error('a contribution target needs its mint, and a mint needs a target');
        if (toKey(payout, 'payout').toBase58() === constants.DEFAULT_PUBKEY) throw new Error('payout must not be the default key');
        if (!(typeof deadline === 'bigint' ? deadline > 0n : Number.isSafeInteger(deadline) && deadline > 0)) {
            throw new Error('deadline must be unix seconds in the future');
        }
        return concat([
            disc('create'),
            encodeString(cid),
            encodeString(planCid),
            u32(keys.length),
            ...keys.map((key, index) => encodePubkey(key, `lenses[${index}]`)),
            Uint8Array.of(threshold),
            i64(deadline, 'deadline'),
            encodeBool(openGround, 'openGround'),
            u64(requiredLamports, 'requiredLamports'),
            encodePubkey(payout, 'payout'),
            encodePubkey(mint, 'fundingMint'),
            u64(funding, 'requiredFunding')
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
    const encodeConfirmFundingData = () => disc('confirm_funding');
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

    // Accounts: agreement (mut), escrow (its proposal_pledge donation escrow), vault (the escrow's token
    // vault). Anyone may send it: the program checks credited contributions against the target itself.
    function buildConfirmFundingIx({ agreement, cid, authority, escrow, vault, programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
        return instruction(programId, [
            meta(agreementKey({ agreement, cid, authority, programId }), false, true),
            meta(toKey(escrow, 'escrow'), false, false),
            meta(toKey(vault, 'vault'), false, false)
        ], encodeConfirmFundingData());
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
            u32(label) { need(4, label); const value = view.getUint32(offset, true); offset += 4; return value; },
            position() { return offset; },
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
        // An account of an earlier layout (a retired program's) ends before the CID's offset: it is not
        // readable as one, and its agreement must be recreated.
        if (bytes.length < AGREEMENT_OFFSETS.cid + 4) {
            throw new RangeError(`agreement account${address ? ` ${address}` : ''} is ${bytes.length} bytes, shorter than the plan-CID layout: recreate the agreement`);
        }
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
        const lensCount = r.u8('lens_count');
        const lensThreshold = r.u8('lens_threshold');
        const lensConfirmedBits = r.u8('lens_confirmed');
        const moreLenses = Array.from({ length: constants.MAX_LENSES - 1 }, (_, index) => r.pubkey(`more_lenses[${index}]`));
        const fundingMint = r.pubkey('funding_mint');
        const requiredFunding = r.u64('required_funding');
        const fundingMet = r.bool('funding_met');
        const fundingObserved = r.u64('funding_observed');
        const fundingMetAt = r.i64('funding_met_at');
        const planHash = r.bytes(32, 'plan_cid_hash');
        const cid = r.string('cid');
        if (lensCount > constants.MAX_LENSES) throw new RangeError(`lens_count ${lensCount} exceeds ${constants.MAX_LENSES}`);
        const lenses = [lens, ...moreLenses].slice(0, lensCount);
        const pending = decisionCode === constants.DECISION_PENDING;
        return {
            address,
            cid,
            // sha256 hex of the plan CID the sponsor named at create: its claim, to check against the
            // agreement object's planCid (planCidHash) before relying on it.
            planCidHash: toHex(planHash),
            authority,
            lens,
            lenses,
            lensThreshold,
            lensConfirmed: lenses.filter((_, index) => lensConfirmedBits & (1 << index)),
            fundingMint: requiredFunding > 0n ? fundingMint : null,
            requiredFunding,
            fundingMet,
            fundingObserved,
            fundingMetAt,
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

    // ---- the lens's AgreementDecision-v1 attestation --------------------------------------------------

    // A SAS attestation account: discriminator 2 | nonce 32 | credential 32 | schema 32 | data (u32 +
    // bytes) | signer 32 | expiry i64 | token_account 32, its data the AgreementDecision-v1 payload
    // (README, "AgreementDecision-v1"), consumed exactly as the program consumes it. Throws when the
    // bytes are not such an attestation.
    function readDecisionAttestation(data, address = null) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!bytes.length || bytes[0] !== constants.SAS_ATTESTATION_DISCRIMINATOR) throw new Error('account is not a SAS attestation');
        const r = reader(bytes, 1);
        const nonce = r.pubkey('nonce');
        const credential = r.pubkey('credential');
        const schema = r.pubkey('schema');
        const payload = r.bytes(r.u32('data length'), 'data');
        const signer = r.pubkey('signer');
        const expiry = r.i64('expiry');
        const p = reader(payload, 0);
        const fields = {
            agreementCid: p.string('agreementCid'),
            sponsor: p.string('sponsor'),
            decision: p.string('decision'),
            evidenceRef: p.string('evidenceRef'),
            sourceObservedAt: p.i64('sourceObservedAt')
        };
        if (p.position() !== payload.length) throw new RangeError(`AgreementDecision payload has ${payload.length - p.position()} trailing bytes`);
        return { address, nonce, credential, schema, signer, expiry, fields };
    }

    // The program's Agreement::deadline_passed: a deadline is set and the chain time is after it (a
    // legacy account's NO_DEADLINE never passes).
    function deadlinePassed(agreement, nowSeconds) {
        return !!agreement && agreement.deadline !== constants.NO_DEADLINE && nowSeconds > agreement.deadline;
    }

    // The schema an AgreementDecision issued under `credential` must name: ["schema", credential,
    // "AgreementDecision", [1]] under SAS (the program recomputes it the same way).
    function getDecisionSchemaPda(credential) {
        const { PublicKey } = resolveWeb3();
        return PublicKey.findProgramAddressSync(
            [utf8('schema'), toKey(credential, 'credential').toBytes(), utf8(constants.DECISION_SCHEMA_NAME), Uint8Array.of(constants.DECISION_SCHEMA_VERSION)],
            toKey(constants.SAS_PROGRAM_ID, 'SAS program')
        );
    }

    // ---- a member's own AgreementDecision-v1 (a lens key held in a person's wallet) ---------------------
    // A lens member that is a wallet, such as a city authority's key, issues its decision itself: the
    // same SAS credential, schema and attestation the reference member's service creates
    // (backend/lens/member.js, register-lens-schemas.mjs), built here so the wallet signs them in the
    // transaction that also records the decision. Byte-exact with sas-lib (agreement-client.test.js).

    function sasPda(seeds) {
        const { PublicKey } = resolveWeb3();
        return PublicKey.findProgramAddressSync(seeds, toKey(constants.SAS_PROGRAM_ID, 'SAS program'))[0];
    }
    function nameSeed(name) {
        const bytes = utf8(name);
        if (!bytes.length || bytes.length > 32) throw new Error('SAS names must be 1-32 bytes');
        return bytes;
    }
    // ["credential", authority, name] under SAS.
    function getLensCredentialPda(authority, name = constants.LENS_CREDENTIAL_NAME) {
        return sasPda([utf8('credential'), toKey(authority, 'authority').toBytes(), nameSeed(name)]);
    }
    // ["attestation", credential, schema, nonce] under SAS.
    function getAttestationPda({ credential, schema, nonce }) {
        return sasPda([utf8('attestation'), toKey(credential, 'credential').toBytes(), toKey(schema, 'schema').toBytes(), toKey(nonce, 'nonce').toBytes()]);
    }
    // The member's deterministic nonce for one decision (backend/lens/member.js factNonce): the key whose
    // bytes are sha256 of the parts joined with "|", so a retry lands on the attestation already issued.
    function decisionNonce({ agreementCid, sponsor, decision, sourceObservedAt }) {
        const { PublicKey } = resolveWeb3();
        const id = `${constants.DECISION_SCHEMA_NAME}-v${constants.DECISION_SCHEMA_VERSION}`;
        return new PublicKey(hexToBytes(resolveSha256Hex()([id, agreementCid, sponsor, decision, sourceObservedAt].join('|'))));
    }
    // AgreementDecision-v1 payload: four borsh strings and an i64, as the program parses it.
    function encodeDecisionPayload({ agreementCid, sponsor, decision, evidenceRef, sourceObservedAt }) {
        requireCid(agreementCid);
        toKey(sponsor, 'sponsor');
        if (decision !== 'satisfied') throw new Error('decision must be "satisfied"');
        if (typeof evidenceRef !== 'string' || !evidenceRef.trim()) throw new Error('evidenceRef must be text');
        if (!Number.isSafeInteger(sourceObservedAt)) throw new Error('sourceObservedAt must be whole Unix seconds');
        return concat([encodeString(agreementCid), encodeString(sponsor), encodeString(decision), encodeString(evidenceRef), i64(sourceObservedAt, 'sourceObservedAt')]);
    }
    const sasMeta = meta;
    const systemKey = () => toKey(constants.SYSTEM_PROGRAM_ID, 'system program');
    // createCredential(name, signers [authority]). Accounts: payer (signer, mut), credential (mut),
    // authority (signer), system program.
    function buildCreateLensCredentialIx({ payer, authority, name = constants.LENS_CREDENTIAL_NAME }) {
        const credential = getLensCredentialPda(authority, name);
        const data = concat([Uint8Array.of(constants.SAS_CREATE_CREDENTIAL), encodeString(name), u32(1), encodePubkey(authority, 'authority')]);
        return instruction(constants.SAS_PROGRAM_ID, [
            sasMeta(toKey(payer, 'payer'), true, true), sasMeta(credential, false, true),
            sasMeta(toKey(authority, 'authority'), true, false), sasMeta(systemKey(), false, false)
        ], data);
    }
    // createSchema(AgreementDecision v1). Accounts: payer (signer, mut), authority (signer), credential,
    // schema (mut), system program.
    function buildCreateDecisionSchemaIx({ payer, authority, credential }) {
        const schema = getDecisionSchemaPda(credential)[0];
        const data = concat([
            Uint8Array.of(constants.SAS_CREATE_SCHEMA),
            encodeString(constants.DECISION_SCHEMA_NAME),
            encodeString(constants.DECISION_SCHEMA_DESCRIPTION),
            u32(constants.DECISION_SCHEMA_LAYOUT.length), Uint8Array.from(constants.DECISION_SCHEMA_LAYOUT),
            u32(constants.DECISION_SCHEMA_FIELDS.length), ...constants.DECISION_SCHEMA_FIELDS.map(encodeString)
        ]);
        return instruction(constants.SAS_PROGRAM_ID, [
            sasMeta(toKey(payer, 'payer'), true, true), sasMeta(toKey(authority, 'authority'), true, false),
            sasMeta(toKey(credential, 'credential'), false, false), sasMeta(schema, false, true), sasMeta(systemKey(), false, false)
        ], data);
    }
    // createAttestation(nonce, data, expiry). Accounts: payer (signer, mut), authority (signer),
    // credential, schema, attestation (mut), system program. Returns the instruction and the attestation.
    function buildCreateDecisionAttestationIx({ payer, authority, fields, expiry }) {
        const credential = getLensCredentialPda(authority);
        const schema = getDecisionSchemaPda(credential)[0];
        const nonce = decisionNonce(fields);
        const attestation = getAttestationPda({ credential, schema, nonce });
        if (!Number.isSafeInteger(expiry)) throw new Error('expiry must be whole Unix seconds');
        const payload = encodeDecisionPayload(fields);
        const data = concat([Uint8Array.of(constants.SAS_CREATE_ATTESTATION), encodePubkey(nonce, 'nonce'), u32(payload.length), payload, i64(expiry, 'expiry')]);
        return {
            instruction: instruction(constants.SAS_PROGRAM_ID, [
                sasMeta(toKey(payer, 'payer'), true, true), sasMeta(toKey(authority, 'authority'), true, false),
                sasMeta(credential, false, false), sasMeta(schema, false, false), sasMeta(attestation, false, true), sasMeta(systemKey(), false, false)
            ], data),
            attestation: attestation.toBase58(),
            credential: credential.toBase58(),
            schema: schema.toBase58()
        };
    }

    // The program's attest checks that the two accounts alone can answer (the credential's authority
    // is the chain's to check), so a wallet is never asked to sign an attest the program refuses for
    // them. `agreement` is readAgreement's value. null when it would pass, else the reason.
    function checkDecisionForAttest({ agreement, attestation, nowSeconds } = {}) {
        const now = Number.isSafeInteger(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
        if (!agreement) return 'agreement-missing';
        if (agreement.statusCode !== constants.STATUS_ACTIVE) return 'not-active';
        if (agreement.decisionCode !== constants.DECISION_PENDING) return 'decision-recorded';
        if (deadlinePassed(agreement, now)) return 'deadline-passed';
        if (!attestation) return 'attestation-missing';
        if (!(attestation.expiry > now)) return 'attestation-expired';
        if (attestation.schema !== getDecisionSchemaPda(attestation.credential)[0].toBase58()) return 'wrong-schema';
        if (!agreement.lenses.includes(attestation.signer)) return 'wrong-lens';
        if (agreement.lensConfirmed.includes(attestation.signer)) return 'member-confirmed';
        if (agreement.lensConfirmed.length >= agreement.lensThreshold) return 'lens-confirmed';
        if (attestation.fields.agreementCid !== agreement.cid) return 'wrong-cid';
        if (attestation.fields.sponsor !== agreement.authority) return 'wrong-sponsor';
        if (attestation.fields.decision !== 'satisfied') return 'unknown-decision';
        if (attestation.fields.sourceObservedAt > now) return 'observed-in-future';
        return null;
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
            throw Object.assign(new Error(`account ${key.toBase58()} belongs to another program`), { code: 'agreement-wrong-program' });
        }
        const value = readAgreement(new Uint8Array(info.data), key.toBase58());
        if (!value) throw new Error(`account ${key.toBase58()} does not have the Agreement discriminator`);
        if (cid && value.cid !== cid) throw new Error(`agreement ${key.toBase58()} stores CID ${value.cid}, not ${cid}`);
        if (authority && value.authority !== toKey(authority, 'authority').toBase58()) {
            throw new Error(`agreement ${key.toBase58()} belongs to ${value.authority}, not ${toKey(authority, 'authority').toBase58()}`);
        }
        return value;
    }

    // The getProgramAccounts filters for every agreement whose sponsor named `planCid` at create: the
    // account size, and sha256(planCid) at AGREEMENT_OFFSETS.planCidHash (a 32-byte value, so its
    // base58 is a public key's).
    function planFilters(planCid) {
        const { PublicKey } = resolveWeb3();
        return [
            { dataSize: constants.AGREEMENT_ACCOUNT_SPACE },
            { memcmp: { offset: AGREEMENT_OFFSETS.planCidHash, bytes: new PublicKey(cidSeed(planCid)).toBase58() } }
        ];
    }

    // Every agreement account naming `planCid`, read straight from the chain (no server), oldest first.
    // The plan hash is the sponsor's claim: a reader that relies on it compares it with the agreement
    // object's own planCid on IPFS. Needs an RPC that serves getProgramAccounts (Alchemy's free tier
    // refuses it).
    async function fetchAgreementsForPlan(connection, planCid, { programId = constants.AGREEMENT_PROGRAM_ID } = {}) {
        const rows = await connection.getProgramAccounts(toKey(programId, 'programId'), { commitment: 'confirmed', filters: planFilters(planCid) });
        const hash = planCidHash(planCid);
        return rows
            .map(row => readAgreement(new Uint8Array(row.account.data), toKey(row.pubkey, 'pubkey').toBase58()))
            .filter(value => value && value.planCidHash === hash)
            .sort((a, b) => a.createdAt - b.createdAt || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    }

    // The lens's AgreementDecision-v1 attestation at `address`, checked to be a SAS account. null when
    // the account is absent.
    async function fetchDecisionAttestation(connection, address) {
        const key = toKey(address, 'attestation');
        const info = await connection.getAccountInfo(key, 'confirmed');
        if (!info || !info.data) return null;
        if (!toKey(info.owner, 'owner').equals(toKey(constants.SAS_PROGRAM_ID, 'SAS program'))) {
            throw new Error(`account ${key.toBase58()} is not a SAS attestation`);
        }
        return readDecisionAttestation(new Uint8Array(info.data), key.toBase58());
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
        planCidHash,
        planFilters,
        getAgreementPda,
        toDeadlineSeconds,
        encodeCreateData,
        encodeFundData,
        encodeAttestData,
        encodeConfirmFundingData,
        requireLensSet,
        encodeExecuteData,
        encodeCancelData,
        encodeExpireData,
        buildCreateIx,
        buildFundIx,
        buildAttestIx,
        buildConfirmFundingIx,
        buildExecuteIx,
        buildCancelIx,
        buildExpireIx,
        readAgreement,
        readDecisionAttestation,
        deadlinePassed,
        getDecisionSchemaPda,
        getLensCredentialPda,
        getAttestationPda,
        decisionNonce,
        encodeDecisionPayload,
        buildCreateLensCredentialIx,
        buildCreateDecisionSchemaIx,
        buildCreateDecisionAttestationIx,
        checkDecisionForAttest,
        fetchAgreement,
        fetchAgreementsForPlan,
        fetchDecisionAttestation
    };

    return api;
});
