// Pure client codec for proposal_pledge. It owns PDA derivation, Anchor/borsh bytes and account
// decoding; browser UI and node agents share these exact transaction instructions.
(function attachSolanaPledgeClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaPledgeClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function solanaPledgeClientFactory() {
    'use strict';

    const IX_DISCRIMINATORS = Object.freeze({
        create_escrow: Object.freeze([253, 215, 165, 116, 36, 108, 68, 80]),
        pledge: Object.freeze([235, 47, 156, 254, 0, 88, 212, 142]),
        release: Object.freeze([253, 249, 15, 206, 28, 127, 193, 241]),
        refund: Object.freeze([2, 96, 183, 251, 63, 208, 46, 46])
    });
    const ACCOUNT_DISCRIMINATORS = Object.freeze({
        Escrow: Object.freeze([31, 213, 123, 187, 186, 22, 218, 155]),
        PledgePosition: Object.freeze([70, 252, 205, 167, 148, 232, 30, 171]),
        Backer: Object.freeze([199, 128, 179, 190, 2, 66, 118, 252])
    });
    const constants = Object.freeze({
        PROGRAM_ID: '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g',
        USDC_DEVNET_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        ASSOCIATED_TOKEN_PROGRAM_ID: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
        USDC_DECIMALS: 6
    });
    const ESCROW_SIZE = 8 + 4 * 32 + 5 * 8 + 1 + 1;
    const POSITION_SIZE = 8 + 2 * 32 + 32 + 8 + 1 + 1;
    const BACKER_SIZE = 8 + 2 * 32 + 2 * 8 + 1;
    const MAX_U64 = (1n << 64n) - 1n;
    let injectedWeb3 = null;
    let programIdOverride = null;

    function configure(options) {
        const opts = options || {};
        if (Object.prototype.hasOwnProperty.call(opts, 'web3')) injectedWeb3 = opts.web3 || null;
        if (Object.prototype.hasOwnProperty.call(opts, 'programId')) programIdOverride = opts.programId || null;
        return api;
    }
    function web3() {
        if (injectedWeb3) return injectedWeb3;
        if (globalThis.solanaWeb3?.PublicKey) return globalThis.solanaWeb3;
        if (typeof require === 'function') {
            try { return require('@solana/web3.js'); } catch (_) { /* injected by node consumers */ }
        }
        throw new Error('solana-web3 is unavailable; configure({ web3 }) first');
    }
    function utf8(value) { return new TextEncoder().encode(value); }
    function concat(parts) {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const part of parts) { out.set(part, offset); offset += part.length; }
        return out;
    }
    function bytes(value, label) {
        if (value instanceof Uint8Array) return value;
        if (Array.isArray(value)) return Uint8Array.from(value);
        if (value?.buffer && typeof value.byteOffset === 'number') return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        throw new Error(`${label || 'value'} must be bytes`);
    }
    function key(value, label) {
        const w = web3();
        if (value instanceof w.PublicKey) return value;
        if (typeof value === 'string') return new w.PublicKey(value);
        if (value?.toBase58) return new w.PublicKey(value.toBase58());
        if (value instanceof Uint8Array || Array.isArray(value)) return new w.PublicKey(value);
        throw new Error(`${label || 'address'} is required`);
    }
    function programKey(programId) { return key(programId || programIdOverride || constants.PROGRAM_ID, 'programId'); }
    function idBytes(value) {
        const out = bytes(value, 'pledgeId');
        if (out.length !== 32) throw new Error('pledgeId must be exactly 32 bytes');
        return out;
    }
    function u64(value, label) {
        let parsed;
        if (typeof value === 'bigint') parsed = value;
        else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
        else if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
        else throw new Error(`${label || 'amount'} must be bigint, safe integer, or digit string`);
        if (parsed < 0n || parsed > MAX_U64) throw new Error(`${label || 'amount'} does not fit in a u64`);
        return parsed;
    }
    function encodeU64(value) {
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigUint64(0, value, true);
        return out;
    }
    function readU64(value, offset) { return new DataView(value.buffer, value.byteOffset + offset, 8).getBigUint64(0, true); }
    function getEscrowPda(proposal, programId) {
        return web3().PublicKey.findProgramAddressSync([utf8('escrow'), key(proposal).toBytes()], programKey(programId));
    }
    function getPositionPda(escrow, owner, pledgeId, programId) {
        return web3().PublicKey.findProgramAddressSync(
            [utf8('pledge'), key(escrow).toBytes(), key(owner).toBytes(), idBytes(pledgeId)],
            programKey(programId)
        );
    }
    function getBackerPda(escrow, owner, programId) {
        return web3().PublicKey.findProgramAddressSync(
            [utf8('backer'), key(escrow).toBytes(), key(owner).toBytes()],
            programKey(programId)
        );
    }
    function associatedTokenAddress(owner, mint) {
        const [address] = web3().PublicKey.findProgramAddressSync(
            [key(owner).toBytes(), key(constants.TOKEN_PROGRAM_ID).toBytes(), key(mint).toBytes()],
            key(constants.ASSOCIATED_TOKEN_PROGRAM_ID)
        );
        return address;
    }
    function meta(pubkey, isSigner, isWritable) { return { pubkey, isSigner, isWritable }; }
    function ix(programId, keys, data) { return new (web3().TransactionInstruction)({ programId: programKey(programId), keys, data }); }
    function disc(name) { return Uint8Array.from(IX_DISCRIMINATORS[name]); }

    function buildCreateEscrowIx(options) {
        const o = options || {};
        const proposal = key(o.proposal, 'proposal');
        const mint = key(o.pledgeMint || constants.USDC_DEVNET_MINT, 'pledgeMint');
        const creator = key(o.creator, 'creator');
        const [escrow] = getEscrowPda(proposal, o.programId);
        return ix(o.programId, [
            meta(escrow, false, true), meta(proposal, false, false), meta(mint, false, false),
            meta(associatedTokenAddress(escrow, mint), false, true), meta(creator, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false),
            meta(key(constants.ASSOCIATED_TOKEN_PROGRAM_ID), false, false),
            meta(web3().SystemProgram.programId, false, false)
        ], disc('create_escrow'));
    }
    function buildPledgeIx(options) {
        const o = options || {};
        const proposal = key(o.proposal, 'proposal');
        const mint = key(o.pledgeMint || constants.USDC_DEVNET_MINT, 'pledgeMint');
        const pledger = key(o.pledger, 'pledger');
        const pledgeId = idBytes(o.pledgeId);
        const amount = u64(o.amount, 'amount');
        if (amount === 0n) throw new Error('amount must be positive');
        const [escrow] = getEscrowPda(proposal, o.programId);
        const [position] = getPositionPda(escrow, pledger, pledgeId, o.programId);
        const [backer] = getBackerPda(escrow, pledger, o.programId);
        return ix(o.programId, [
            meta(escrow, false, true), meta(proposal, false, false), meta(position, false, true),
            meta(backer, false, true), meta(associatedTokenAddress(escrow, mint), false, true),
            meta(associatedTokenAddress(pledger, mint), false, true), meta(pledger, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false), meta(web3().SystemProgram.programId, false, false)
        ], concat([disc('pledge'), pledgeId, encodeU64(amount)]));
    }
    function buildReleaseIx(options) {
        const o = options || {};
        const proposal = key(o.proposal, 'proposal');
        const mint = key(o.pledgeMint || constants.USDC_DEVNET_MINT, 'pledgeMint');
        const beneficiary = key(o.beneficiary, 'beneficiary');
        const releaser = key(o.releaser, 'releaser');
        const [escrow] = getEscrowPda(proposal, o.programId);
        return ix(o.programId, [
            meta(escrow, false, true), meta(proposal, false, false), meta(mint, false, false),
            meta(associatedTokenAddress(escrow, mint), false, true), meta(beneficiary, false, false),
            meta(associatedTokenAddress(beneficiary, mint), false, true), meta(releaser, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false),
            meta(key(constants.ASSOCIATED_TOKEN_PROGRAM_ID), false, false),
            meta(web3().SystemProgram.programId, false, false)
        ], disc('release'));
    }
    function buildRefundIx(options) {
        const o = options || {};
        const proposal = key(o.proposal, 'proposal');
        const mint = key(o.pledgeMint || constants.USDC_DEVNET_MINT, 'pledgeMint');
        const pledger = key(o.pledger, 'pledger');
        const [escrow] = getEscrowPda(proposal, o.programId);
        const [position] = getPositionPda(escrow, pledger, o.pledgeId, o.programId);
        return ix(o.programId, [
            meta(escrow, false, true), meta(proposal, false, false), meta(position, false, true),
            meta(associatedTokenAddress(escrow, mint), false, true),
            meta(associatedTokenAddress(pledger, mint), false, true), meta(pledger, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false)
        ], disc('refund'));
    }
    function matches(value, expected) { return expected.every((byte, i) => value[i] === byte); }
    function readKey(value, offset) { return key(value.slice(offset, offset + 32)).toBase58(); }
    function decodeEscrow(data) {
        const value = bytes(data, 'escrow data');
        if (value.length < ESCROW_SIZE || !matches(value, ACCOUNT_DISCRIMINATORS.Escrow)) throw new Error('account is not a proposal_pledge Escrow');
        let at = 8;
        const proposal = readKey(value, at); at += 32;
        const beneficiary = readKey(value, at); at += 32;
        const pledgeMint = readKey(value, at); at += 32;
        const vault = readKey(value, at); at += 32;
        const totalPledged = readU64(value, at); at += 8;
        const totalReleased = readU64(value, at); at += 8;
        const totalRefunded = readU64(value, at); at += 8;
        const pledgeCount = readU64(value, at); at += 8;
        const backerCount = readU64(value, at); at += 8;
        const released = value[at++] === 1;
        const bump = value[at];
        return { proposal, beneficiary, pledgeMint, vault, totalPledged, totalReleased, totalRefunded, pledgeCount, backerCount, released, bump };
    }
    function decodePosition(data) {
        const value = bytes(data, 'position data');
        if (value.length < POSITION_SIZE || !matches(value, ACCOUNT_DISCRIMINATORS.PledgePosition)) throw new Error('account is not a proposal_pledge PledgePosition');
        let at = 8;
        const escrow = readKey(value, at); at += 32;
        const owner = readKey(value, at); at += 32;
        const pledgeId = value.slice(at, at + 32); at += 32;
        const amount = readU64(value, at); at += 8;
        const refunded = value[at++] === 1;
        return { escrow, owner, pledgeId, amount, refunded, bump: value[at] };
    }
    function decodeBacker(data) {
        const value = bytes(data, 'backer data');
        if (value.length < BACKER_SIZE || !matches(value, ACCOUNT_DISCRIMINATORS.Backer)) throw new Error('account is not a proposal_pledge Backer');
        let at = 8;
        const escrow = readKey(value, at); at += 32;
        const owner = readKey(value, at); at += 32;
        const totalPledged = readU64(value, at); at += 8;
        const pledgeCount = readU64(value, at); at += 8;
        return { escrow, owner, totalPledged, pledgeCount, bump: value[at] };
    }
    async function readAccount(connection, address, decoder) {
        if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
        const info = await connection.getAccountInfo(address);
        return info?.data ? decoder(info.data) : null;
    }
    async function readEscrow(connection, proposal, programId) {
        return readAccount(connection, getEscrowPda(proposal, programId)[0], decodeEscrow);
    }
    async function readPosition(connection, proposal, owner, pledgeId, programId) {
        const [escrow] = getEscrowPda(proposal, programId);
        return readAccount(connection, getPositionPda(escrow, owner, pledgeId, programId)[0], decodePosition);
    }
    async function readBacker(connection, proposal, owner, programId) {
        const [escrow] = getEscrowPda(proposal, programId);
        return readAccount(connection, getBackerPda(escrow, owner, programId)[0], decodeBacker);
    }
    function parseUsdc(value) {
        if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim())) throw new Error('USDC amount must be a decimal string');
        const [whole, fraction = ''] = value.trim().split('.');
        if (fraction.length > constants.USDC_DECIMALS) throw new Error('USDC supports at most 6 decimals');
        return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0') || '0');
    }
    function formatUsdc(value) {
        const amount = u64(value);
        const whole = amount / 1000000n;
        const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : whole.toString();
    }
    async function hashPledgeId(value) {
        const source = typeof value === 'string' ? utf8(value) : bytes(value, 'pledge id source');
        if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
        return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source));
    }

    const api = {
        constants, IX_DISCRIMINATORS, ACCOUNT_DISCRIMINATORS,
        ESCROW_SIZE, POSITION_SIZE, BACKER_SIZE, configure,
        getEscrowPda, getPositionPda, getBackerPda, getAssociatedTokenAddress: associatedTokenAddress,
        buildCreateEscrowIx, buildPledgeIx, buildReleaseIx, buildRefundIx,
        decodeEscrow, decodePosition, decodeBacker, readEscrow, readPosition, readBacker,
        parseUsdc, formatUsdc, hashPledgeId
    };
    return api;
});
