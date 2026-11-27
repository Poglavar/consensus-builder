// Pure browser/node codec for programs/property_offer v2. It builds byte-exact Anchor instructions
// (with the USDC token accounts they need), reads offer accounts and lens members' decisions;
// wallets, RPC and the lens workflow stay outside this module.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PropertyOfferClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const IX_DISCRIMINATORS = Object.freeze({
        create: [24, 30, 200, 40, 5, 28, 7, 119], commit: [223, 140, 142, 165, 229, 208, 156, 74], confirm: [174, 1, 15, 213, 3, 190, 131, 0],
        execute: [130, 221, 242, 154, 13, 193, 189, 29], cancel: [232, 219, 223, 41, 219, 236, 220, 190], expire: [243, 83, 205, 58, 57, 201, 247, 146]
    });
    const ACCOUNT_DISCRIMINATORS = Object.freeze({ PropertyOffer: [122, 70, 152, 136, 45, 32, 234, 85] });
    const constants = Object.freeze({
        PROPERTY_OFFER_PROGRAM_ID: 'HrK4gvMqpYNvYSidaMLywy9mknQUatMig2fnWcG2UVyH', SAS_PROGRAM_ID: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111', TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        ASSOCIATED_TOKEN_PROGRAM_ID: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        DEFAULT_PUBKEY: '11111111111111111111111111111111', OFFER_SEED: 'property-offer', MAX_CID_BYTES: 64, MAX_PAYOUTS: 16, MAX_LENS: 8,
        SIDE_BUY: 0, SIDE_SELL: 1, STATUS_OPEN: 0, STATUS_COMMITTED: 1, STATUS_SETTLED: 2, STATUS_CANCELLED: 3, STATUS_EXPIRED: 4,
        ROLE_SELLER_HOLDS: 0, ROLE_BUYER_QUALIFIES: 1,
        DECISION_SCHEMA_NAME: 'PropertyOfferConfirmation', DECISION_SCHEMA_VERSION: 1, SAS_ATTESTATION_DISCRIMINATOR: 2
    });
    const SIDE_NAMES = ['Buy', 'Sell']; const STATUS_NAMES = ['Open', 'Committed', 'Settled', 'Cancelled', 'Expired'];
    let injectedWeb3 = null; let injectedSha256Hex = null; let injectedSha256Bytes = null;
    function web3() { if (injectedWeb3) return injectedWeb3; if (globalThis.solanaWeb3) return globalThis.solanaWeb3; if (typeof require === 'function') try { return require('@solana/web3.js'); } catch (_) { /* not installed: injection is the browser path, reported below */ } throw new Error('configure with @solana/web3.js'); }
    function sha256Hex(text) { if (injectedSha256Hex) return injectedSha256Hex(text); if (globalThis.__consentSha256) return globalThis.__consentSha256.sha256Hex(text); if (typeof require === 'function') return require('crypto').createHash('sha256').update(text).digest('hex'); throw new Error('configure with sha256Hex'); }
    function sha256Bytes(bytes) { if (injectedSha256Bytes) return injectedSha256Bytes(bytes); if (typeof require === 'function') return require('crypto').createHash('sha256').update(bytes).digest(); throw new Error('configure with sha256Bytes to hash binary payout schedules'); }
    function configure(o = {}) { if ('web3' in o) injectedWeb3 = o.web3; if ('sha256Hex' in o) injectedSha256Hex = o.sha256Hex; if ('sha256Bytes' in o) injectedSha256Bytes = o.sha256Bytes; return api; }
    const utf8 = value => new TextEncoder().encode(value);
    function key(value, label) { const { PublicKey } = web3(); try { const k = value instanceof PublicKey ? value : new PublicKey(typeof value === 'string' ? value.trim() : value); if (typeof value === 'string' && k.toBase58() !== value.trim()) throw 0; return k; } catch (_) { throw new Error(`${label} must be a canonical base58 public key`); } }
    function concat(parts) { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let at = 0; for (const p of parts) { o.set(p, at); at += p.length; } return o; }
    function u32(v) { if (!Number.isSafeInteger(v) || v < 0 || v >= 2 ** 32) throw new Error('u32 required'); const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, v, true); return o; }
    function u64(v, label) { const n = BigInt(v); if (n < 0n || n >= 1n << 64n) throw new Error(`${label} must fit u64`); const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, n, true); return o; }
    function i64(v, label) { const n = BigInt(v); if (n < -(1n << 63n) || n >= 1n << 63n) throw new Error(`${label} must fit i64`); const o = new Uint8Array(8); new DataView(o.buffer).setBigInt64(0, n, true); return o; }
    const string = v => { if (typeof v !== 'string') throw new Error('string required'); const b = utf8(v); return concat([u32(b.length), b]); };
    const disc = name => Uint8Array.from(IX_DISCRIMINATORS[name]); const pubkey = (v, label) => Uint8Array.from(key(v, label).toBytes());
    const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
    function requireCid(cid) { if (typeof cid !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(cid)) throw new Error('cid must be 1-64 ASCII letters and digits'); return cid; }
    function hexBytes(value, label) { if (value instanceof Uint8Array && value.length === 32) return value; if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be 32 bytes or 64 hex chars`); return Uint8Array.from(value.match(/../g).map(x => parseInt(x, 16))); }
    function cidSeed(cid) { return hexBytes(sha256Hex(requireCid(cid)), 'sha256'); }
    function getOfferPda(cid, maker, programId = constants.PROPERTY_OFFER_PROGRAM_ID) { const { PublicKey } = web3(); return PublicKey.findProgramAddressSync([utf8(constants.OFFER_SEED), key(maker, 'maker').toBytes(), cidSeed(cid)], key(programId, 'programId')); }
    function sideCode(side) { if (side === 'buy' || side === 'Buy' || side === 0) return 0; if (side === 'sell' || side === 'Sell' || side === 1) return 1; throw new Error('side must be buy or sell'); }
    const isUsdc = currency => { if (currency === 'USDC') return true; if (currency === 'SOL') return false; throw new Error('currency must be SOL or USDC'); };

    // ── Token accounts: the offer's vault and each party's account are associated token accounts ──
    function associatedTokenAddress(owner, mint = constants.USDC_MINT) { const { PublicKey } = web3(); return PublicKey.findProgramAddressSync([key(owner, 'owner').toBytes(), key(constants.TOKEN_PROGRAM_ID, 'token program').toBytes(), key(mint, 'mint').toBytes()], key(constants.ASSOCIATED_TOKEN_PROGRAM_ID, 'associated token program'))[0]; }
    function buildCreateTokenAccountIx({ payer, owner, mint = constants.USDC_MINT }) {
        return ix(constants.ASSOCIATED_TOKEN_PROGRAM_ID, [meta(key(payer, 'payer'), true, true), meta(associatedTokenAddress(owner, mint), false, true), meta(key(owner, 'owner'), false, false),
            meta(key(mint, 'mint'), false, false), meta(system(), false, false), meta(key(constants.TOKEN_PROGRAM_ID, 'token program'), false, false)], Uint8Array.of(1));
    }

    function payoutBytes(payouts, price, required) { if (!Array.isArray(payouts)) throw new Error('payouts must be an array'); if ((required && !payouts.length) || payouts.length > constants.MAX_PAYOUTS) throw new Error('payout schedule must have 1-16 recipients'); let total = 0n; const seen = new Set(); const parts = [u32(payouts.length)]; for (const p of payouts) { const recipient = key(p.recipient, 'payout recipient').toBase58(); if (recipient === constants.DEFAULT_PUBKEY || seen.has(recipient)) throw new Error('payout recipients must be real and unique'); seen.add(recipient); const amount = BigInt(p.amount); if (amount <= 0n) throw new Error('payout amount must be positive'); total += amount; parts.push(pubkey(recipient, 'payout recipient'), u64(amount, 'payout amount')); } if (price !== undefined && total !== BigInt(price)) throw new Error('payout amounts must equal the price'); return concat(parts); }
    // Hash exactly the program's raw `(pubkey[32] || amount LE u64)` sequence (not JSON).
    function payoutScheduleHash(payouts) { const p = payoutBytes(payouts, undefined, false); return Uint8Array.from(sha256Bytes(p.subarray(4))); }
    function lensBytes(lens, threshold, required) { if (!Array.isArray(lens) || lens.length > constants.MAX_LENS || (required && !lens.length)) throw new Error(required ? 'the buyer’s lens needs 1-8 lens members' : 'a lens has 0-8 lens members'); const keys = lens.map(k => key(k, 'lens member').toBase58()); if (new Set(keys).size !== keys.length) throw new Error('lens members must be distinct'); if (!Number.isInteger(threshold) || (keys.length ? threshold < 1 || threshold > keys.length : threshold !== 0)) throw new Error('lens threshold out of range'); return concat([u32(keys.length), ...keys.map(k => pubkey(k, 'lens member')), Uint8Array.of(threshold)]); }
    function encodeCreateData({ cid, side, termsHash, price, deadline, payouts = [], lens = [], lensThreshold } = {}) { const code = sideCode(side); requireCid(cid); if (BigInt(price) <= 0n) throw new Error('price must be positive'); if (BigInt(deadline) <= 0n) throw new Error('deadline must be positive'); if (code === 0 && payouts.length) throw new Error('buy offers get their payouts from the seller'); return concat([disc('create'), string(cid), Uint8Array.of(code), hexBytes(termsHash, 'termsHash'), u64(price, 'price'), i64(deadline, 'deadline'), payoutBytes(payouts, code === 1 ? price : undefined, code === 1), lensBytes(lens, lensThreshold, code === 0)]); }
    function encodeCommitData({ side, payouts = [], lens = [], lensThreshold } = {}) { const code = sideCode(side); return concat([disc('commit'), payoutBytes(payouts, undefined, code === 0), lensBytes(lens, lensThreshold, code === 1)]); }
    const meta = (p, isSigner, isWritable) => ({ pubkey: p, isSigner, isWritable });
    function ix(programId, keys, data) { const { TransactionInstruction } = web3(); return new TransactionInstruction({ programId: key(programId, 'programId'), keys, data: typeof Buffer !== 'undefined' ? Buffer.from(data) : data }); }
    const system = () => key(constants.SYSTEM_PROGRAM_ID, 'system program');
    const tokenProgram = () => key(constants.TOKEN_PROGRAM_ID, 'token program');
    // Anchor reads an optional account given as the program id itself as absent.
    const none = programId => meta(key(programId, 'programId'), false, false);
    function offerKey({ offer, cid, maker, programId }) { if (offer) return key(offer, 'offer'); if (cid && maker) return getOfferPda(cid, maker, programId)[0]; throw new Error('offer, or cid and maker, is required'); }

    /** The maker's transaction: a USDC buy offer also creates the offer's vault and pays the price into it. */
    function buildCreateIxs({ maker, currency, programId = constants.PROPERTY_OFFER_PROGRAM_ID, ...args } = {}) {
        const [offer] = getOfferPda(args.cid, maker, programId); const usdc = isUsdc(currency); const buy = sideCode(args.side) === 0;
        const vault = associatedTokenAddress(offer);
        const keys = [meta(offer, false, true), meta(key(maker, 'maker'), true, true),
            usdc ? meta(key(constants.USDC_MINT, 'mint'), false, false) : none(programId),
            usdc && buy ? meta(associatedTokenAddress(maker), false, true) : none(programId),
            usdc && buy ? meta(vault, false, true) : none(programId),
            usdc && buy ? meta(tokenProgram(), false, false) : none(programId), meta(system(), false, false)];
        const instructions = [...(usdc && buy ? [buildCreateTokenAccountIx({ payer: maker, owner: offer })] : []), ix(programId, keys, encodeCreateData(args))];
        return { offer, instructions };
    }
    /** The counterparty's transaction: a buyer committing to a USDC sale pays the price into the vault. */
    function buildCommitIxs({ offer, cid, maker, counterparty, currency, side, programId = constants.PROPERTY_OFFER_PROGRAM_ID, ...args } = {}) {
        const address = offerKey({ offer, cid, maker, programId }); const usdc = isUsdc(currency); const buyerPays = sideCode(side) === 1;
        const keys = [meta(address, false, true), meta(key(counterparty, 'counterparty'), true, true),
            usdc && buyerPays ? meta(associatedTokenAddress(counterparty), false, true) : none(programId),
            usdc && buyerPays ? meta(associatedTokenAddress(address), false, true) : none(programId),
            usdc && buyerPays ? meta(tokenProgram(), false, false) : none(programId), meta(system(), false, false)];
        return [...(usdc && buyerPays ? [buildCreateTokenAccountIx({ payer: counterparty, owner: address })] : []), ix(programId, keys, encodeCommitData({ side, ...args }))];
    }
    function buildConfirmIx({ offer, cid, maker, attestation, credential, programId = constants.PROPERTY_OFFER_PROGRAM_ID } = {}) { return ix(programId, [meta(offerKey({ offer, cid, maker, programId }), false, true), meta(key(attestation, 'attestation'), false, false), meta(key(credential, 'credential'), false, false)], disc('confirm')); }
    // Recipients are the exact schedule, in order: wallets for SOL, their USDC accounts (created here
    // if missing, paid by `payer`) for USDC. All payouts happen together or none do.
    function buildExecuteIxs({ offer, cid, maker, currency, recipients, payer, programId = constants.PROPERTY_OFFER_PROGRAM_ID } = {}) {
        if (!Array.isArray(recipients) || !recipients.length || recipients.length > constants.MAX_PAYOUTS) throw new Error('recipients must be a non-empty payout list');
        const address = offerKey({ offer, cid, maker, programId }); const usdc = isUsdc(currency);
        const accounts = recipients.map(r => usdc ? associatedTokenAddress(r) : key(r, 'recipient'));
        const execute = ix(programId, [meta(address, false, true), usdc ? meta(associatedTokenAddress(address), false, true) : none(programId), usdc ? meta(tokenProgram(), false, false) : none(programId),
            ...accounts.map(a => meta(a, false, true))], disc('execute'));
        return [...(usdc ? recipients.map(owner => buildCreateTokenAccountIx({ payer, owner })) : []), execute];
    }
    function buildCancelIx({ offer, cid, maker, currency, programId = constants.PROPERTY_OFFER_PROGRAM_ID } = {}) { const address = offerKey({ offer, cid, maker, programId }); const usdc = isUsdc(currency); return ix(programId, [meta(address, false, true), meta(key(maker, 'maker'), true, true), usdc ? meta(associatedTokenAddress(address), false, true) : none(programId), usdc ? meta(associatedTokenAddress(maker), false, true) : none(programId), usdc ? meta(tokenProgram(), false, false) : none(programId)], disc('cancel')); }
    function buildExpireIx({ offer, cid, maker, currency, buyer, programId = constants.PROPERTY_OFFER_PROGRAM_ID } = {}) { const address = offerKey({ offer, cid, maker, programId }); const usdc = isUsdc(currency); return ix(programId, [meta(address, false, true), meta(usdc ? associatedTokenAddress(buyer) : key(buyer, 'buyer'), false, true), usdc ? meta(associatedTokenAddress(address), false, true) : none(programId), usdc ? meta(tokenProgram(), false, false) : none(programId)], disc('expire')); }

    function reader(bytes, start = 0) { const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let at = start; const take = (n, l) => { if (at + n > bytes.length) throw new RangeError(`truncated ${l}`); const x = bytes.slice(at, at + n); at += n; return x; }; return { u8: l => take(1, l)[0], u32: l => { if (at + 4 > bytes.length) throw new RangeError(`truncated ${l}`); const n = v.getUint32(at, true); at += 4; return n; }, u64: l => { if (at + 8 > bytes.length) throw new RangeError(`truncated ${l}`); const n = v.getBigUint64(at, true); at += 8; return n; }, i64: l => { if (at + 8 > bytes.length) throw new RangeError(`truncated ${l}`); const n = v.getBigInt64(at, true); at += 8; return n; }, bytes: take, key: l => new (web3().PublicKey)(take(32, l)).toBase58(), string(l) { return new TextDecoder().decode(take(this.u32(`${l} length`), l)); }, pos: () => at }; }
    function readLens(r, label) { const members = Array.from({ length: constants.MAX_LENS }, () => r.key(`${label} member`)); const count = r.u8(`${label} count`), threshold = r.u8(`${label} threshold`), confirmed = r.u8(`${label} confirmed`); const list = members.slice(0, count); return { members: list, threshold, confirmed: list.filter((_, i) => confirmed & (1 << i)), met: list.filter((_, i) => confirmed & (1 << i)).length >= threshold }; }
    function readPropertyOffer(data, address = null) {
        const b = data instanceof Uint8Array ? data : Uint8Array.from(data || []); if (b.length < 8 || !ACCOUNT_DISCRIMINATORS.PropertyOffer.every((x, i) => b[i] === x)) return null;
        const r = reader(b, 8);
        const offer = { address, maker: r.key('maker'), buyer: r.key('buyer'), seller: r.key('seller'), mint: r.key('mint'), sideCode: r.u8('side'), statusCode: r.u8('status'), price: r.u64('price'), escrow: r.u64('escrow'),
            deadline: r.i64('deadline'), createdAt: r.i64('created'), committedAt: r.i64('committed'), settledAt: r.i64('settled'), termsHash: hex(r.bytes(32, 'terms hash')), payoutsHash: hex(r.bytes(32, 'payout hash')) };
        offer.buyerLens = readLens(r, 'buyer lens'); offer.sellerLens = readLens(r, 'seller lens');
        const count = r.u32('payout count'); if (count > constants.MAX_PAYOUTS) throw new RangeError('too many payouts');
        offer.payouts = Array.from({ length: count }, () => ({ recipient: r.key('recipient'), amount: r.u64('amount') }));
        offer.bump = r.u8('bump'); offer.cid = r.string('cid');
        offer.currency = offer.mint === constants.DEFAULT_PUBKEY ? 'SOL' : offer.mint === constants.USDC_MINT ? 'USDC' : 'unknown';
        offer.side = SIDE_NAMES[offer.sideCode] || `Unknown(${offer.sideCode})`; offer.status = STATUS_NAMES[offer.statusCode] || `Unknown(${offer.statusCode})`;
        for (const party of ['buyer', 'seller']) if (offer[party] === constants.DEFAULT_PUBKEY) offer[party] = null;
        return offer;
    }

    // ── Lens member decisions (PropertyOfferConfirmation-v1) ──
    /** Payload (borsh) in the program's order; `holding` is empty for a buyer qualification. */
    function encodeDecisionPayload({ cid, offer, termsHash, payoutsHash, buyer, seller, role, assetHash, holding = '', observedAt }) {
        if (role !== 0 && role !== 1) throw new Error('role is 0 (seller holds) or 1 (buyer qualifies)');
        return concat([string(requireCid(cid)), string(key(offer, 'offer').toBase58()), string(hex(hexBytes(termsHash, 'termsHash'))), string(hex(hexBytes(payoutsHash, 'payoutsHash'))),
            string(key(buyer, 'buyer').toBase58()), string(key(seller, 'seller').toBase58()), Uint8Array.of(role), string(hex(hexBytes(assetHash, 'assetHash'))), string(holding), i64(observedAt, 'observedAt')]);
    }
    // The attestation's nonce fixes its address. A lens member's confirmation that a seller holds an
    // asset depends only on the asset and the holding it sells, so the same member cannot confirm
    // a second sale of that holding (SAS refuses an existing address) until it withdraws the first.
    function decisionNonce({ role, assetHash, holding, offer }) {
        const material = role === 0 ? JSON.stringify(['property-offer-sale/v1', hex(hexBytes(assetHash, 'assetHash')), String(holding || '')])
            : JSON.stringify(['property-offer-buyer/v1', key(offer, 'offer').toBase58()]);
        return new (web3().PublicKey)(hexBytes(sha256Hex(material), 'nonce')).toBase58();
    }
    function readDecisionAttestation(data, address = null) {
        const b = data instanceof Uint8Array ? data : Uint8Array.from(data || []); if (b[0] !== constants.SAS_ATTESTATION_DISCRIMINATOR) throw new Error('not a SAS attestation');
        const r = reader(b, 1); const nonce = r.key('nonce'), credential = r.key('credential'), schema = r.key('schema'), payload = r.bytes(r.u32('payload length'), 'payload'), signer = r.key('signer'), expiry = r.i64('expiry');
        const p = reader(payload);
        const fields = { cid: p.string('cid'), offer: p.string('offer'), termsHash: p.string('terms hash'), payoutsHash: p.string('payout hash'), buyer: p.string('buyer'), seller: p.string('seller'), role: p.u8('role'), assetHash: p.string('asset'), holding: p.string('holding'), observedAt: p.i64('observed') };
        if (!/^[0-9a-f]{64}$/.test(fields.termsHash) || !/^[0-9a-f]{64}$/.test(fields.payoutsHash) || !/^[0-9a-f]{64}$/.test(fields.assetHash) || fields.role > 1 || p.pos() !== payload.length) throw new RangeError('invalid PropertyOfferConfirmation payload');
        return { address, nonce, credential, schema, signer, expiry, fields };
    }
    function getDecisionSchemaPda(credential) { return web3().PublicKey.findProgramAddressSync([utf8('schema'), key(credential, 'credential').toBytes(), utf8(constants.DECISION_SCHEMA_NAME), Uint8Array.of(constants.DECISION_SCHEMA_VERSION)], key(constants.SAS_PROGRAM_ID, 'SAS program')); }
    function validateDecisionSchema({ credential, authority, credentialInfo, schemaInfo }) {
        const sas = key(constants.SAS_PROGRAM_ID, 'SAS program');
        for (const info of [credentialInfo, schemaInfo]) if (!info || !key(info.owner, 'account owner').equals(sas)) throw new Error('The lens credential or schema is not registered on this network.');
        const c = new Uint8Array(credentialInfo.data), s = new Uint8Array(schemaInfo.data);
        if (c.length < 33 || c[0] !== 0 || !key(c.slice(1, 33), 'credential authority').equals(key(authority, 'lens member'))) throw new Error('The SAS credential belongs to another lens member.');
        if (s.length < 33 || s[0] !== 1 || !key(s.slice(1, 33), 'schema credential').equals(key(credential, 'credential'))) throw new Error('The SAS schema belongs to another credential.');
        let at = 33; const view = new DataView(s.buffer, s.byteOffset, s.byteLength);
        for (let i = 0; i < 4; i++) { if (at + 4 > s.length) throw new Error('Truncated SAS schema.'); const size = view.getUint32(at, true); at += 4 + size; if (at > s.length) throw new Error('Truncated SAS schema.'); }
        if (at + 2 > s.length || s[at] !== 0) throw new Error('The SAS schema is paused or invalid.');
        return true;
    }
    async function fetchPropertyOffer(connection, { address, cid, maker, programId = constants.PROPERTY_OFFER_PROGRAM_ID } = {}) { const a = address ? key(address, 'address') : offerKey({ cid, maker, programId }); const info = await connection.getAccountInfo(a, 'confirmed'); if (!info) return null; if (!key(info.owner, 'owner').equals(key(programId, 'programId'))) throw new Error('account belongs to another program'); const value = readPropertyOffer(new Uint8Array(info.data), a.toBase58()); if (!value) throw new Error('not a PropertyOffer account'); return value; }
    const api = { constants, IX_DISCRIMINATORS, ACCOUNT_DISCRIMINATORS, SIDE_NAMES, STATUS_NAMES, configure, requireCid, cidSeed, getOfferPda, associatedTokenAddress, buildCreateTokenAccountIx, payoutScheduleHash,
        encodeCreateData, encodeCommitData, buildCreateIxs, buildCommitIxs, buildConfirmIx, buildExecuteIxs, buildCancelIx, buildExpireIx,
        readPropertyOffer, encodeDecisionPayload, decisionNonce, readDecisionAttestation, getDecisionSchemaPda, validateDecisionSchema, fetchPropertyOffer };
    return api;
});
