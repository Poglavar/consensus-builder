// Lens members' statements about property, as SAS attestations a wallet or a service issues under
// its own LensMember credential: PropertyHolding-v1 (who first holds an asset, at an address fixed
// by the asset, so one lens member states one first holder per asset) and
// PropertyOfferConfirmation-v1 (an offer's sale or buyer confirmation; property-offer-client.js
// fixes its address). Pure instruction builders and readers; byte-exact with sas-lib 1.0.10.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PropertyStatements = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const constants = Object.freeze({
        SAS_PROGRAM_ID: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG', SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
        SAS_EVENT_AUTHORITY: 'DzSpKpST2TSyrxokMXchFz3G2yn5WEGoxzpGEUDjCX4g',
        SAS_CREATE_CREDENTIAL: 0, SAS_CREATE_SCHEMA: 1, SAS_CREATE_ATTESTATION: 6, SAS_CLOSE_ATTESTATION: 7,
        CREDENTIAL_NAME: 'LensMember',
        // A first holding stays true until a sale moves it; it lapses only if the lens member lets it.
        STATEMENT_EXPIRY_SECONDS: 10 * 365 * 24 * 3600,
        BASES: Object.freeze(['developer', 'declared', 'registry'])
    });
    // SAS layout codes: uint8 0, int64 8, string 12 (backend/oracle/lens-schemas.js).
    const SCHEMAS = Object.freeze({
        holding: Object.freeze({ name: 'PropertyHolding', version: 1,
            description: 'A lens member states who first holds a plot or a flat, and on what basis.',
            fields: ['assetHash', 'asset', 'holder', 'basis', 'evidence', 'observedAt'], layout: [12, 12, 12, 12, 12, 8] }),
        confirmation: Object.freeze({ name: 'PropertyOfferConfirmation', version: 1,
            description: 'A lens member confirms, for one property offer, that the seller holds the asset (role 0) or that the buyer qualifies (role 1).',
            fields: ['cid', 'offer', 'termsHash', 'payoutsHash', 'buyer', 'seller', 'role', 'assetHash', 'holding', 'observedAt'], layout: [12, 12, 12, 12, 12, 12, 0, 12, 12, 8] })
    });
    let injectedWeb3 = null;
    function web3() { if (injectedWeb3) return injectedWeb3; if (globalThis.solanaWeb3) return globalThis.solanaWeb3; if (typeof require === 'function') try { return require('@solana/web3.js'); } catch (_) { /* browser path: injected */ } throw new Error('configure with @solana/web3.js'); }
    function configure(o = {}) { if ('web3' in o) injectedWeb3 = o.web3; return api; }
    const utf8 = value => new TextEncoder().encode(value);
    function key(value, label) { const { PublicKey } = web3(); try { return value instanceof PublicKey ? value : new PublicKey(value); } catch (_) { throw new Error(`${label} must be a base58 public key`); } }
    function concat(parts) { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; }
    function u32(v) { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, v, true); return o; }
    function i64(v, label) { const n = BigInt(v); if (n < -(1n << 63n) || n >= 1n << 63n) throw new Error(`${label} must fit i64`); const o = new Uint8Array(8); new DataView(o.buffer).setBigInt64(0, n, true); return o; }
    const string = v => { if (typeof v !== 'string') throw new Error('string required'); const b = utf8(v); return concat([u32(b.length), b]); };
    const hexBytes = (value, label) => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be 64 lowercase hex chars`); return Uint8Array.from(value.match(/../g).map(x => parseInt(x, 16))); };
    const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
    function ix(keys, data) { const { TransactionInstruction } = web3(); return new TransactionInstruction({ programId: key(constants.SAS_PROGRAM_ID, 'SAS'), keys, data: typeof Buffer !== 'undefined' ? Buffer.from(data) : data }); }
    const sasPda = seeds => web3().PublicKey.findProgramAddressSync(seeds, key(constants.SAS_PROGRAM_ID, 'SAS'))[0];
    const schemaOf = kind => { const s = SCHEMAS[kind]; if (!s) throw new Error(`unknown statement kind ${kind}`); return s; };

    function credentialPda(authority) { return sasPda([utf8('credential'), key(authority, 'authority').toBytes(), utf8(constants.CREDENTIAL_NAME)]); }
    function schemaPda(credential, kind) { const s = schemaOf(kind); return sasPda([utf8('schema'), key(credential, 'credential').toBytes(), utf8(s.name), Uint8Array.of(s.version)]); }
    function attestationPda({ credential, kind, nonce }) { return sasPda([utf8('attestation'), key(credential, 'credential').toBytes(), schemaPda(credential, kind).toBytes(), key(nonce, 'nonce').toBytes()]); }
    /** A lens member's first-holder statement for an asset lives at one address. */
    function holdingAddress(member, assetHash) { const credential = credentialPda(member); return attestationPda({ credential, kind: 'holding', nonce: new (web3().PublicKey)(hexBytes(assetHash, 'assetHash')) }); }
    /** Its sale confirmation for (asset, holding): see PropertyOfferClient.decisionNonce. */
    function confirmationAddress(member, nonce) { return attestationPda({ credential: credentialPda(member), kind: 'confirmation', nonce }); }

    function buildCreateCredentialIx({ payer, authority }) {
        return ix([meta(key(payer, 'payer'), true, true), meta(credentialPda(authority), false, true), meta(key(authority, 'authority'), true, false), meta(key(constants.SYSTEM_PROGRAM_ID, 'system'), false, false)],
            concat([Uint8Array.of(constants.SAS_CREATE_CREDENTIAL), string(constants.CREDENTIAL_NAME), u32(1), key(authority, 'authority').toBytes()]));
    }
    function buildCreateSchemaIx({ payer, authority, kind }) {
        const s = schemaOf(kind); const credential = credentialPda(authority);
        return ix([meta(key(payer, 'payer'), true, true), meta(key(authority, 'authority'), true, false), meta(credential, false, false), meta(schemaPda(credential, kind), false, true), meta(key(constants.SYSTEM_PROGRAM_ID, 'system'), false, false)],
            concat([Uint8Array.of(constants.SAS_CREATE_SCHEMA), string(s.name), string(s.description), u32(s.layout.length), Uint8Array.from(s.layout), u32(s.fields.length), ...s.fields.map(string)]));
    }
    function buildCreateAttestationIx({ payer, authority, kind, nonce, payload, expiry }) {
        const credential = credentialPda(authority); const schema = schemaPda(credential, kind); const attestation = attestationPda({ credential, kind, nonce });
        const instruction = ix([meta(key(payer, 'payer'), true, true), meta(key(authority, 'authority'), true, false), meta(credential, false, false), meta(schema, false, false), meta(attestation, false, true), meta(key(constants.SYSTEM_PROGRAM_ID, 'system'), false, false)],
            concat([Uint8Array.of(constants.SAS_CREATE_ATTESTATION), key(nonce, 'nonce').toBytes(), u32(payload.length), payload, i64(expiry, 'expiry')]));
        return { instruction, attestation: attestation.toBase58(), credential: credential.toBase58(), schema: schema.toBase58() };
    }
    /** Withdraw a statement: the lens member closes its own attestation (rent returns to `payer`). */
    function buildCloseAttestationIx({ payer, authority, attestation }) {
        return ix([meta(key(payer, 'payer'), true, true), meta(key(authority, 'authority'), true, false), meta(credentialPda(authority), false, false), meta(key(attestation, 'attestation'), false, true),
            meta(key(constants.SAS_EVENT_AUTHORITY, 'event authority'), false, false), meta(key(constants.SYSTEM_PROGRAM_ID, 'system'), false, false), meta(key(constants.SAS_PROGRAM_ID, 'SAS'), false, false)], Uint8Array.of(constants.SAS_CLOSE_ATTESTATION));
    }
    /** The credential and schemas a lens member still lacks, as instructions it signs once. */
    async function setupIxs(connection, { payer, authority, kinds = ['holding', 'confirmation'] }) {
        const out = []; const credential = credentialPda(authority);
        if (!(await connection.getAccountInfo(credential, 'confirmed'))) out.push(buildCreateCredentialIx({ payer, authority }));
        for (const kind of kinds) if (!(await connection.getAccountInfo(schemaPda(credential, kind), 'confirmed'))) out.push(buildCreateSchemaIx({ payer, authority, kind }));
        return out;
    }

    function encodeHoldingPayload({ assetHash, asset, holder, basis, evidence = '', observedAt }) {
        hexBytes(assetHash, 'assetHash'); key(holder, 'holder');
        if (!constants.BASES.includes(basis)) throw new Error(`basis is one of ${constants.BASES.join(', ')}`);
        if (typeof asset !== 'string' || !asset) throw new Error('asset is the asset key text');
        return concat([string(assetHash), string(asset), string(key(holder, 'holder').toBase58()), string(basis), string(evidence), i64(observedAt, 'observedAt')]);
    }
    /** A first-holder statement for `assetHash` by `authority`, at its fixed address. */
    function buildHoldingIx({ payer, authority, assetHash, asset, holder, basis, evidence, observedAt, expiry }) {
        return buildCreateAttestationIx({ payer, authority, kind: 'holding', nonce: new (web3().PublicKey)(hexBytes(assetHash, 'assetHash')),
            payload: encodeHoldingPayload({ assetHash, asset, holder, basis, evidence, observedAt }), expiry: expiry ?? observedAt + constants.STATEMENT_EXPIRY_SECONDS });
    }

    function reader(bytes, start) { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let at = start; const take = n => { if (at + n > bytes.length) throw new RangeError('truncated statement'); const x = bytes.slice(at, at + n); at += n; return x; }; return { u32() { const n = v.getUint32(at, true); take(4); return n; }, i64() { const n = v.getBigInt64(at, true); take(8); return n; }, key: () => new (web3().PublicKey)(take(32)).toBase58(), bytes: take, string() { return new TextDecoder().decode(take(this.u32())); }, pos: () => at }; }
    /** The attestation envelope; `payload` is the raw bytes for a schema reader. */
    function readAttestation(data) {
        const b = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
        if (b[0] !== 2) return null;
        const r = reader(b, 1);
        const nonce = r.key(), credential = r.key(), schema = r.key(), payload = r.bytes(r.u32()), signer = r.key(), expiry = r.i64();
        return { nonce, credential, schema, payload, signer, expiry };
    }
    function readHolding(data) {
        const a = readAttestation(data); if (!a) return null;
        const r = reader(a.payload, 0);
        const fields = { assetHash: r.string(), asset: r.string(), holder: r.string(), basis: r.string(), evidence: r.string(), observedAt: r.i64() };
        if (r.pos() !== a.payload.length || !/^[0-9a-f]{64}$/.test(fields.assetHash)) throw new RangeError('invalid PropertyHolding payload');
        return { ...a, fields };
    }
    const api = { constants, SCHEMAS, configure, credentialPda, schemaPda, attestationPda, holdingAddress, confirmationAddress, buildCreateCredentialIx, buildCreateSchemaIx,
        buildCreateAttestationIx, buildCloseAttestationIx, setupIxs, encodeHoldingPayload, buildHoldingIx, readAttestation, readHolding };
    return api;
});
