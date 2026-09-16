// Pure client codec for the proposal_market Anchor program (blockchain/solana/programs/
// proposal_market): PDA derivation, byte-exact Anchor/borsh instruction encoding, account decoding
// and the BigInt mirror of the on-chain parimutuel payout math. No DOM and no network of its own —
// readMarket/readPosition take a connection, everything else is synchronous and side-effect free.
(function attachSolanaMarketClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaMarketClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function solanaMarketClientFactory() {
    'use strict';

    // Discriminators are COPIED from blockchain/solana/idl/proposal_market.json, never computed at
    // runtime: the browser has no synchronous sha256, and a hardcoded table is what a test can pin
    // against both the IDL file and sha256("global:<name>") / sha256("account:<Name>").
    const IX_DISCRIMINATORS = Object.freeze({
        create_market: Object.freeze([103, 226, 97, 235, 200, 188, 251, 254]),
        stake: Object.freeze([206, 176, 202, 18, 200, 209, 179, 108]),
        resolve: Object.freeze([246, 150, 236, 206, 108, 63, 58, 10]),
        claim: Object.freeze([62, 198, 214, 193, 213, 159, 108, 210])
    });

    const ACCOUNT_DISCRIMINATORS = Object.freeze({
        Market: Object.freeze([219, 190, 213, 55, 0, 227, 198, 154]),
        Position: Object.freeze([170, 188, 143, 228, 122, 64, 247, 208])
    });

    const constants = Object.freeze({
        SIDE_NO: 0,
        SIDE_YES: 1,
        PROGRAM_ID: 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB',
        TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        ASSOCIATED_TOKEN_PROGRAM_ID: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111'
    });

    const MARKET_SEED = 'market';
    const POSITION_SEED = 'position';

    const PUBKEY_BYTES = 32;
    const DISCRIMINATOR_BYTES = 8;
    // 8 disc + 3 pubkeys + 2 u64 + bool + u8 + u8, matching Market::INIT_SPACE.
    const MARKET_SIZE = DISCRIMINATOR_BYTES + 3 * PUBKEY_BYTES + 8 + 8 + 1 + 1 + 1;
    // 8 disc + 2 pubkeys + u8 + u64 + bool + u8, matching Position::INIT_SPACE.
    const POSITION_SIZE = DISCRIMINATOR_BYTES + 2 * PUBKEY_BYTES + 1 + 8 + 1 + 1;

    const MAX_U64 = (1n << 64n) - 1n;

    let injectedWeb3 = null;
    let programIdOverride = null;

    // The solana-web3 implementation, resolved lazily so the module can be loaded (and unit-tested)
    // without one: injected first, then the browser's vendored IIFE build, then the node package.
    function resolveWeb3() {
        if (injectedWeb3) return injectedWeb3;
        const scope = typeof globalThis !== 'undefined' ? globalThis : null;
        if (scope && scope.solanaWeb3 && scope.solanaWeb3.PublicKey) return scope.solanaWeb3;
        if (typeof require === 'function') {
            // Resolution is relative to THIS file, so a consumer whose node_modules sits elsewhere
            // (the backend's, for instance) has to inject the implementation instead.
            let loaded = null;
            try { loaded = require('@solana/web3.js'); } catch (_) { loaded = null; }
            if (loaded && loaded.PublicKey) return loaded;
        }
        throw new Error('solana-web3 is not available: pass one to SolanaMarketClient.configure({ web3 }), load the vendored solanaWeb3 build, or install @solana/web3.js next to this file');
    }

    function configure(options) {
        const opts = options || {};
        if (Object.prototype.hasOwnProperty.call(opts, 'web3')) injectedWeb3 = opts.web3 || null;
        if (Object.prototype.hasOwnProperty.call(opts, 'programId')) programIdOverride = opts.programId || null;
        return api;
    }

    function utf8(text) {
        return new TextEncoder().encode(text);
    }

    function concatBytes(chunks) {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    function toBytes(value, label) {
        if (value instanceof Uint8Array) return value;
        if (value && typeof value === 'object' && typeof value.byteLength === 'number' && typeof value.byteOffset === 'number' && value.buffer) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        if (Array.isArray(value)) return Uint8Array.from(value);
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        throw new Error(`${label || 'value'} must be a byte array`);
    }

    function toPublicKey(value, label) {
        const web3 = resolveWeb3();
        if (value === null || value === undefined || value === '') throw new Error(`${label || 'address'} is required`);
        if (value instanceof web3.PublicKey) return value;
        if (typeof value === 'string') return new web3.PublicKey(value);
        if (typeof value.toBase58 === 'function') return new web3.PublicKey(value.toBase58());
        if (value instanceof Uint8Array || Array.isArray(value)) return new web3.PublicKey(value);
        throw new Error(`${label || 'address'} must be a base58 address or a PublicKey`);
    }

    function programKey(programId) {
        return toPublicKey(programId || programIdOverride || constants.PROGRAM_ID, 'programId');
    }

    function normalizeSide(side) {
        const value = typeof side === 'bigint' ? Number(side) : Number(side);
        if (value !== constants.SIDE_NO && value !== constants.SIDE_YES) {
            throw new Error('side must be 0 (NO) or 1 (YES)');
        }
        return value;
    }

    // Atomic-unit u64: bigint, safe integer number, or a plain digit string. Anything fractional,
    // negative or above u64 is a caller bug and throws rather than silently truncating.
    function toU64(value, label) {
        const name = label || 'amount';
        let parsed;
        if (typeof value === 'bigint') {
            parsed = value;
        } else if (typeof value === 'number') {
            if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${name} must be an integer number of atomic units`);
            if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the safe integer range — pass a bigint or a string`);
            parsed = BigInt(value);
        } else if (typeof value === 'string') {
            const text = value.trim();
            if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer number of atomic units`);
            parsed = BigInt(text);
        } else {
            throw new Error(`${name} must be a bigint, integer number or digit string`);
        }
        if (parsed < 0n) throw new Error(`${name} cannot be negative`);
        if (parsed > MAX_U64) throw new Error(`${name} does not fit in a u64`);
        return parsed;
    }

    function encodeU64(value) {
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigUint64(0, value, true);
        return out;
    }

    function readU64(bytes, offset) {
        return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
    }

    function discriminatorBytes(table, name) {
        const entry = table[name];
        if (!entry) throw new Error(`unknown discriminator: ${name}`);
        return Uint8Array.from(entry);
    }

    function matchesDiscriminator(bytes, expected) {
        for (let i = 0; i < DISCRIMINATOR_BYTES; i += 1) {
            if (bytes[i] !== expected[i]) return false;
        }
        return true;
    }

    function getMarketPda(proposal, programId) {
        const web3 = resolveWeb3();
        const proposalKey = toPublicKey(proposal, 'proposal');
        return web3.PublicKey.findProgramAddressSync(
            [utf8(MARKET_SEED), proposalKey.toBytes()],
            programKey(programId)
        );
    }

    function getPositionPda(market, owner, side, programId) {
        const web3 = resolveWeb3();
        const marketKey = toPublicKey(market, 'market');
        const ownerKey = toPublicKey(owner, 'owner');
        return web3.PublicKey.findProgramAddressSync(
            [utf8(POSITION_SEED), marketKey.toBytes(), ownerKey.toBytes(), Uint8Array.from([normalizeSide(side)])],
            programKey(programId)
        );
    }

    // Associated token address of (mint, owner). findProgramAddressSync places no on-curve
    // requirement on the seeds, so this is the "allow owner off curve" form and works for the
    // market PDA that owns the vault.
    function deriveAssociatedTokenAddress(owner, mint) {
        const web3 = resolveWeb3();
        const ownerKey = toPublicKey(owner, 'owner');
        const mintKey = toPublicKey(mint, 'mint');
        const [address] = web3.PublicKey.findProgramAddressSync(
            [ownerKey.toBytes(), toPublicKey(constants.TOKEN_PROGRAM_ID).toBytes(), mintKey.toBytes()],
            toPublicKey(constants.ASSOCIATED_TOKEN_PROGRAM_ID)
        );
        return address;
    }

    function getVaultAddress(market, mint) {
        return deriveAssociatedTokenAddress(market, mint);
    }

    function getAssociatedTokenAddress(owner, mint) {
        return deriveAssociatedTokenAddress(owner, mint);
    }

    function meta(pubkey, isSigner, isWritable) {
        return { pubkey, isSigner, isWritable };
    }

    function instruction(programId, keys, data) {
        const web3 = resolveWeb3();
        return new web3.TransactionInstruction({ programId: programKey(programId), keys, data });
    }

    function buildCreateMarketIx(options) {
        const opts = options || {};
        const proposal = toPublicKey(opts.proposal, 'proposal');
        const stakeMint = toPublicKey(opts.stakeMint, 'stakeMint');
        const creator = toPublicKey(opts.creator, 'creator');
        const [market] = getMarketPda(proposal, opts.programId);
        const vault = getVaultAddress(market, stakeMint);
        const web3 = resolveWeb3();
        const keys = [
            meta(market, false, true),
            meta(proposal, false, false),
            meta(stakeMint, false, false),
            meta(vault, false, true),
            meta(creator, true, true),
            meta(toPublicKey(constants.TOKEN_PROGRAM_ID), false, false),
            meta(toPublicKey(constants.ASSOCIATED_TOKEN_PROGRAM_ID), false, false),
            meta(web3.SystemProgram.programId, false, false)
        ];
        return instruction(opts.programId, keys, discriminatorBytes(IX_DISCRIMINATORS, 'create_market'));
    }

    function buildStakeIx(options) {
        const opts = options || {};
        const proposal = toPublicKey(opts.proposal, 'proposal');
        const stakeMint = toPublicKey(opts.stakeMint, 'stakeMint');
        const staker = toPublicKey(opts.staker, 'staker');
        const side = normalizeSide(opts.side);
        const amount = toU64(opts.amount, 'amount');
        // Mirrors MarketError::ZeroAmount — a zero stake is rejected on-chain, so never build one.
        if (amount === 0n) throw new Error('amount must be positive');

        const [market] = getMarketPda(proposal, opts.programId);
        const [position] = getPositionPda(market, staker, side, opts.programId);
        const vault = getVaultAddress(market, stakeMint);
        const stakerTokenAccount = getAssociatedTokenAddress(staker, stakeMint);
        const web3 = resolveWeb3();
        const keys = [
            meta(market, false, true),
            meta(proposal, false, false),
            meta(position, false, true),
            meta(vault, false, true),
            meta(stakerTokenAccount, false, true),
            meta(staker, true, true),
            meta(toPublicKey(constants.TOKEN_PROGRAM_ID), false, false),
            meta(web3.SystemProgram.programId, false, false)
        ];
        const data = concatBytes([
            discriminatorBytes(IX_DISCRIMINATORS, 'stake'),
            Uint8Array.from([side]),
            encodeU64(amount)
        ]);
        return instruction(opts.programId, keys, data);
    }

    function buildResolveIx(options) {
        const opts = options || {};
        const proposal = toPublicKey(opts.proposal, 'proposal');
        const [market] = getMarketPda(proposal, opts.programId);
        const keys = [
            meta(market, false, true),
            meta(proposal, false, false)
        ];
        return instruction(opts.programId, keys, discriminatorBytes(IX_DISCRIMINATORS, 'resolve'));
    }

    function buildClaimIx(options) {
        const opts = options || {};
        const proposal = toPublicKey(opts.proposal, 'proposal');
        const stakeMint = toPublicKey(opts.stakeMint, 'stakeMint');
        const claimer = toPublicKey(opts.claimer, 'claimer');
        const side = normalizeSide(opts.side);
        const [market] = getMarketPda(proposal, opts.programId);
        const [position] = getPositionPda(market, claimer, side, opts.programId);
        const vault = getVaultAddress(market, stakeMint);
        const claimerTokenAccount = getAssociatedTokenAddress(claimer, stakeMint);
        const keys = [
            meta(market, false, false),
            meta(position, false, true),
            meta(vault, false, true),
            meta(claimerTokenAccount, false, true),
            meta(claimer, true, false),
            meta(toPublicKey(constants.TOKEN_PROGRAM_ID), false, false)
        ];
        return instruction(opts.programId, keys, discriminatorBytes(IX_DISCRIMINATORS, 'claim'));
    }

    function readPubkey(bytes, offset) {
        return toPublicKey(bytes.slice(offset, offset + PUBKEY_BYTES), 'pubkey').toBase58();
    }

    function decodeMarket(dataBytes) {
        const bytes = toBytes(dataBytes, 'market account data');
        if (bytes.length < MARKET_SIZE) throw new Error(`market account is ${bytes.length} bytes, expected at least ${MARKET_SIZE}`);
        if (!matchesDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.Market)) throw new Error('account is not a proposal_market Market (discriminator mismatch)');
        let offset = DISCRIMINATOR_BYTES;
        const proposal = readPubkey(bytes, offset); offset += PUBKEY_BYTES;
        const stakeMint = readPubkey(bytes, offset); offset += PUBKEY_BYTES;
        const vault = readPubkey(bytes, offset); offset += PUBKEY_BYTES;
        const yesPool = readU64(bytes, offset); offset += 8;
        const noPool = readU64(bytes, offset); offset += 8;
        const resolved = bytes[offset] === 1; offset += 1;
        const outcome = bytes[offset]; offset += 1;
        const bump = bytes[offset];
        return { proposal, stakeMint, vault, yesPool, noPool, resolved, outcome, bump };
    }

    function decodePosition(dataBytes) {
        const bytes = toBytes(dataBytes, 'position account data');
        if (bytes.length < POSITION_SIZE) throw new Error(`position account is ${bytes.length} bytes, expected at least ${POSITION_SIZE}`);
        if (!matchesDiscriminator(bytes, ACCOUNT_DISCRIMINATORS.Position)) throw new Error('account is not a proposal_market Position (discriminator mismatch)');
        let offset = DISCRIMINATOR_BYTES;
        const market = readPubkey(bytes, offset); offset += PUBKEY_BYTES;
        const owner = readPubkey(bytes, offset); offset += PUBKEY_BYTES;
        const side = bytes[offset]; offset += 1;
        const amount = readU64(bytes, offset); offset += 8;
        const claimed = bytes[offset] === 1; offset += 1;
        const bump = bytes[offset];
        return { market, owner, side, amount, claimed, bump };
    }

    async function readMarket(connection, proposal, programId) {
        if (!connection || typeof connection.getAccountInfo !== 'function') throw new Error('a solana connection is required');
        const [market] = getMarketPda(proposal, programId);
        const info = await connection.getAccountInfo(market);
        if (!info || !info.data) return null;
        return decodeMarket(info.data);
    }

    async function readPosition(connection, proposal, owner, side, programId) {
        if (!connection || typeof connection.getAccountInfo !== 'function') throw new Error('a solana connection is required');
        const [market] = getMarketPda(proposal, programId);
        const [position] = getPositionPda(market, owner, side, programId);
        const info = await connection.getAccountInfo(position);
        if (!info || !info.data) return null;
        return decodePosition(info.data);
    }

    // BigInt mirror of proposal_market::payout_amount. Empty winning pool refunds every position,
    // a loser gets nothing, a winner gets floor(amount * (yes + no) / winning).
    function payoutAmount(side, amount, yesPool, noPool, outcome) {
        const sideValue = normalizeSide(side);
        const outcomeValue = normalizeSide(outcome);
        const stake = toU64(amount, 'amount');
        const yes = toU64(yesPool, 'yesPool');
        const no = toU64(noPool, 'noPool');
        const winning = outcomeValue === constants.SIDE_YES ? yes : no;
        const losing = outcomeValue === constants.SIDE_YES ? no : yes;
        if (winning === 0n) return stake;
        if (sideValue !== outcomeValue) return 0n;
        const payout = (stake * (winning + losing)) / winning;
        if (payout > MAX_U64) throw new Error('payout overflows a u64');
        return payout;
    }

    function impliedProbability(yesPool, noPool) {
        const yes = toU64(yesPool, 'yesPool');
        const no = toU64(noPool, 'noPool');
        const total = yes + no;
        if (total === 0n) return null;
        const denominator = Number(total);
        return { yes: Number(yes) / denominator, no: Number(no) / denominator };
    }

    // Exact decimal rendering of atomic units — no floats, so a u64 never loses its low digits.
    function formatAtomic(amount, decimals) {
        const places = decimals === undefined || decimals === null ? 0 : Number(decimals);
        if (!Number.isInteger(places) || places < 0 || places > 30) throw new Error('decimals must be an integer between 0 and 30');
        const value = toU64(amount, 'amount');
        if (places === 0) return value.toString();
        const base = 10n ** BigInt(places);
        const whole = (value / base).toString();
        const fraction = (value % base).toString().padStart(places, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : whole;
    }

    const api = {
        constants,
        IX_DISCRIMINATORS,
        ACCOUNT_DISCRIMINATORS,
        MARKET_SIZE,
        POSITION_SIZE,
        configure,
        getMarketPda,
        getPositionPda,
        getVaultAddress,
        getAssociatedTokenAddress,
        buildCreateMarketIx,
        buildStakeIx,
        buildResolveIx,
        buildClaimIx,
        decodeMarket,
        decodePosition,
        readMarket,
        readPosition,
        payoutAmount,
        impliedProbability,
        formatAtomic
    };

    return api;
});
