// Pure client codec for the parcel_nft program (blockchain/solana/idl/parcel_nft.json): the ownerless
// parcel anchor PDA ["parcel", parcel_id] and the byte-exact mint_parcel instruction. No DOM and no
// wallet: @solana/web3.js is injected (configure), the browser's vendored build, or the package. UMD
// like market-client.js: window.SolanaParcelClient in the browser (solana/parcel-mint.js signs with
// it), module.exports for node.
(function attachSolanaParcelClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaParcelClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function solanaParcelClientFactory() {
    'use strict';

    // COPIED from the IDL, never computed at runtime: sha256("global:mint_parcel")[..8].
    const IX_DISCRIMINATORS = Object.freeze({
        mint_parcel: Object.freeze([158, 42, 246, 137, 217, 57, 167, 210])
    });

    const constants = Object.freeze({
        PARCEL_NFT_PROGRAM_ID: '4zadC1FgWPQLv6qv66mjEBthBqTvrmxL5oDcHQzNtkV1',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
        // An anchor has no owner: its owner field holds the default key.
        DEFAULT_PUBKEY: '11111111111111111111111111111111'
    });

    const MAX_SEED_BYTES = 32;

    let injectedWeb3 = null;
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
        throw new Error('@solana/web3.js is not available: pass it to SolanaParcelClient.configure({ web3 })');
    }

    function configure(options) {
        const opts = options || {};
        if (Object.prototype.hasOwnProperty.call(opts, 'web3')) injectedWeb3 = opts.web3 || null;
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

    // ---- borsh encoders -------------------------------------------------------------------------

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
        const bytes = new TextEncoder().encode(String(value));
        return concat([u32(bytes.length), bytes]);
    }

    // A PDA seed is at most 32 bytes; the parcel id is the parcel PDA's seed.
    function seedBytes(text, label) {
        const bytes = new TextEncoder().encode(String(text));
        if (!bytes.length || bytes.length > MAX_SEED_BYTES) throw new Error(`${label} must be 1-${MAX_SEED_BYTES} bytes to be a PDA seed`);
        return bytes;
    }

    // mint_parcel(parcel_id: String, metadata_uri: String)
    function encodeMintParcelData(parcelId, metadataUri) {
        return concat([Uint8Array.from(IX_DISCRIMINATORS.mint_parcel), encodeString(parcelId), encodeString(metadataUri)]);
    }

    // ["parcel", parcel_id] under parcel_nft.
    function getParcelPda(parcelId, programId = constants.PARCEL_NFT_PROGRAM_ID) {
        const { PublicKey } = resolveWeb3();
        return PublicKey.findProgramAddressSync([new TextEncoder().encode('parcel'), seedBytes(parcelId, 'parcelId')], toKey(programId, 'programId'));
    }

    // v2 ownerless anchor. Accounts: parcel (mut, PDA), payer (signer, mut), system_program.
    function buildMintParcelIx({ parcelId, metadataUri, payer, programId = constants.PARCEL_NFT_PROGRAM_ID } = {}) {
        const { TransactionInstruction } = resolveWeb3();
        const [parcel] = getParcelPda(parcelId, programId);
        const data = encodeMintParcelData(parcelId, metadataUri);
        return {
            parcel,
            instruction: new TransactionInstruction({
                programId: toKey(programId, 'programId'),
                keys: [
                    { pubkey: parcel, isSigner: false, isWritable: true },
                    { pubkey: toKey(payer, 'payer'), isSigner: true, isWritable: true },
                    { pubkey: toKey(constants.SYSTEM_PROGRAM_ID, 'system'), isSigner: false, isWritable: false }
                ],
                data: typeof Buffer === 'function' ? Buffer.from(data) : data
            })
        };
    }

    api = { constants, IX_DISCRIMINATORS, configure, encodeMintParcelData, getParcelPda, buildMintParcelIx };
    return api;
});
