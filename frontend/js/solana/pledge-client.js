// Pure codec shared by browser wallets and server agents for funded proposal donations and soft
// proposal pledges. It owns every PDA, Anchor instruction byte and account decoder.
(function attachSolanaPledgeClient(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SolanaPledgeClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function solanaPledgeClientFactory() {
    'use strict';

    const IX_DISCRIMINATORS = Object.freeze({
        create_donation_escrow: [17, 120, 220, 167, 31, 167, 226, 163],
        donate: [121, 186, 218, 211, 73, 70, 196, 180],
        release_donations: [179, 132, 96, 218, 222, 133, 8, 41],
        refund_donation: [122, 218, 183, 126, 27, 195, 121, 196],
        create_pledge_book: [72, 156, 10, 193, 200, 63, 147, 146],
        set_pledge: [28, 155, 221, 80, 2, 110, 77, 26],
        revoke_pledge: [148, 10, 32, 57, 46, 23, 47, 154],
        fulfill_pledge: [155, 51, 62, 164, 72, 200, 103, 251],
        void_pledge: [240, 40, 118, 116, 12, 195, 148, 96]
    });
    const ACCOUNT_DISCRIMINATORS = Object.freeze({
        DonationEscrow: [80, 16, 66, 221, 66, 84, 175, 228],
        DonationPosition: [126, 11, 141, 195, 219, 123, 134, 42],
        Donor: [43, 66, 58, 146, 38, 217, 15, 26],
        PledgeBook: [24, 193, 154, 165, 1, 51, 253, 96],
        PledgeCommitment: [238, 112, 179, 175, 31, 209, 249, 219]
    });
    const constants = Object.freeze({
        PROGRAM_ID: '1jESRS3mJiPUJTtmQ5ncyBhGNmGeXTpUqPyJcTYrp6g',
        USDC_DEVNET_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        ASSOCIATED_TOKEN_PROGRAM_ID: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
        SYSTEM_PROGRAM_ID: '11111111111111111111111111111111',
        USDC_DECIMALS: 6,
        PLEDGE_ACTIVE: 0,
        PLEDGE_FULFILLED: 1,
        PLEDGE_REVOKED: 2,
        PLEDGE_VOIDED: 3
    });
    const DONATION_ESCROW_SIZE = 178;
    const DONATION_POSITION_SIZE = 114;
    const DONOR_SIZE = 89;
    const PLEDGE_BOOK_SIZE = 153;
    const PLEDGE_COMMITMENT_SIZE = 115;
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
            try { return require('@solana/web3.js'); } catch (_) { /* configured by consumers */ }
        }
        throw new Error('solana-web3 is unavailable; configure({ web3 }) first');
    }
    function utf8(value) { return new TextEncoder().encode(value); }
    function concat(parts) {
        const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
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
        if (typeof value === 'string' || value instanceof Uint8Array || Array.isArray(value)) return new w.PublicKey(value);
        if (value?.toBase58) return new w.PublicKey(value.toBase58());
        throw new Error(`${label || 'address'} is required`);
    }
    function programKey(value) { return key(value || programIdOverride || constants.PROGRAM_ID, 'programId'); }
    function idBytes(value) {
        const result = bytes(value, 'donationId');
        if (result.length !== 32) throw new Error('donationId must be exactly 32 bytes');
        return result;
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
        new DataView(out.buffer).setBigUint64(0, u64(value), true);
        return out;
    }
    function readU64(value, offset) { return new DataView(value.buffer, value.byteOffset + offset, 8).getBigUint64(0, true); }
    function pda(seeds, programId) { return web3().PublicKey.findProgramAddressSync(seeds, programKey(programId)); }
    function getDonationEscrowPda(proposal, programId) { return pda([utf8('donation_escrow'), key(proposal).toBytes()], programId); }
    function getDonationPositionPda(escrow, owner, donationId, programId) {
        return pda([utf8('donation'), key(escrow).toBytes(), key(owner).toBytes(), idBytes(donationId)], programId);
    }
    function getDonorPda(escrow, owner, programId) { return pda([utf8('donor'), key(escrow).toBytes(), key(owner).toBytes()], programId); }
    function getPledgeBookPda(proposal, programId) { return pda([utf8('pledge_book'), key(proposal).toBytes()], programId); }
    function getPledgeCommitmentPda(book, owner, programId) { return pda([utf8('pledge'), key(book).toBytes(), key(owner).toBytes()], programId); }
    function associatedTokenAddress(owner, mint) {
        return pda([key(owner).toBytes(), key(constants.TOKEN_PROGRAM_ID).toBytes(), key(mint).toBytes()], constants.ASSOCIATED_TOKEN_PROGRAM_ID)[0];
    }
    function meta(pubkey, isSigner, isWritable) { return { pubkey, isSigner, isWritable }; }
    function ix(programId, keys, data) { return new (web3().TransactionInstruction)({ programId: programKey(programId), keys, data }); }
    function disc(name) { return Uint8Array.from(IX_DISCRIMINATORS[name]); }
    function supportKeys(options) {
        const o = options || {};
        return {
            proposal: key(o.proposal, 'proposal'),
            mint: key(o.mint || constants.USDC_DEVNET_MINT, 'mint'),
            owner: key(o.owner || o.donor || o.pledger || o.creator || o.releaser, 'owner')
        };
    }

    function buildCreateDonationEscrowIx(options) {
        const o = options || {}; const { proposal, mint, owner } = supportKeys(o);
        const [escrow] = getDonationEscrowPda(proposal, o.programId);
        return ix(o.programId, [meta(escrow, false, true), meta(proposal, false, false), meta(mint, false, false),
            meta(associatedTokenAddress(escrow, mint), false, true), meta(owner, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false), meta(key(constants.ASSOCIATED_TOKEN_PROGRAM_ID), false, false),
            meta(web3().SystemProgram.programId, false, false)], disc('create_donation_escrow'));
    }
    function buildDonateIx(options) {
        const o = options || {}; const { proposal, mint, owner } = supportKeys(o);
        const donationId = idBytes(o.donationId); const amount = u64(o.amount, 'amount');
        if (amount === 0n) throw new Error('amount must be positive');
        const [escrow] = getDonationEscrowPda(proposal, o.programId);
        return ix(o.programId, [meta(escrow, false, true), meta(proposal, false, false),
            meta(getDonationPositionPda(escrow, owner, donationId, o.programId)[0], false, true),
            meta(getDonorPda(escrow, owner, o.programId)[0], false, true), meta(associatedTokenAddress(escrow, mint), false, true),
            meta(associatedTokenAddress(owner, mint), false, true), meta(owner, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false), meta(web3().SystemProgram.programId, false, false)],
        concat([disc('donate'), donationId, encodeU64(amount)]));
    }
    function buildReleaseDonationsIx(options) {
        const o = options || {}; const { proposal, mint, owner } = supportKeys(o); const beneficiary = key(o.beneficiary, 'beneficiary');
        const [escrow] = getDonationEscrowPda(proposal, o.programId);
        return ix(o.programId, [meta(escrow, false, true), meta(proposal, false, false), meta(mint, false, false),
            meta(associatedTokenAddress(escrow, mint), false, true), meta(beneficiary, false, false),
            meta(associatedTokenAddress(beneficiary, mint), false, true), meta(owner, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false), meta(key(constants.ASSOCIATED_TOKEN_PROGRAM_ID), false, false),
            meta(web3().SystemProgram.programId, false, false)], disc('release_donations'));
    }
    function buildRefundDonationIx(options) {
        const o = options || {}; const { proposal, mint, owner } = supportKeys(o); const [escrow] = getDonationEscrowPda(proposal, o.programId);
        return ix(o.programId, [meta(escrow, false, true), meta(proposal, false, false),
            meta(getDonationPositionPda(escrow, owner, o.donationId, o.programId)[0], false, true),
            meta(associatedTokenAddress(escrow, mint), false, true), meta(associatedTokenAddress(owner, mint), false, true),
            meta(owner, true, true), meta(key(constants.TOKEN_PROGRAM_ID), false, false)], disc('refund_donation'));
    }
    function buildCreatePledgeBookIx(options) {
        const o = options || {}; const { proposal, mint, owner } = supportKeys(o); const [book] = getPledgeBookPda(proposal, o.programId);
        return ix(o.programId, [meta(book, false, true), meta(proposal, false, false), meta(mint, false, false),
            meta(owner, true, true), meta(web3().SystemProgram.programId, false, false)], disc('create_pledge_book'));
    }
    function buildSetPledgeIx(options) {
        const o = options || {}; const { proposal, owner } = supportKeys(o); const amount = u64(o.amount, 'amount');
        if (amount === 0n) throw new Error('amount must be positive');
        const [book] = getPledgeBookPda(proposal, o.programId);
        return ix(o.programId, [meta(book, false, true), meta(proposal, false, false),
            meta(getPledgeCommitmentPda(book, owner, o.programId)[0], false, true), meta(owner, true, true),
            meta(web3().SystemProgram.programId, false, false)], concat([disc('set_pledge'), encodeU64(amount)]));
    }
    function buildRevokePledgeIx(options) {
        const o = options || {}; const { proposal, owner } = supportKeys(o); const [book] = getPledgeBookPda(proposal, o.programId);
        return ix(o.programId, [meta(book, false, true), meta(proposal, false, false),
            meta(getPledgeCommitmentPda(book, owner, o.programId)[0], false, true), meta(owner, true, false)], disc('revoke_pledge'));
    }
    function buildFulfillPledgeIx(options) {
        const o = options || {}; const { proposal, mint, owner } = supportKeys(o); const beneficiary = key(o.beneficiary, 'beneficiary');
        const [book] = getPledgeBookPda(proposal, o.programId);
        return ix(o.programId, [meta(book, false, true), meta(proposal, false, false),
            meta(getPledgeCommitmentPda(book, owner, o.programId)[0], false, true), meta(mint, false, false),
            meta(associatedTokenAddress(owner, mint), false, true), meta(beneficiary, false, false),
            meta(associatedTokenAddress(beneficiary, mint), false, true), meta(owner, true, true),
            meta(key(constants.TOKEN_PROGRAM_ID), false, false), meta(key(constants.ASSOCIATED_TOKEN_PROGRAM_ID), false, false),
            meta(web3().SystemProgram.programId, false, false)], disc('fulfill_pledge'));
    }
    function buildVoidPledgeIx(options) {
        const o = options || {}; const proposal = key(o.proposal, 'proposal'); const owner = key(o.pledger || o.owner, 'pledger');
        const [book] = getPledgeBookPda(proposal, o.programId);
        return ix(o.programId, [meta(book, false, true), meta(proposal, false, false),
            meta(getPledgeCommitmentPda(book, owner, o.programId)[0], false, true)], disc('void_pledge'));
    }

    function matches(value, expected) { return expected.every((byte, index) => value[index] === byte); }
    function assertAccount(value, size, name) {
        const data = bytes(value, `${name} data`);
        if (data.length < size || !matches(data, ACCOUNT_DISCRIMINATORS[name])) throw new Error(`account is not a proposal_pledge ${name}`);
        return data;
    }
    function readKey(value, offset) { return key(value.slice(offset, offset + 32)).toBase58(); }
    function decodeDonationEscrow(data) {
        const value = assertAccount(data, DONATION_ESCROW_SIZE, 'DonationEscrow'); let at = 8;
        const proposal = readKey(value, at); at += 32; const beneficiary = readKey(value, at); at += 32;
        const mint = readKey(value, at); at += 32; const vault = readKey(value, at); at += 32;
        const totalDonated = readU64(value, at); at += 8; const totalReleased = readU64(value, at); at += 8;
        const totalRefunded = readU64(value, at); at += 8; const donationCount = readU64(value, at); at += 8;
        const donorCount = readU64(value, at); at += 8; const released = value[at++] === 1;
        return { proposal, beneficiary, mint, vault, totalDonated, totalReleased, totalRefunded, donationCount, donorCount, released, bump: value[at] };
    }
    function decodeDonationPosition(data) {
        const value = assertAccount(data, DONATION_POSITION_SIZE, 'DonationPosition'); let at = 8;
        const escrow = readKey(value, at); at += 32; const owner = readKey(value, at); at += 32;
        const donationId = value.slice(at, at + 32); at += 32; const amount = readU64(value, at); at += 8;
        const refunded = value[at++] === 1; return { escrow, owner, donationId, amount, refunded, bump: value[at] };
    }
    function decodeDonor(data) {
        const value = assertAccount(data, DONOR_SIZE, 'Donor'); let at = 8;
        const escrow = readKey(value, at); at += 32; const owner = readKey(value, at); at += 32;
        const totalDonated = readU64(value, at); at += 8; const donationCount = readU64(value, at); at += 8;
        return { escrow, owner, totalDonated, donationCount, bump: value[at] };
    }
    function decodePledgeBook(data) {
        const value = assertAccount(data, PLEDGE_BOOK_SIZE, 'PledgeBook'); let at = 8;
        const proposal = readKey(value, at); at += 32; const beneficiary = readKey(value, at); at += 32; const mint = readKey(value, at); at += 32;
        const activePledged = readU64(value, at); at += 8; const totalFulfilled = readU64(value, at); at += 8;
        const totalRevoked = readU64(value, at); at += 8; const pledgeCount = readU64(value, at); at += 8;
        const activeCount = readU64(value, at); at += 8; const fulfilledCount = readU64(value, at); at += 8;
        return { proposal, beneficiary, mint, activePledged, totalFulfilled, totalRevoked, pledgeCount, activeCount, fulfilledCount, bump: value[at] };
    }
    function decodePledgeCommitment(data) {
        const value = assertAccount(data, PLEDGE_COMMITMENT_SIZE, 'PledgeCommitment'); let at = 8;
        const book = readKey(value, at); at += 32; const proposal = readKey(value, at); at += 32; const owner = readKey(value, at); at += 32;
        const amount = readU64(value, at); at += 8; const status = value[at++]; const initialized = value[at++] === 1;
        return { book, proposal, owner, amount, status, initialized, bump: value[at] };
    }
    async function readAccount(connection, address, decoder) {
        if (!connection?.getAccountInfo) throw new Error('a solana connection is required');
        const info = await connection.getAccountInfo(address);
        return info?.data ? decoder(info.data) : null;
    }
    function readDonationEscrow(connection, proposal, programId) { return readAccount(connection, getDonationEscrowPda(proposal, programId)[0], decodeDonationEscrow); }
    function readPledgeBook(connection, proposal, programId) { return readAccount(connection, getPledgeBookPda(proposal, programId)[0], decodePledgeBook); }
    function readPledgeCommitment(connection, proposal, owner, programId) {
        const [book] = getPledgeBookPda(proposal, programId);
        return readAccount(connection, getPledgeCommitmentPda(book, owner, programId)[0], decodePledgeCommitment);
    }
    async function readDonationPosition(connection, proposal, owner, donationId, programId) {
        const [escrow] = getDonationEscrowPda(proposal, programId);
        return readAccount(connection, getDonationPositionPda(escrow, owner, donationId, programId)[0], decodeDonationPosition);
    }
    async function listDonationPositions(connection, proposal, owner, programId) {
        if (!connection?.getProgramAccounts) throw new Error('a Solana connection with getProgramAccounts is required');
        const [escrow] = getDonationEscrowPda(proposal, programId);
        const rows = await connection.getProgramAccounts(programKey(programId), { filters: [
            { dataSize: DONATION_POSITION_SIZE }, { memcmp: { offset: 8, bytes: escrow.toBase58() } },
            { memcmp: { offset: 40, bytes: key(owner).toBase58() } }
        ] });
        return rows.map(row => ({ address: row.pubkey.toBase58(), ...decodeDonationPosition(row.account.data) }));
    }
    function parseUsdc(value) {
        if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim())) throw new Error('USDC amount must be a decimal string');
        const [whole, fraction = ''] = value.trim().split('.');
        if (fraction.length > constants.USDC_DECIMALS) throw new Error('USDC supports at most 6 decimals');
        return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0') || '0');
    }
    function formatUsdc(value) {
        const amount = u64(value); const whole = amount / 1000000n;
        const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
        return fraction ? `${whole}.${fraction}` : whole.toString();
    }
    async function hashOperationId(value) {
        const source = typeof value === 'string' ? utf8(value) : bytes(value, 'operation id source');
        if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
        return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', source));
    }

    const api = {
        constants, IX_DISCRIMINATORS, ACCOUNT_DISCRIMINATORS, configure,
        DONATION_ESCROW_SIZE, DONATION_POSITION_SIZE, DONOR_SIZE, PLEDGE_BOOK_SIZE, PLEDGE_COMMITMENT_SIZE,
        getDonationEscrowPda, getDonationPositionPda, getDonorPda, getPledgeBookPda, getPledgeCommitmentPda,
        getAssociatedTokenAddress: associatedTokenAddress,
        buildCreateDonationEscrowIx, buildDonateIx, buildReleaseDonationsIx, buildRefundDonationIx,
        buildCreatePledgeBookIx, buildSetPledgeIx, buildRevokePledgeIx, buildFulfillPledgeIx, buildVoidPledgeIx,
        decodeDonationEscrow, decodeDonationPosition, decodeDonor, decodePledgeBook, decodePledgeCommitment,
        readDonationEscrow, readDonationPosition, listDonationPositions, readPledgeBook, readPledgeCommitment,
        parseUsdc, formatUsdc, hashOperationId, hashPledgeId: hashOperationId
    };
    return api;
});
