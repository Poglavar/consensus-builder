// Pure codec for proposal_market's LMSR instructions and accounts. This follows the on-chain
// LmsrMarket/Position layouts and the creator-bound PDA namespaces in lmsr-market.md.
(function attachSolanaLmsrClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaLmsrClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function solanaLmsrClientFactory() {
    'use strict';

    const PROGRAM_ID = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
    const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
    const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
    const SIDE_NO = 0;
    const SIDE_YES = 1;
    const OUTCOME_VOID = 2;
    const MAX_U64 = (1n << 64n) - 1n;
    const MAX_LIQUIDITY = 10_000_000_000_000_000n;
    const IX_DISCRIMINATORS = Object.freeze({
        create_lmsr_market: [146, 102, 81, 28, 218, 109, 141, 123],
        create_lmsr_external_market: [171, 209, 167, 58, 63, 121, 215, 243],
        buy: [102, 6, 61, 18, 1, 218, 235, 234],
        sell: [51, 230, 133, 164, 1, 127, 131, 173],
        resolve_lmsr: [206, 85, 180, 136, 108, 221, 51, 137],
        claim_lmsr: [9, 189, 203, 138, 25, 243, 194, 56],
        reclaim_seed: [200, 42, 222, 46, 108, 131, 168, 149]
    });
    const ACCOUNT_DISCRIMINATORS = Object.freeze({
        LmsrMarket: [179, 6, 25, 24, 222, 242, 91, 132],
        Position: [170, 188, 143, 228, 122, 64, 247, 208]
    });
    const MARKET_SIZE = 496;
    const POSITION_SIZE = 83;
    const constants = Object.freeze({ PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
        SIDE_NO, SIDE_YES, OUTCOME_VOID, KIND_PROPOSAL: 0, KIND_RECIPE: 1 });
    const encoder = new TextEncoder();
    let injectedWeb3 = null;
    let programIdOverride = null;

    function resolveWeb3() {
        if (injectedWeb3) return injectedWeb3;
        const scope = typeof globalThis !== 'undefined' ? globalThis : null;
        if (scope?.solanaWeb3?.PublicKey) return scope.solanaWeb3;
        if (typeof require === 'function') {
            try { const loaded = require('@solana/web3.js'); if (loaded?.PublicKey) return loaded; } catch (_) { /* injection is the browser path */ }
        }
        throw new Error('solana-web3 is unavailable; pass web3 to configure().');
    }

    function configure(options) {
        const opts = options || {};
        if (Object.prototype.hasOwnProperty.call(opts, 'web3')) injectedWeb3 = opts.web3 || null;
        if (Object.prototype.hasOwnProperty.call(opts, 'programId')) programIdOverride = opts.programId || null;
        return api;
    }

    function key(value, label) {
        const web3 = resolveWeb3();
        if (value instanceof web3.PublicKey) return value;
        if (typeof value === 'string' && value) return new web3.PublicKey(value);
        if (value && typeof value.toBase58 === 'function') return new web3.PublicKey(value.toBase58());
        if (value instanceof Uint8Array || Array.isArray(value)) return new web3.PublicKey(value);
        throw new Error(`${label || 'address'} must be a PublicKey or base58 address`);
    }
    function programKey(id) { return key(id || programIdOverride || PROGRAM_ID, 'programId'); }
    function bytes(value, label) {
        if (value instanceof Uint8Array) return value;
        if (Array.isArray(value)) return Uint8Array.from(value);
        if (typeof value === 'string') {
            const hex = value.trim().replace(/^sha256:/i, '');
            if (/^[a-f\d]{64}$/i.test(hex)) return Uint8Array.from(hex.match(/../g).map(x => parseInt(x, 16)));
        }
        throw new Error(`${label} must be 32 bytes or 64 hex characters`);
    }
    function checkedHash(value, label) {
        const out = bytes(value, label);
        if (out.length !== 32) throw new Error(`${label} must be exactly 32 bytes`);
        return Uint8Array.from(out);
    }
    function u64(value, label) {
        let n;
        if (typeof value === 'bigint') n = value;
        else if (typeof value === 'string' && /^\d+$/.test(value.trim())) n = BigInt(value.trim());
        else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
        else throw new Error(`${label} must be a bigint, digit string, or safe integer`);
        if (n < 0n || n > MAX_U64) throw new Error(`${label} does not fit in u64`);
        return n;
    }
    function positiveU64(value, label) {
        const n = u64(value, label);
        if (n === 0n) throw new Error(`${label} must be positive`);
        return n;
    }
    function i64(value, label) {
        let n;
        if (typeof value === 'bigint') n = value;
        else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) n = BigInt(value.trim());
        else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
        else throw new Error(`${label} must be a bigint, integer string, or safe integer`);
        if (n < -(1n << 63n) || n > (1n << 63n) - 1n) throw new Error(`${label} does not fit in i64`);
        return n;
    }
    function u32(value, label) {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${label} does not fit in u32`);
        return value;
    }
    function side(value) {
        const n = Number(value);
        if (n !== SIDE_NO && n !== SIDE_YES) throw new Error('side must be 0 (NO) or 1 (YES)');
        return n;
    }
    function le(n, size, signed) {
        const out = new Uint8Array(size);
        const view = new DataView(out.buffer);
        if (size === 1) view.setUint8(0, n);
        else if (size === 4) view.setUint32(0, n, true);
        else if (signed) view.setBigInt64(0, n, true);
        else view.setBigUint64(0, n, true);
        return out;
    }
    function cat(parts) {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const part of parts) { out.set(part, at); at += part.length; }
        return out;
    }
    function seedText(value) { return encoder.encode(value); }
    function getMarketPda(proposal, creator, id) {
        const web3 = resolveWeb3();
        return web3.PublicKey.findProgramAddressSync([seedText('lmsr'), key(proposal, 'proposal').toBytes(), key(creator, 'creator').toBytes()], programKey(id));
    }
    function getExternalMarketPda(recipeHash, creator, id) {
        const web3 = resolveWeb3();
        return web3.PublicKey.findProgramAddressSync([seedText('lmsr_recipe'), checkedHash(recipeHash, 'recipeHash'), key(creator, 'creator').toBytes()], programKey(id));
    }
    function getPositionPda(market, owner, value, id) {
        const web3 = resolveWeb3();
        return web3.PublicKey.findProgramAddressSync([seedText('lmsr_position'), key(market, 'market').toBytes(), key(owner, 'owner').toBytes(), le(side(value), 1)], programKey(id));
    }
    function getAssociatedTokenAddress(owner, mint) {
        const web3 = resolveWeb3();
        return web3.PublicKey.findProgramAddressSync([
            key(owner, 'owner').toBytes(), key(TOKEN_PROGRAM_ID).toBytes(), key(mint, 'stakeMint').toBytes()
        ], key(ASSOCIATED_TOKEN_PROGRAM_ID))[0];
    }
    const getVaultAddress = (market, mint) => getAssociatedTokenAddress(market, mint);
    const meta = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
    function ix(name, keys, data, id) {
        const web3 = resolveWeb3();
        return new web3.TransactionInstruction({ programId: programKey(id), keys, data });
    }
    const disc = name => Uint8Array.from(IX_DISCRIMINATORS[name]);
    function marketFor(opts, kind) {
        if (opts.market) return key(opts.market, 'market');
        if (kind === 0) return getMarketPda(opts.proposal, opts.creator, opts.programId)[0];
        return getExternalMarketPda(opts.recipeHash, opts.creator, opts.programId)[0];
    }
    function buildCreateLmsrMarketIx(options) {
        const o = options || {};
        const proposal = key(o.proposal, 'proposal'); const creator = key(o.creator, 'creator'); const mint = key(o.stakeMint, 'stakeMint');
        const market = marketFor(o, 0);
        const web3 = resolveWeb3();
        const keys = [meta(market, false, true), meta(proposal), meta(mint), meta(getVaultAddress(market, mint), false, true),
            meta(getAssociatedTokenAddress(creator, mint), false, true), meta(creator, true, true), meta(key(TOKEN_PROGRAM_ID)),
            meta(key(ASSOCIATED_TOKEN_PROGRAM_ID)), meta(web3.SystemProgram?.programId || key(SYSTEM_PROGRAM_ID))];
        const liquidity = positiveU64(o.b, 'b');
        if (liquidity > MAX_LIQUIDITY) throw new Error('b exceeds the LMSR liquidity limit');
        const data = cat([disc('create_lmsr_market'), le(liquidity, 8), le(i64(o.closesAt, 'closesAt'), 8, true),
            le(u32(o.graceSeconds ?? 0, 'graceSeconds'), 4), le(u64(o.maxPosition ?? 0n, 'maxPosition'), 8)]);
        return ix('create_lmsr_market', keys, data, o.programId);
    }
    function buildCreateLmsrExternalMarketIx(options) {
        const o = options || {}; const creator = key(o.creator, 'creator'); const mint = key(o.stakeMint, 'stakeMint');
        const market = marketFor(o, 1); const web3 = resolveWeb3();
        const keys = [meta(market, false, true), meta(mint), meta(getVaultAddress(market, mint), false, true),
            meta(key(o.credential, 'credential')), meta(key(o.schema, 'schema')),
            meta(getAssociatedTokenAddress(creator, mint), false, true), meta(creator, true, true), meta(key(TOKEN_PROGRAM_ID)),
            meta(key(ASSOCIATED_TOKEN_PROGRAM_ID)), meta(web3.SystemProgram?.programId || key(SYSTEM_PROGRAM_ID))];
        if (o.proposal) keys.push(meta(key(o.proposal, 'proposal')));
        const liquidity = positiveU64(o.b, 'b');
        if (liquidity > MAX_LIQUIDITY) throw new Error('b exceeds the LMSR liquidity limit');
        const hashes = [checkedHash(o.recipeHash, 'recipeHash'), checkedHash(o.subjectHash, 'subjectHash'),
            checkedHash(o.yesValueHash, 'yesValueHash'), checkedHash(o.noValueHash, 'noValueHash')];
        if (hashes.some(hash => hash.every(byte => byte === 0))) throw new Error('kind 1 commitments must be nonzero');
        if (hashes[2].every((byte, index) => byte === hashes[3][index])) throw new Error('YES and NO commitments must differ');
        if (key(o.trustedAttester, 'trustedAttester').equals(key(SYSTEM_PROGRAM_ID))) throw new Error('trustedAttester must be nonzero');
        const data = cat([disc('create_lmsr_external_market'), ...hashes, key(o.trustedAttester, 'trustedAttester').toBytes(),
            le(liquidity, 8), le(i64(o.closesAt, 'closesAt'), 8, true), le(u32(o.graceSeconds ?? 0, 'graceSeconds'), 4),
            le(u64(o.maxPosition ?? 0n, 'maxPosition'), 8)]);
        return ix('create_lmsr_external_market', keys, data, o.programId);
    }
    function marketAndSubject(o) {
        const market = key(o.market || marketFor(o, o.recipeHash ? 1 : 0), 'market');
        const proposal = key(o.proposal || SYSTEM_PROGRAM_ID, 'proposal');
        const mint = key(o.stakeMint, 'stakeMint');
        return { market, proposal, mint };
    }
    function buildBuyIx(options) {
        const o = options || {}; const { market, proposal, mint } = marketAndSubject(o); const owner = key(o.owner, 'owner'); const s = side(o.side);
        const web3 = resolveWeb3(); const [position] = getPositionPda(market, owner, s, o.programId);
        const keys = [meta(market, false, true), meta(proposal), meta(position, false, true), meta(getVaultAddress(market, mint), false, true),
            meta(getAssociatedTokenAddress(owner, mint), false, true), meta(owner, true, true), meta(key(TOKEN_PROGRAM_ID)),
            meta(web3.SystemProgram?.programId || key(SYSTEM_PROGRAM_ID))];
        return ix('buy', keys, cat([disc('buy'), le(s, 1), le(positiveU64(o.shares, 'shares'), 8), le(u64(o.maxCost, 'maxCost'), 8)]), o.programId);
    }
    function buildSellIx(options) {
        const o = options || {}; const { market, proposal, mint } = marketAndSubject(o); const owner = key(o.owner, 'owner'); const s = side(o.side);
        const [position] = getPositionPda(market, owner, s, o.programId);
        const keys = [meta(market, false, true), meta(proposal), meta(position, false, true), meta(getVaultAddress(market, mint), false, true),
            meta(getAssociatedTokenAddress(owner, mint), false, true), meta(owner, true), meta(key(TOKEN_PROGRAM_ID))];
        return ix('sell', keys, cat([disc('sell'), le(s, 1), le(positiveU64(o.shares, 'shares'), 8), le(u64(o.minReturn, 'minReturn'), 8)]), o.programId);
    }
    function buildResolveLmsrIx(options) {
        const o = options || {}; const { market, proposal } = marketAndSubject({ ...o, stakeMint: o.stakeMint || key(TOKEN_PROGRAM_ID) });
        const schema = key(o.schema || SYSTEM_PROGRAM_ID, 'schema');
        const keys = [meta(market, false, true), meta(proposal), meta(schema)];
        for (const account of (o.evidence || [])) keys.push(meta(key(account, 'evidence')));
        return ix('resolve_lmsr', keys, disc('resolve_lmsr'), o.programId);
    }
    function buildClaimLmsrIx(options) {
        const o = options || {}; const market = key(o.market, 'market'); const owner = key(o.owner, 'owner'); const mint = key(o.stakeMint, 'stakeMint');
        const s = side(o.side); const [position] = getPositionPda(market, owner, s, o.programId);
        const keys = [meta(market, false, true), meta(position, false, true), meta(getVaultAddress(market, mint), false, true),
            meta(getAssociatedTokenAddress(owner, mint), false, true), meta(owner, true, false), meta(key(TOKEN_PROGRAM_ID))];
        return ix('claim_lmsr', keys, disc('claim_lmsr'), o.programId);
    }
    function buildReclaimSeedIx(options) {
        const o = options || {}; const market = key(o.market, 'market'); const creator = key(o.creator, 'creator'); const mint = key(o.stakeMint, 'stakeMint');
        const keys = [meta(market), meta(getVaultAddress(market, mint), false, true), meta(getAssociatedTokenAddress(creator, mint), false, true),
            meta(creator, true, false), meta(key(TOKEN_PROGRAM_ID))];
        return ix('reclaim_seed', keys, disc('reclaim_seed'), o.programId);
    }
    function checkDisc(data, expected, label, size) {
        if (data.length < size) throw new Error(`${label} account is ${data.length} bytes, expected at least ${size}`);
        for (let i = 0; i < 8; i += 1) if (data[i] !== expected[i]) throw new Error(`${label} discriminator mismatch`);
    }
    function pubkey(data, offset) { return new (resolveWeb3().PublicKey)(data.slice(offset, offset + 32)).toBase58(); }
    function read64(data, offset, signed = false) { const d = new DataView(data.buffer, data.byteOffset + offset, 8); return signed ? d.getBigInt64(0, true) : d.getBigUint64(0, true); }
    function decodeMarket(input) {
        const data = input instanceof Uint8Array ? input : new Uint8Array(input);
        checkDisc(data, ACCOUNT_DISCRIMINATORS.LmsrMarket, 'LmsrMarket', MARKET_SIZE);
        let o = 8; const kind = data[o++]; const proposal = pubkey(data, o); o += 32; const creator = pubkey(data, o); o += 32;
        const stakeMint = pubkey(data, o); o += 32; const vault = pubkey(data, o); o += 32;
        const b = read64(data, o); o += 8; const qYes = read64(data, o); o += 8; const qNo = read64(data, o); o += 8; const seed = read64(data, o); o += 8;
        const closesAt = read64(data, o, true); o += 8; const graceSeconds = new DataView(data.buffer, data.byteOffset + o, 4).getUint32(0, true); o += 4;
        const maxPosition = read64(data, o); o += 8; const recipeHash = data.slice(o, o + 32); o += 32; const subjectHash = data.slice(o, o + 32); o += 32;
        const yesValueHash = data.slice(o, o + 32); o += 32; const noValueHash = data.slice(o, o + 32); o += 32;
        const credential = pubkey(data, o); o += 32; const schema = pubkey(data, o); o += 32; const trustedAttester = pubkey(data, o); o += 32;
        const resolvedByte = data[o++]; if (resolvedByte > 1) throw new Error('LmsrMarket resolved bool is invalid'); const resolved = resolvedByte === 1;
        const outcome = data[o++]; const resolvedAt = read64(data, o, true); o += 8; const evidence = pubkey(data, o); o += 32;
        const evidenceHash = data.slice(o, o + 32); o += 32; const paidOut = read64(data, o); o += 8; const bump = data[o];
        if (kind !== 0 && kind !== 1) throw new Error('LmsrMarket kind is invalid');
        if (outcome > OUTCOME_VOID) throw new Error('LmsrMarket outcome is invalid');
        if (b === 0n || b > MAX_LIQUIDITY) throw new Error('LmsrMarket liquidity is out of bounds');
        return { kind, proposal, creator, stakeMint, vault, b, qYes, qNo, seed, closesAt, graceSeconds, maxPosition,
            recipeHash, subjectHash, yesValueHash, noValueHash, credential, schema, trustedAttester, resolved, outcome,
            resolvedAt, evidence, evidenceHash, paidOut, bump };
    }
    function decodePosition(input) {
        const data = input instanceof Uint8Array ? input : new Uint8Array(input);
        checkDisc(data, ACCOUNT_DISCRIMINATORS.Position, 'Position', POSITION_SIZE);
        const market = pubkey(data, 8); const owner = pubkey(data, 40); const sideValue = data[72];
        if (sideValue !== SIDE_NO && sideValue !== SIDE_YES) throw new Error('Position side is invalid');
        if (data[81] > 1) throw new Error('Position claimed bool is invalid');
        return { market, owner, side: sideValue, amount: read64(data, 73), claimed: data[81] === 1, bump: data[82] };
    }
    function assertOwner(info, id) {
        if (!info?.owner || !key(info.owner, 'account owner').equals(programKey(id))) throw new Error('LMSR account belongs to another program');
    }
    async function readMarket(connection, address, id) {
        if (!connection?.getAccountInfo) throw new Error('a Solana connection is required');
        const requested = key(address, 'market'); const info = await connection.getAccountInfo(requested);
        return readMarketAccount(info, requested, id);
    }
    function readMarketAccount(info, address, id) {
        if (!info?.data) return null;
        const requested = key(address, 'market');
        assertOwner(info, id); const market = decodeMarket(info.data);
        const [expected] = market.kind === 0
            ? getMarketPda(market.proposal, market.creator, id)
            : getExternalMarketPda(market.recipeHash, market.creator, id);
        if (!expected.equals(requested)) throw new Error('LMSR market address does not match its kind, identity and creator');
        if (!getVaultAddress(requested, market.stakeMint).equals(key(market.vault, 'vault'))) throw new Error('LMSR market vault does not match its mint and market');
        return market;
    }
    async function readPosition(connection, market, owner, positionSide, id) {
        if (!connection?.getAccountInfo) throw new Error('a Solana connection is required');
        const [address] = getPositionPda(market, owner, positionSide, id);
        const info = await connection.getAccountInfo(address);
        return readPositionAccount(info, market, owner, positionSide, id);
    }
    function readPositionAccount(info, market, owner, positionSide, id) {
        if (!info?.data) return null;
        assertOwner(info, id); const position = decodePosition(info.data);
        if (position.market !== key(market, 'market').toBase58() || position.owner !== key(owner, 'owner').toBase58() || position.side !== side(positionSide)) {
            throw new Error('LMSR position does not match the requested market, owner and side');
        }
        return position;
    }
    const api = { constants, IX_DISCRIMINATORS, ACCOUNT_DISCRIMINATORS, MARKET_SIZE, POSITION_SIZE, configure,
        getMarketPda, getExternalMarketPda, getPositionPda, getAssociatedTokenAddress, getVaultAddress,
        buildCreateLmsrMarketIx, buildCreateLmsrExternalMarketIx, buildBuyIx, buildSellIx, buildResolveLmsrIx,
        buildClaimLmsrIx, buildReclaimSeedIx, decodeMarket, decodePosition, readMarket, readMarketAccount, readPosition, readPositionAccount };
    return api;
});
