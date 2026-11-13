// Pure client codec for the ugt program's parcel anchors and design/plan records
// (blockchain/solana/programs/ugt, README there): the anchor PDA ["parcel", parcel_id], the record
// PDA ["record", kind, sha256(cid)] and its Metaplex Core asset PDA ["asset", kind, sha256(cid)],
// byte-exact Anchor/borsh builders for anchor_parcels and create_record, the account decoders and
// the program-account listings. The agreement side of the same program is agreement-client.js. No
// DOM and no wallet: @solana/web3.js and sha256 are injected (configure), the browser's vendored
// builds, or the node packages. UMD: window.UgtClient in the browser, module.exports for node.
(function attachUgtClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.UgtClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function ugtClientFactory() {
    'use strict';

    // COPIED from the program, never computed at runtime: sha256("global:<instruction>")[..8] and
    // sha256("account:<Account>")[..8], the values the generated IDL lists (idl/ugt.json).
    const IX_DISCRIMINATORS = Object.freeze({
        anchor_parcels: Object.freeze([116, 67, 109, 222, 96, 86, 119, 197]),
        create_record: Object.freeze([116, 124, 63, 58, 126, 204, 178, 10])
    });
    const ACCOUNT_DISCRIMINATORS = Object.freeze({
        ParcelAnchor: Object.freeze([21, 240, 237, 186, 245, 40, 164, 227]),
        Record: Object.freeze([254, 233, 117, 252, 76, 166, 146, 139])
    });

    const constants = Object.freeze({
        // The devnet deployment (Anchor.toml, programs/ugt/src/lib.rs declare_id!).
        UGT_PROGRAM_ID: '95sjeTXUYG721iZK29s3kr7Dq4eFqv6PFoEmPYJDtkp9',
        MPL_CORE_PROGRAM_ID: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
        PARCEL_SEED: 'parcel',
        RECORD_SEED: 'record',
        ASSET_SEED: 'asset',
        KIND_DESIGN: 1,
        KIND_PLAN: 2,
        MAX_CID_BYTES: 64,
        MAX_PARCEL_ID_BYTES: 32,
        MAX_METADATA_URI_BYTES: 200,
        MAX_ANCHORS_PER_CALL: 16,
        MAX_NAME_BYTES: 100,
        MAX_URI_BYTES: 1000,
        // 8-byte discriminator + Record::INIT_SPACE (1 + 32 + 8 + 32 + 1 + 1 + 4 + 64).
        RECORD_ACCOUNT_SPACE: 151
    });
    const KIND_CODES = Object.freeze({ design: constants.KIND_DESIGN, plan: constants.KIND_PLAN });
    const KIND_NAMES = Object.freeze({ 1: 'design', 2: 'plan' });

    // Offsets of the fixed fields (memcmp filters): a record's kind, a parcel anchor's payer.
    const RECORD_OFFSETS = Object.freeze({ kind: 8, minter: 9, createdAt: 41, asset: 49, cid: 83 });
    const ANCHOR_OFFSETS = Object.freeze({ anchoredBy: 8, anchoredAt: 40, parcelId: 49 });

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
        throw new Error('@solana/web3.js is not available: pass it to UgtClient.configure({ web3 })');
    }

    // sha256 of a UTF-8 string as lowercase hex: injected, the frontend's vendored noble build, then node:crypto.
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
        throw new Error('no sha256 is available: pass sha256Hex to UgtClient.configure({ sha256Hex })');
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

    function encodeString(value) {
        const bytes = utf8(String(value));
        return concat([u32(bytes.length), bytes]);
    }

    function encodeStrings(values) {
        return concat([u32(values.length), ...values.map(encodeString)]);
    }

    function hexToBytes(hex) {
        if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw new Error('sha256Hex must return 64 lowercase hex digits');
        return Uint8Array.from(hex.match(/../g), pair => parseInt(pair, 16));
    }

    // ---- validation, CID and PDAs ---------------------------------------------------------------------

    // The program's rule: 1-64 ASCII letters and digits.
    function requireCid(cid) {
        if (typeof cid !== 'string' || !/^[A-Za-z0-9]+$/.test(cid)) throw new Error('cid must be 1-64 ASCII letters and digits');
        if (cid.length > constants.MAX_CID_BYTES) throw new Error(`cid is ${cid.length} bytes; the program stores at most ${constants.MAX_CID_BYTES}`);
        return cid;
    }

    // The last PDA seed of a record: sha256 over the CID's UTF-8 bytes (the program's cid_seed).
    function cidSeed(cid) {
        return hexToBytes(resolveSha256Hex()(requireCid(cid)));
    }

    function kindCode(kind) {
        const code = typeof kind === 'number' ? kind : KIND_CODES[kind];
        if (code !== constants.KIND_DESIGN && code !== constants.KIND_PLAN) throw new Error(`kind must be design or plan, not ${kind}`);
        return code;
    }

    // A parcel id is the anchor PDA's seed: 1-32 bytes.
    function parcelSeed(parcelId) {
        const bytes = utf8(String(parcelId));
        if (!bytes.length || bytes.length > constants.MAX_PARCEL_ID_BYTES) throw new Error(`parcelId must be 1-${constants.MAX_PARCEL_ID_BYTES} bytes to be a PDA seed`);
        return bytes;
    }

    // ["parcel", parcel_id] under the program.
    function getParcelPda(parcelId, programId = constants.UGT_PROGRAM_ID) {
        const { PublicKey } = resolveWeb3();
        return PublicKey.findProgramAddressSync([utf8(constants.PARCEL_SEED), parcelSeed(parcelId)], toKey(programId, 'programId'));
    }

    // ["record", kind, sha256(cid)] under the program.
    function getRecordPda(kind, cid, programId = constants.UGT_PROGRAM_ID) {
        const { PublicKey } = resolveWeb3();
        return PublicKey.findProgramAddressSync([utf8(constants.RECORD_SEED), Uint8Array.of(kindCode(kind)), cidSeed(cid)], toKey(programId, 'programId'));
    }

    // ["asset", kind, sha256(cid)] under the program: the record's Metaplex Core asset.
    function getAssetPda(kind, cid, programId = constants.UGT_PROGRAM_ID) {
        const { PublicKey } = resolveWeb3();
        return PublicKey.findProgramAddressSync([utf8(constants.ASSET_SEED), Uint8Array.of(kindCode(kind)), cidSeed(cid)], toKey(programId, 'programId'));
    }

    // ---- instruction data -----------------------------------------------------------------------------

    // anchor_parcels(parcel_ids: Vec<String>, metadata_uris: Vec<String>)
    function encodeAnchorParcelsData(parcelIds, metadataUris) {
        if (!Array.isArray(parcelIds) || !parcelIds.length || parcelIds.length > constants.MAX_ANCHORS_PER_CALL) {
            throw new Error(`anchor_parcels takes 1-${constants.MAX_ANCHORS_PER_CALL} parcel ids`);
        }
        if (!Array.isArray(metadataUris) || metadataUris.length !== parcelIds.length) throw new Error('one metadata URI per parcel id is required');
        parcelIds.forEach(parcelSeed);
        metadataUris.forEach(uri => {
            const bytes = utf8(String(uri)).length;
            if (!bytes || bytes > constants.MAX_METADATA_URI_BYTES) throw new Error(`a metadata URI must be 1-${constants.MAX_METADATA_URI_BYTES} bytes`);
        });
        return concat([Uint8Array.from(IX_DISCRIMINATORS.anchor_parcels), encodeStrings(parcelIds.map(String)), encodeStrings(metadataUris.map(String))]);
    }

    // create_record(kind: u8, cid: String, name: String, uri: String)
    function encodeCreateRecordData(kind, cid, name, uri) {
        const nameBytes = utf8(String(name)).length;
        const uriBytes = utf8(String(uri)).length;
        if (!nameBytes || nameBytes > constants.MAX_NAME_BYTES) throw new Error(`name must be 1-${constants.MAX_NAME_BYTES} bytes`);
        if (!uriBytes || uriBytes > constants.MAX_URI_BYTES) throw new Error(`uri must be 1-${constants.MAX_URI_BYTES} bytes`);
        return concat([Uint8Array.from(IX_DISCRIMINATORS.create_record), Uint8Array.of(kindCode(kind)), encodeString(requireCid(cid)), encodeString(name), encodeString(uri)]);
    }

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

    // Accounts: payer (signer, mut), system_program, then one writable remaining account per parcel:
    // its anchor PDA. The program skips anchors that exist.
    function buildAnchorParcelsIx({ parcelIds, metadataUris, payer, programId = constants.UGT_PROGRAM_ID } = {}) {
        const data = encodeAnchorParcelsData(parcelIds, metadataUris);
        const parcels = parcelIds.map(parcelId => getParcelPda(parcelId, programId)[0]);
        return {
            parcels,
            instruction: instruction(programId, [
                meta(toKey(payer, 'payer'), true, true),
                meta(toKey(constants.SYSTEM_PROGRAM_ID, 'system program'), false, false),
                ...parcels.map(parcel => meta(parcel, false, true))
            ], data)
        };
    }

    // Accounts: record (init, PDA), asset (mut, PDA), minter (signer, mut: pays, receives the asset),
    // mpl_core_program, system_program.
    function buildCreateRecordIx({ kind, cid, name, uri, minter, programId = constants.UGT_PROGRAM_ID } = {}) {
        const data = encodeCreateRecordData(kind, cid, name, uri);
        const [record] = getRecordPda(kind, cid, programId);
        const [asset] = getAssetPda(kind, cid, programId);
        return {
            record,
            asset,
            instruction: instruction(programId, [
                meta(record, false, true),
                meta(asset, false, true),
                meta(toKey(minter, 'minter'), true, true),
                meta(toKey(constants.MPL_CORE_PROGRAM_ID, 'Metaplex Core'), false, false),
                meta(toKey(constants.SYSTEM_PROGRAM_ID, 'system program'), false, false)
            ], data)
        };
    }

    // ---- decoders -------------------------------------------------------------------------------------
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
            i64(label) {
                need(8, label);
                const value = view.getBigInt64(offset, true);
                offset += 8;
                if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError(`${label} exceeds the safe integer range`);
                return Number(value);
            },
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

    // A ParcelAnchor account: { address, parcelId, metadataUri, anchoredBy, anchoredAt (unix seconds), bump }.
    function readParcelAnchor(data, address = null) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!hasDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.ParcelAnchor)) return null;
        const r = reader(bytes, 8);
        const anchoredBy = r.pubkey('anchored_by');
        const anchoredAt = r.i64('anchored_at');
        const bump = r.u8('bump');
        const parcelId = r.string('parcel_id');
        const metadataUri = r.string('metadata_uri');
        return { address, parcelId, metadataUri, anchoredBy, anchoredAt, bump };
    }

    // A Record account: { address, kind ('design' | 'plan'), kindCode, cid, minter, createdAt (unix seconds), asset, bump }.
    function readRecord(data, address = null) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (!hasDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.Record)) return null;
        const r = reader(bytes, 8);
        const code = r.u8('kind');
        const minter = r.pubkey('minter');
        const createdAt = r.i64('created_at');
        const asset = r.pubkey('asset');
        const bump = r.u8('bump');
        r.u8('asset_bump');
        const cid = r.string('cid');
        return { address, kind: KIND_NAMES[code] || String(code), kindCode: code, cid, minter, createdAt, asset, bump };
    }

    // ---- reads (connection injected) ------------------------------------------------------------------

    // The anchors of `parcelIds`, in order: a decoded anchor or null for each (missing, or not an anchor).
    async function fetchParcelAnchors(connection, parcelIds, { programId = constants.UGT_PROGRAM_ID, batchSize = 100 } = {}) {
        const program = toKey(programId, 'programId');
        const keys = parcelIds.map(parcelId => getParcelPda(parcelId, programId)[0]);
        const out = [];
        for (let offset = 0; offset < keys.length; offset += batchSize) {
            const batch = keys.slice(offset, offset + batchSize);
            const infos = await connection.getMultipleAccountsInfo(batch, 'confirmed');
            batch.forEach((key, index) => {
                const info = infos[index];
                const owned = info && info.data && toKey(info.owner, 'owner').equals(program);
                out.push(owned ? readParcelAnchor(new Uint8Array(info.data), key.toBase58()) : null);
            });
        }
        return out;
    }

    // The record of `cid` as `kind`, or null when it is not minted. Checks the owner and the stored CID.
    async function fetchRecord(connection, { kind, cid, programId = constants.UGT_PROGRAM_ID } = {}) {
        const key = getRecordPda(kind, cid, programId)[0];
        const info = await connection.getAccountInfo(key, 'confirmed');
        if (!info || !info.data) return null;
        if (!toKey(info.owner, 'owner').equals(toKey(programId, 'programId'))) throw new Error(`account ${key.toBase58()} belongs to another program`);
        const value = readRecord(new Uint8Array(info.data), key.toBase58());
        if (!value) throw new Error(`account ${key.toBase58()} does not have the Record discriminator`);
        if (value.cid !== cid) throw new Error(`record ${key.toBase58()} stores CID ${value.cid}, not ${cid}`);
        return value;
    }

    // Every record of `kind` (null: both kinds), decoded, newest first. The RPC filters by size and
    // kind; an account whose discriminator or address does not match a record at its own PDA is skipped.
    async function listRecords(connection, { kind = null, programId = constants.UGT_PROGRAM_ID } = {}) {
        const filters = [{ dataSize: constants.RECORD_ACCOUNT_SPACE }];
        if (kind) filters.push({ memcmp: { offset: RECORD_OFFSETS.kind, bytes: base58Of(Uint8Array.of(kindCode(kind))) } });
        const accounts = await connection.getProgramAccounts(toKey(programId, 'programId'), { commitment: 'confirmed', filters });
        const records = [];
        for (const { pubkey, account } of accounts) {
            const address = toKey(pubkey, 'pubkey').toBase58();
            const value = readRecord(new Uint8Array(account.data), address);
            const expected = value && getRecordPda(value.kindCode, value.cid, programId)[0].toBase58();
            if (!value || expected !== address) {
                console.warn(`[${new Date().toISOString()}] [UgtClient] skipped ${address}: ${value ? `not the PDA of ${value.cid}` : 'not a Record account'}`);
                continue;
            }
            records.push(value);
        }
        return records.sort((a, b) => b.createdAt - a.createdAt || a.address.localeCompare(b.address));
    }

    // The base58 of a few bytes, for a memcmp filter (web3's PublicKey decodes any 32 bytes, so a
    // short value is encoded through the bs58 alphabet directly).
    const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function base58Of(bytes) {
        let value = 0n;
        for (const byte of bytes) value = (value << 8n) + BigInt(byte);
        let out = '';
        while (value > 0n) { out = BASE58[Number(value % 58n)] + out; value /= 58n; }
        for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
        return out || '1';
    }

    api = {
        constants,
        IX_DISCRIMINATORS,
        ACCOUNT_DISCRIMINATORS,
        KIND_CODES,
        KIND_NAMES,
        RECORD_OFFSETS,
        ANCHOR_OFFSETS,
        configure,
        requireCid,
        cidSeed,
        kindCode,
        getParcelPda,
        getRecordPda,
        getAssetPda,
        encodeAnchorParcelsData,
        encodeCreateRecordData,
        buildAnchorParcelsIx,
        buildCreateRecordIx,
        readParcelAnchor,
        readRecord,
        fetchParcelAnchors,
        fetchRecord,
        listRecords,
        base58Of
    };
    return api;
});
