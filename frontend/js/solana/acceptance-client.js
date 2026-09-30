// Pure client codec for the lens-model v2 instructions of proposal_nft and parcel_nft
// (blockchain/solana/idl/*.json): PDA derivation, byte-exact Anchor/borsh instruction encoding for
// mint_and_fund, mint_parcel, accept_with_attestations, settle_with_verdict and distribute_funds,
// and decoders for Proposal (v2, incl. verdict_may_execute), ConsentTally, AcceptanceRecord, VerdictRecord and SAS
// lens attestations. No DOM and no wallet; the fetch* helpers take a connection and only read.
(function attachSolanaAcceptanceClient(root, factory) {
    const core = (root && root.LensCore) || (typeof require === 'function' ? require('../lens-core.js') : null);
    const api = factory(core);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaAcceptanceClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function solanaAcceptanceClientFactory(LensCore) {
    'use strict';

    // COPIED from the IDLs, never computed at runtime (the browser has no synchronous sha256); the
    // unit test pins each against sha256("global:<name>") / sha256("account:<Name>") and the IDL.
    const IX_DISCRIMINATORS = Object.freeze({
        mint_and_fund: Object.freeze([255, 122, 242, 119, 64, 81, 64, 208]),
        accept_with_attestations: Object.freeze([89, 240, 102, 93, 168, 200, 164, 125]),
        settle_with_verdict: Object.freeze([167, 16, 204, 105, 225, 93, 188, 202]),
        distribute_funds: Object.freeze([124, 82, 187, 45, 224, 209, 31, 156]),
        mint_parcel: Object.freeze([158, 42, 246, 137, 217, 57, 167, 210])
    });

    const ACCOUNT_DISCRIMINATORS = Object.freeze({
        Proposal: Object.freeze([26, 94, 189, 187, 116, 136, 53, 33]),
        ProposalCounter: Object.freeze([110, 92, 147, 182, 142, 28, 182, 5]),
        ConsentTally: Object.freeze([200, 21, 66, 56, 62, 148, 43, 226]),
        AcceptanceRecord: Object.freeze([8, 191, 82, 210, 167, 58, 12, 34]),
        VerdictRecord: Object.freeze([5, 210, 137, 12, 43, 13, 62, 182])
    });

    const constants = Object.freeze({
        PROPOSAL_NFT_PROGRAM_ID: '3WsVS6LkLo4ySLaLvxKdwuD37fcCjE2Yu9fVh1nMfxbg',
        PARCEL_NFT_PROGRAM_ID: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
        SAS_PROGRAM_ID: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
        DEFAULT_PUBKEY: '11111111111111111111111111111111',
        SAS_ATTESTATION_DISCRIMINATOR: 2,
        STATUS_ACTIVE: 0,
        STATUS_EXECUTED: 1,
        STATUS_CANCELLED: 2,
        STATUS_EXPIRED: 3
    });

    const STATUS_NAMES = Object.freeze(['Active', 'Executed', 'Cancelled', 'Expired']);
    const MAX_SEED_BYTES = 32;

    let injectedWeb3 = null;

    // Same resolution order as market-client.js: injected, the browser's vendored build, the package.
    function resolveWeb3() {
        if (injectedWeb3) return injectedWeb3;
        const scope = typeof globalThis !== 'undefined' ? globalThis : null;
        if (scope && scope.solanaWeb3 && scope.solanaWeb3.PublicKey) return scope.solanaWeb3;
        if (typeof require === 'function') {
            let loaded = null;
            try { loaded = require('@solana/web3.js'); } catch (_) { loaded = null; }
            if (loaded && loaded.PublicKey) return loaded;
        }
        throw new Error('solana-web3 is not available: pass one to SolanaAcceptanceClient.configure({ web3 }) or load the vendored solanaWeb3 build');
    }

    function configure(options) {
        const opts = options || {};
        if (Object.prototype.hasOwnProperty.call(opts, 'web3')) injectedWeb3 = opts.web3 || null;
        return api;
    }

    function toKey(value, label) {
        const { PublicKey } = resolveWeb3();
        if (value instanceof PublicKey) return value;
        if (value && typeof value.toBase58 === 'function') return new PublicKey(value.toBase58());
        if (typeof value !== 'string' || !LensCore.isBase58Pubkey(value.trim())) {
            throw new Error(`${label} must be a base58 public key`);
        }
        return new PublicKey(value.trim());
    }

    // ---- borsh encoders -------------------------------------------------------------------------

    function concat(parts) {
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const out = new Uint8Array(total);
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

    function u64(value) {
        const big = typeof value === 'bigint' ? value : BigInt(value);
        if (big < 0n || big >= (1n << 64n)) throw new Error('u64 out of range');
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigUint64(0, big, true);
        return out;
    }

    function encodeString(value) {
        if (typeof value !== 'string') throw new Error('borsh string expected');
        const bytes = new TextEncoder().encode(value);
        return concat([u32(bytes.length), bytes]);
    }

    function encodeBool(value) {
        if (typeof value !== 'boolean') throw new Error('borsh bool expected');
        return Uint8Array.of(value ? 1 : 0);
    }

    function encodePubkey(value, label) {
        return Uint8Array.from(toKey(value, label).toBytes());
    }

    // Option<Pubkey>: 0 for None, 1 followed by the 32 key bytes for Some.
    function encodeOptionPubkey(value, label) {
        if (value === null || value === undefined || value === '') return Uint8Array.of(0);
        return concat([Uint8Array.of(1), encodePubkey(value, label)]);
    }

    // A PDA seed is at most 32 bytes; parcel ids are seeds of the parcel, tally and record PDAs.
    function seedBytes(text, label) {
        const bytes = new TextEncoder().encode(String(text));
        if (!bytes.length || bytes.length > MAX_SEED_BYTES) throw new Error(`${label} must be 1-${MAX_SEED_BYTES} bytes to be a PDA seed`);
        return bytes;
    }

    function disc(name) {
        return Uint8Array.from(IX_DISCRIMINATORS[name]);
    }

    // mint_and_fund(parcel_ids: Vec<String>, is_conditional: bool, image_uri: String,
    //               sol_amount: u64, lens: Vec<Pubkey>, verdict_may_execute: bool)
    function encodeMintAndFundData({ parcelIds, isConditional = false, imageUri = '', solLamports = 0n, lens, verdictMayExecute = false } = {}) {
        if (!Array.isArray(parcelIds) || !parcelIds.length) throw new Error('parcelIds must be a non-empty array');
        if (!Array.isArray(lens) || !lens.length) throw new Error('lens must name at least one key');
        return concat([
            disc('mint_and_fund'),
            u32(parcelIds.length), ...parcelIds.map(id => encodeString(String(id))),
            encodeBool(isConditional),
            encodeString(imageUri),
            u64(solLamports),
            u32(lens.length), ...lens.map((key, index) => encodePubkey(key, `lens[${index}]`)),
            encodeBool(verdictMayExecute)
        ]);
    }

    // mint_parcel(parcel_id: String, metadata_uri: String)
    function encodeMintParcelData(parcelId, metadataUri) {
        return concat([disc('mint_parcel'), encodeString(String(parcelId)), encodeString(String(metadataUri))]);
    }

    // accept_with_attestations(parcel_id: String, payout: Option<Pubkey>)
    function encodeAcceptWithAttestationsData(parcelId, payout) {
        return concat([disc('accept_with_attestations'), encodeString(String(parcelId)), encodeOptionPubkey(payout, 'payout')]);
    }

    // settle_with_verdict() and distribute_funds() take no arguments.
    function encodeSettleWithVerdictData() {
        return disc('settle_with_verdict');
    }

    function encodeDistributeFundsData() {
        return disc('distribute_funds');
    }

    // ---- PDAs -----------------------------------------------------------------------------------

    function pda(seeds, programId) {
        const { PublicKey } = resolveWeb3();
        return PublicKey.findProgramAddressSync(seeds, toKey(programId, 'programId'));
    }

    const utf8 = text => new TextEncoder().encode(text);

    function getProposalCounterPda(programId = constants.PROPOSAL_NFT_PROGRAM_ID) {
        return pda([utf8('proposal_counter')], programId);
    }

    function getProposalPda(count, programId = constants.PROPOSAL_NFT_PROGRAM_ID) {
        return pda([utf8('proposal'), u64(count)], programId);
    }

    function getParcelPda(parcelId, programId = constants.PARCEL_NFT_PROGRAM_ID) {
        return pda([utf8('parcel'), seedBytes(parcelId, 'parcelId')], programId);
    }

    // ["consent", proposal, parcel_id] under proposal_nft.
    function getConsentTallyPda(proposal, parcelId, programId = constants.PROPOSAL_NFT_PROGRAM_ID) {
        return pda([utf8('consent'), toKey(proposal, 'proposal').toBytes(), seedBytes(parcelId, 'parcelId')], programId);
    }

    // ["acceptance", proposal, parcel_id, owner] under proposal_nft.
    function getAcceptanceRecordPda(proposal, parcelId, owner, programId = constants.PROPOSAL_NFT_PROGRAM_ID) {
        return pda([utf8('acceptance'), toKey(proposal, 'proposal').toBytes(), seedBytes(parcelId, 'parcelId'), toKey(owner, 'owner').toBytes()], programId);
    }

    // One per settled verdict: ["verdict", proposal, verdict_attestation]. `init` on-chain, so a
    // replayed attestation fails before the handler runs.
    function getVerdictRecordPda(proposal, verdictAttestation, programId = constants.PROPOSAL_NFT_PROGRAM_ID) {
        return pda([utf8('verdict'), toKey(proposal, 'proposal').toBytes(), toKey(verdictAttestation, 'verdictAttestation').toBytes()], programId);
    }

    // sas-lib 1.0.10 / backend/oracle/lens-schemas.js: PDA(["credential", authority, name]) under SAS.
    function deriveCredentialPda(authority, name) {
        return pda([utf8('credential'), toKey(authority, 'authority').toBytes(), seedBytes(name, 'credential name')], constants.SAS_PROGRAM_ID)[0];
    }

    // PDA(["schema", credential, name, u8 version]) under SAS.
    function deriveSchemaPda(credential, name, version) {
        if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error('schema version must be 1-255');
        return pda([utf8('schema'), toKey(credential, 'credential').toBytes(), seedBytes(name, 'schema name'), Uint8Array.of(version)], constants.SAS_PROGRAM_ID)[0];
    }

    // ---- instruction builders -------------------------------------------------------------------

    function meta(pubkey, isSigner, isWritable) {
        return { pubkey, isSigner, isWritable };
    }

    function instruction(programId, keys, data) {
        const { TransactionInstruction } = resolveWeb3();
        return new TransactionInstruction({ programId: toKey(programId, 'programId'), keys, data: typeof Buffer === 'function' ? Buffer.from(data) : data });
    }

    // Accounts: proposal (mut), proposal_counter (mut), owner (signer, mut), system_program.
    function buildMintAndFundIx({ owner, proposalCount, programId = constants.PROPOSAL_NFT_PROGRAM_ID, ...args } = {}) {
        const [proposal] = getProposalPda(proposalCount, programId);
        const [counter] = getProposalCounterPda(programId);
        return {
            proposal,
            instruction: instruction(programId, [
                meta(proposal, false, true),
                meta(counter, false, true),
                meta(toKey(owner, 'owner'), true, true),
                meta(toKey(constants.SYSTEM_PROGRAM_ID, 'system'), false, false)
            ], encodeMintAndFundData(args))
        };
    }

    // v2 ownerless anchor. Accounts: parcel (mut, PDA), payer (signer, mut), system_program.
    function buildMintParcelIx({ parcelId, metadataUri, payer, programId = constants.PARCEL_NFT_PROGRAM_ID } = {}) {
        const [parcel] = getParcelPda(parcelId, programId);
        return {
            parcel,
            instruction: instruction(programId, [
                meta(parcel, false, true),
                meta(toKey(payer, 'payer'), true, true),
                meta(toKey(constants.SYSTEM_PROGRAM_ID, 'system'), false, false)
            ], encodeMintParcelData(parcelId, metadataUri))
        };
    }

    // Accounts, in IDL order: proposal (mut), parcel, ownership, ownership_credential, tally (mut),
    // record (mut), owner (signer), payer (signer, mut), system_program.
    function buildAcceptWithAttestationsIx({ proposal, parcelId, ownership, ownershipCredential, owner, payer, payout = null,
        programId = constants.PROPOSAL_NFT_PROGRAM_ID, parcelProgramId = constants.PARCEL_NFT_PROGRAM_ID } = {}) {
        if (typeof parcelId !== 'string' || !parcelId) throw new Error('parcelId is required');
        const proposalKey = toKey(proposal, 'proposal');
        const ownerKey = toKey(owner, 'owner');
        const [parcel] = getParcelPda(parcelId, parcelProgramId);
        const [tally] = getConsentTallyPda(proposalKey, parcelId, programId);
        const [record] = getAcceptanceRecordPda(proposalKey, parcelId, ownerKey, programId);
        return {
            tally,
            record,
            parcel,
            instruction: instruction(programId, [
                meta(proposalKey, false, true),
                meta(parcel, false, false),
                meta(toKey(ownership, 'ownership'), false, false),
                meta(toKey(ownershipCredential, 'ownershipCredential'), false, false),
                meta(tally, false, true),
                meta(record, false, true),
                meta(ownerKey, true, false),
                meta(toKey(payer || owner, 'payer'), true, true),
                meta(toKey(constants.SYSTEM_PROGRAM_ID, 'system'), false, false)
            ], encodeAcceptWithAttestationsData(parcelId, payout))
        };
    }

    // Accounts, in IDL order: proposal (mut), verdict, verdict_credential, verdict_record (mut, PDA),
    // submitter (signer, mut: pays the record's rent), system_program. Permissionless. Returns the
    // instruction; the record address is getVerdictRecordPda(proposal, verdict).
    function buildSettleWithVerdictIx({ proposal, verdict, verdictCredential, submitter, programId = constants.PROPOSAL_NFT_PROGRAM_ID } = {}) {
        const proposalKey = toKey(proposal, 'proposal');
        const verdictKey = toKey(verdict, 'verdict');
        const [verdictRecord] = getVerdictRecordPda(proposalKey, verdictKey, programId);
        return instruction(programId, [
            meta(proposalKey, false, true),
            meta(verdictKey, false, false),
            meta(toKey(verdictCredential, 'verdictCredential'), false, false),
            meta(verdictRecord, false, true),
            meta(toKey(submitter, 'submitter'), true, true),
            meta(toKey(constants.SYSTEM_PROGRAM_ID, 'system'), false, false)
        ], encodeSettleWithVerdictData());
    }

    // Remaining accounts per accepted parcel, in accepted_parcels order: its tally, then
    // tally.accepted pairs of (record, recipient = record.payout, or the proposal owner when none).
    // With no accepted parcels the only remaining account is the proposal owner.
    function planDistribution({ proposal, tallies, records }) {
        if (!proposal) throw new Error('proposal is required');
        const accepted = proposal.acceptedParcels || [];
        if (!accepted.length) return [{ pubkey: proposal.owner, role: 'owner', isWritable: true }];
        const out = [];
        for (const parcelId of accepted) {
            const tally = (tallies || []).find(entry => entry && entry.parcelId === parcelId);
            if (!tally) throw new Error(`tally missing for accepted parcel ${parcelId}`);
            const own = (records || []).filter(entry => entry && entry.parcelId === parcelId)
                .sort((a, b) => (a.acceptedAt - b.acceptedAt) || String(a.address).localeCompare(String(b.address)));
            if (own.length !== tally.accepted) throw new Error(`parcel ${parcelId}: ${own.length} acceptance records found, tally says ${tally.accepted}`);
            out.push({ pubkey: tally.address, role: 'tally', isWritable: false });
            for (const record of own) {
                out.push({ pubkey: record.address, role: 'record', isWritable: false });
                out.push({ pubkey: record.payout || proposal.owner, role: 'recipient', isWritable: true });
            }
        }
        return out;
    }

    function buildDistributeFundsIx({ proposal, remaining, programId = constants.PROPOSAL_NFT_PROGRAM_ID } = {}) {
        return instruction(programId, [
            meta(toKey(proposal, 'proposal'), false, true),
            ...(remaining || []).map(entry => meta(toKey(entry.pubkey, entry.role || 'remaining'), false, entry.isWritable === true))
        ], encodeDistributeFundsData());
    }

    // ---- decoders -------------------------------------------------------------------------------
    // Truncation throws; a wrong discriminator returns null (it is some other account).

    function reader(bytes, start) {
        const body = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        let offset = start;
        const need = (count, label) => {
            if (offset + count > body.length) throw new RangeError(`account truncated reading ${label} at byte ${offset}`);
        };
        return {
            body,
            get offset() { return offset; },
            u8(label) { need(1, label); return body[offset++]; },
            bool(label) { need(1, label); const value = body[offset++]; if (value > 1) throw new RangeError(`${label} is not a bool`); return value === 1; },
            u32(label) { need(4, label); const value = view.getUint32(offset, true); offset += 4; return value; },
            u64(label) { need(8, label); const value = view.getBigUint64(offset, true); offset += 8; return value; },
            i64(label) { need(8, label); const value = view.getBigInt64(offset, true); offset += 8; return value; },
            bytes(count, label) { need(count, label); const out = body.slice(offset, offset + count); offset += count; return out; },
            pubkey(label) { return LensCore.base58Encode(this.bytes(32, label)); },
            string(label) {
                const length = this.u32(label);
                return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(length, label));
            },
            vecString(label) {
                const length = this.u32(label);
                if (length > body.length) throw new RangeError(`${label} length ${length} is absurd`);
                return Array.from({ length }, (_, index) => this.string(`${label}[${index}]`));
            },
            vecPubkey(label) {
                const length = this.u32(label);
                if (offset + length * 32 > body.length) throw new RangeError(`${label} of ${length} keys does not fit`);
                return Array.from({ length }, (_, index) => this.pubkey(`${label}[${index}]`));
            }
        };
    }

    function hasDiscriminator(bytes, expected) {
        if (!bytes || bytes.length < 8) return false;
        for (let i = 0; i < 8; i++) if (bytes[i] !== expected[i]) return false;
        return true;
    }

    function safeNumber(big, label) {
        if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`${label} exceeds the safe integer range`);
        return Number(big);
    }

    // The whole v2 Proposal, including `verdict_may_execute` after `bump`. v1-era accounts carry a
    // zero byte there (the fixed 4096-byte account was zero-initialised), which reads as false.
    function readProposalV2(data, address = null) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!hasDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.Proposal)) return null;
        const r = reader(bytes, 8);
        const proposalId = r.u64('proposal_id');
        const owner = r.pubkey('owner');
        const parcelIds = r.vecString('parcel_ids');
        const isConditional = r.bool('is_conditional');
        const imageUri = r.string('image_uri');
        const acceptancePossible = r.bool('acceptance_possible');
        const statusCode = r.u8('status');
        const solBalance = r.u64('sol_balance');
        const tokenBalance = r.u64('token_balance');
        const acceptanceCount = r.u64('acceptance_count');
        const acceptedParcels = r.vecString('accepted_parcels');
        const lens = r.vecPubkey('lens');
        const bump = r.u8('bump');
        const verdictMayExecute = r.bool('verdict_may_execute');
        return {
            address,
            proposalId: proposalId.toString(),
            owner,
            parcelIds,
            isConditional,
            imageUri,
            acceptancePossible,
            statusCode,
            status: STATUS_NAMES[statusCode] || 'Unknown',
            solBalance,
            tokenBalance,
            acceptanceCount,
            acceptedParcels,
            lens,
            bump,
            verdictMayExecute
        };
    }

    function readConsentTally(data, address = null) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!hasDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.ConsentTally)) return null;
        const r = reader(bytes, 8);
        return {
            address,
            proposal: r.pubkey('proposal'),
            parcelId: r.string('parcel_id'),
            member: r.pubkey('member'),
            required: r.u8('required'),
            accepted: r.u8('accepted'),
            bump: r.u8('bump')
        };
    }

    function readAcceptanceRecord(data, address = null) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!hasDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.AcceptanceRecord)) return null;
        const r = reader(bytes, 8);
        const record = {
            address,
            proposal: r.pubkey('proposal'),
            parcelId: r.string('parcel_id'),
            owner: r.pubkey('owner'),
            member: r.pubkey('member'),
            ownershipAttestation: r.pubkey('ownership_attestation'),
            ownershipHash: Array.from(r.bytes(32, 'ownership_hash'), byte => byte.toString(16).padStart(2, '0')).join(''),
            payout: r.pubkey('payout'),
            acceptedAt: safeNumber(r.i64('accepted_at'), 'accepted_at'),
            bump: r.u8('bump')
        };
        // The program stores the default key when no payout was given; expose that as null.
        if (record.payout === constants.DEFAULT_PUBKEY) record.payout = null;
        return record;
    }

    // verdict is the status the settlement set: 1 Executed, 3 Expired.
    function readVerdictRecord(data, address = null) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!hasDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.VerdictRecord)) return null;
        const r = reader(bytes, 8);
        const record = {
            address,
            proposal: r.pubkey('proposal'),
            member: r.pubkey('member'),
            verdictAttestation: r.pubkey('verdict_attestation'),
            verdictHash: Array.from(r.bytes(32, 'verdict_hash'), byte => byte.toString(16).padStart(2, '0')).join(''),
            verdictCode: r.u8('verdict'),
            settledAt: safeNumber(r.i64('settled_at'), 'settled_at'),
            bump: r.u8('bump')
        };
        record.verdict = STATUS_NAMES[record.verdictCode] || `Unknown(${record.verdictCode})`;
        return record;
    }

    // SAS attestation: 2 | nonce 32 | credential 32 | schema 32 | data (u32 + bytes) | signer 32 |
    // expiry i64 | token_account 32. Throws when the bytes are not an attestation.
    function parseSasAttestation(data) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!bytes.length || bytes[0] !== constants.SAS_ATTESTATION_DISCRIMINATOR) throw new Error('account is not a SAS attestation');
        const r = reader(bytes, 1);
        const nonce = r.pubkey('nonce');
        const credential = r.pubkey('credential');
        const schema = r.pubkey('schema');
        const length = r.u32('data');
        const payload = r.bytes(length, 'data');
        const authority = r.pubkey('signer');
        const expiry = safeNumber(r.i64('expiry'), 'expiry');
        return { nonce, credential, schema, payload, authority, expiry };
    }

    // Payload layouts frozen by lens-model.md; must be consumed exactly, like the program does.
    const PAYLOAD_FIELDS = Object.freeze({
        ownership: Object.freeze([['parcelUid', 'string'], ['owner', 'string'], ['ownerCount', 'u8'], ['evidenceRef', 'string'], ['sourceObservedAt', 'i64']]),
        verdict: Object.freeze([['proposalAccount', 'string'], ['verdict', 'string'], ['evidenceRef', 'string'], ['sourceObservedAt', 'i64']])
    });

    function decodeLensPayload(kind, payload) {
        const fields = PAYLOAD_FIELDS[kind];
        if (!fields) throw new Error(`unknown lens payload kind ${kind}`);
        const r = reader(payload, 0);
        const out = {};
        for (const [name, type] of fields) {
            out[name] = type === 'string' ? r.string(name) : type === 'u8' ? r.u8(name) : safeNumber(r.i64(name), name);
        }
        if (r.offset !== r.body.length) throw new Error(`${kind} payload has ${r.body.length - r.offset} trailing bytes`);
        return out;
    }

    // Client-side mirror of the program's accept checks that can be judged from the bytes alone,
    // so a wallet is never asked to sign a transaction that is certain to fail.
    function checkOwnershipForAccept({ attestation, fields, proposal, parcelId, owner, nowSeconds }) {
        const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
        if (!proposal) return 'proposal_missing';
        if (proposal.statusCode !== constants.STATUS_ACTIVE || !proposal.acceptancePossible) return 'proposal_not_active';
        if (!proposal.parcelIds.includes(parcelId)) return 'parcel_not_in_proposal';
        if (proposal.acceptedParcels.includes(parcelId)) return 'parcel_already_accepted';
        if (!proposal.lens.includes(attestation.authority)) return 'member_not_in_lens';
        if (!(attestation.expiry > now)) return 'attestation_expired';
        if (fields.parcelUid !== parcelId) return 'wrong_parcel';
        if (fields.owner !== owner) return 'wrong_owner';
        if (!(fields.ownerCount >= 1)) return 'owner_count';
        if (fields.sourceObservedAt > now) return 'observed_in_future';
        return null;
    }

    // `verdictRecords` are the proposal's existing VerdictRecords (fetchVerdictRecords); a record for
    // this attestation means it was already settled and the record's `init` would fail.
    function checkVerdictForSettle({ attestation, fields, proposal, proposalAddress, verdictRecords = [], nowSeconds }) {
        const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
        if (!proposal) return 'proposal_missing';
        if ((verdictRecords || []).some(record => record && record.verdictAttestation === attestation.address)) return 'verdict_already_settled';
        if (proposal.statusCode !== constants.STATUS_ACTIVE) return 'proposal_not_active';
        if (!proposal.lens.includes(attestation.authority)) return 'member_not_in_lens';
        if (!(attestation.expiry > now)) return 'attestation_expired';
        if (fields.proposalAccount !== proposalAddress) return 'wrong_proposal';
        if (fields.verdict !== 'executed' && fields.verdict !== 'expired') return 'bad_verdict';
        if (fields.verdict === 'executed' && !proposal.verdictMayExecute) return 'verdict_cannot_execute';
        if (fields.sourceObservedAt > now) return 'observed_in_future';
        return null;
    }

    // ---- reads (connection injected) ------------------------------------------------------------

    async function fetchAccountData(connection, address) {
        const info = await connection.getAccountInfo(toKey(address, 'address'), 'confirmed');
        return info && info.data ? new Uint8Array(info.data) : null;
    }

    async function fetchProposalV2(connection, proposal) {
        const data = await fetchAccountData(connection, proposal);
        return data ? readProposalV2(data, toKey(proposal, 'proposal').toBase58()) : null;
    }

    async function fetchConsentTally(connection, { proposal, parcelId, programId } = {}) {
        const [address] = getConsentTallyPda(proposal, parcelId, programId);
        const data = await fetchAccountData(connection, address);
        return data ? readConsentTally(data, address.toBase58()) : null;
    }

    async function fetchAcceptanceRecord(connection, { proposal, parcelId, owner, programId } = {}) {
        const [address] = getAcceptanceRecordPda(proposal, parcelId, owner, programId);
        const data = await fetchAccountData(connection, address);
        return data ? readAcceptanceRecord(data, address.toBase58()) : null;
    }

    async function fetchVerdictRecord(connection, { proposal, verdictAttestation, programId } = {}) {
        const [address] = getVerdictRecordPda(proposal, verdictAttestation, programId);
        const data = await fetchAccountData(connection, address);
        return data ? readVerdictRecord(data, address.toBase58()) : null;
    }

    // Every account of one kind that names this proposal right after the discriminator.
    async function fetchByProposal(connection, kind, proposal, programId, read) {
        const accounts = await connection.getProgramAccounts(toKey(programId || constants.PROPOSAL_NFT_PROGRAM_ID, 'programId'), {
            commitment: 'confirmed',
            filters: [
                { memcmp: { offset: 0, bytes: LensCore.base58Encode(Uint8Array.from(ACCOUNT_DISCRIMINATORS[kind])) } },
                { memcmp: { offset: 8, bytes: toKey(proposal, 'proposal').toBase58() } }
            ]
        });
        return accounts.map(({ pubkey, account }) => read(new Uint8Array(account.data), pubkey.toBase58())).filter(Boolean);
    }

    function fetchConsentTallies(connection, { proposal, programId } = {}) {
        return fetchByProposal(connection, 'ConsentTally', proposal, programId, readConsentTally);
    }

    function fetchAcceptanceRecords(connection, { proposal, programId } = {}) {
        return fetchByProposal(connection, 'AcceptanceRecord', proposal, programId, readAcceptanceRecord);
    }

    function fetchVerdictRecords(connection, { proposal, programId } = {}) {
        return fetchByProposal(connection, 'VerdictRecord', proposal, programId, readVerdictRecord);
    }

    async function fetchLensAttestation(connection, kind, address) {
        const data = await fetchAccountData(connection, address);
        if (!data) return null;
        const attestation = parseSasAttestation(data);
        return { address: toKey(address, 'attestation').toBase58(), ...attestation, fields: decodeLensPayload(kind, attestation.payload) };
    }

    const api = {
        constants,
        IX_DISCRIMINATORS,
        ACCOUNT_DISCRIMINATORS,
        STATUS_NAMES,
        configure,
        encodeString,
        encodeOptionPubkey,
        encodeMintAndFundData,
        encodeMintParcelData,
        encodeAcceptWithAttestationsData,
        encodeSettleWithVerdictData,
        encodeDistributeFundsData,
        getProposalCounterPda,
        getProposalPda,
        getParcelPda,
        getConsentTallyPda,
        getAcceptanceRecordPda,
        getVerdictRecordPda,
        deriveCredentialPda,
        deriveSchemaPda,
        buildMintAndFundIx,
        buildMintParcelIx,
        buildAcceptWithAttestationsIx,
        buildSettleWithVerdictIx,
        planDistribution,
        buildDistributeFundsIx,
        readProposalV2,
        readConsentTally,
        readAcceptanceRecord,
        readVerdictRecord,
        parseSasAttestation,
        decodeLensPayload,
        checkOwnershipForAccept,
        checkVerdictForSettle,
        fetchProposalV2,
        fetchConsentTally,
        fetchAcceptanceRecord,
        fetchConsentTallies,
        fetchAcceptanceRecords,
        fetchVerdictRecord,
        fetchVerdictRecords,
        fetchLensAttestation
    };

    return api;
});
