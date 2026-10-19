// Unit tests for frontend/js/solana/market-client.js — the pure client codec for the
// proposal_market Anchor program. Everything here is byte-level: discriminators are re-derived from
// sha256 and cross-checked against the generated IDL, account metas are compared against the IDL's
// own writable/signer flags, and the payout math is run against the Rust unit tests' cases.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const market = require('../../frontend/js/solana/market-client.js');
const web3 = require('@solana/web3.js');
const { PublicKey } = web3;

// The module resolves web3 relative to frontend/js/solana, where @solana/web3.js is not installed,
// so the tests supply it the way the browser does: the vendored global. configure({ web3 }) is
// covered separately at the bottom.
globalThis.solanaWeb3 = web3;

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const IDL = JSON.parse(readFileSync(path.join(REPO, 'blockchain/solana/idl/proposal_market.json'), 'utf8'));

const { SIDE_NO, SIDE_YES, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = market.constants;

// Deterministic, valid 32-byte addresses — the actual values are irrelevant to every test except
// the frozen ATA vector below, which uses its own published pair.
function keyOf(byte) {
    return new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
}
const PROPOSAL = keyOf(7);
const STAKE_MINT = keyOf(11);
const WALLET = keyOf(23);
const CREDENTIAL = keyOf(29);
const SCHEMA = keyOf(31);
const ATTESTATION = keyOf(37);
const RECIPE_HASH = '11'.repeat(32);
const SUBJECT_HASH = '22'.repeat(32);
const YES_HASH = '33'.repeat(32);
const NO_HASH = '44'.repeat(32);

function idlInstruction(name) {
    const found = IDL.instructions.find(ix => ix.name === name);
    if (!found) throw new Error(`no ${name} instruction in the IDL`);
    return found;
}

function idlFlags(name) {
    return idlInstruction(name).accounts.map(account => ({
        name: account.name,
        signer: Boolean(account.signer),
        writable: Boolean(account.writable)
    }));
}

function actualFlags(ix, names) {
    return ix.keys.map((key, index) => ({
        name: names[index],
        signer: key.isSigner,
        writable: key.isWritable
    }));
}

function bytesOf(value) {
    return Array.from(value);
}

afterEach(() => {
    market.configure({ web3: null, programId: null });
});

describe('discriminators', () => {
    function anchorDiscriminator(prefix, name) {
        return Array.from(createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0, 8));
    }

    it('matches sha256("global:<name>") for every instruction', () => {
        for (const name of ['create_market', 'create_external_market', 'stake', 'stake_external', 'resolve', 'resolve_external', 'claim', 'claim_external']) {
            expect(bytesOf(market.IX_DISCRIMINATORS[name]), name).toEqual(anchorDiscriminator('global', name));
        }
    });

    it('matches sha256("account:<Name>") for every account', () => {
        for (const name of ['ExternalMarket', 'Market', 'Position']) {
            expect(bytesOf(market.ACCOUNT_DISCRIMINATORS[name]), name).toEqual(anchorDiscriminator('account', name));
        }
    });

    it('matches the generated IDL file', () => {
        for (const ix of IDL.instructions) {
            expect(bytesOf(market.IX_DISCRIMINATORS[ix.name]), ix.name).toEqual(ix.discriminator);
        }
        for (const account of IDL.accounts) {
            expect(bytesOf(market.ACCOUNT_DISCRIMINATORS[account.name]), account.name).toEqual(account.discriminator);
        }
    });

    it('exposes the IDL program address and the well-known program ids', () => {
        expect(market.constants.PROGRAM_ID).toBe(IDL.address);
        expect(TOKEN_PROGRAM_ID).toBe(idlInstruction('claim').accounts.find(a => a.name === 'token_program').address);
        expect(ASSOCIATED_TOKEN_PROGRAM_ID).toBe(idlInstruction('create_market').accounts.find(a => a.name === 'associated_token_program').address);
        expect(market.constants.SYSTEM_PROGRAM_ID).toBe(web3.SystemProgram.programId.toBase58());
        expect([SIDE_NO, SIDE_YES]).toEqual([0, 1]);
    });
});

describe('PDA derivation', () => {
    it('derives the market PDA from ["market", proposal] and is deterministic', () => {
        const [pda, bump] = market.getMarketPda(PROPOSAL);
        const [expected, expectedBump] = PublicKey.findProgramAddressSync(
            [Buffer.from('market'), new PublicKey(PROPOSAL).toBytes()],
            new PublicKey(market.constants.PROGRAM_ID)
        );
        expect(pda.toBase58()).toBe(expected.toBase58());
        expect(bump).toBe(expectedBump);
        expect(market.getMarketPda(PROPOSAL)[0].toBase58()).toBe(pda.toBase58());
    });

    it('accepts a PublicKey instance as well as a base58 string', () => {
        expect(market.getMarketPda(new PublicKey(PROPOSAL))[0].toBase58()).toBe(market.getMarketPda(PROPOSAL)[0].toBase58());
    });

    it('derives an external market solely from ["external_market", recipeHash]', () => {
        const [pda, bump] = market.getExternalMarketPda(`sha256:${RECIPE_HASH}`);
        const [expected, expectedBump] = PublicKey.findProgramAddressSync(
            [Buffer.from('external_market'), Buffer.from(RECIPE_HASH, 'hex')],
            new PublicKey(market.constants.PROGRAM_ID)
        );
        expect([pda.toBase58(), bump]).toEqual([expected.toBase58(), expectedBump]);
        expect(() => market.getExternalMarketPda('not-a-hash')).toThrow(/32-byte hash/);
    });

    it('derives the position PDA from ["position", market, owner, [side]]', () => {
        const [marketPda] = market.getMarketPda(PROPOSAL);
        const [pda, bump] = market.getPositionPda(marketPda, WALLET, SIDE_YES);
        const [expected, expectedBump] = PublicKey.findProgramAddressSync(
            [Buffer.from('position'), marketPda.toBytes(), new PublicKey(WALLET).toBytes(), Uint8Array.from([1])],
            new PublicKey(market.constants.PROGRAM_ID)
        );
        expect(pda.toBase58()).toBe(expected.toBase58());
        expect(bump).toBe(expectedBump);
    });

    it('gives YES and NO of the same owner different positions', () => {
        const [marketPda] = market.getMarketPda(PROPOSAL);
        const yes = market.getPositionPda(marketPda, WALLET, SIDE_YES)[0].toBase58();
        const no = market.getPositionPda(marketPda, WALLET, SIDE_NO)[0].toBase58();
        expect(yes).not.toBe(no);
    });

    it('rejects a side that is not 0 or 1', () => {
        const [marketPda] = market.getMarketPda(PROPOSAL);
        expect(() => market.getPositionPda(marketPda, WALLET, 2)).toThrow(/side must be 0/);
    });

    it('honours a programId override, both per call and via configure()', () => {
        const other = keyOf(31);
        const perCall = market.getMarketPda(PROPOSAL, other)[0].toBase58();
        expect(perCall).not.toBe(market.getMarketPda(PROPOSAL)[0].toBase58());
        market.configure({ programId: other });
        expect(market.getMarketPda(PROPOSAL)[0].toBase58()).toBe(perCall);
    });
});

describe('associated token addresses', () => {
    // Frozen vector: this pair derives to a single address under the ATA program, confirmed
    // independently with @solana/kit's getProgramDerivedAddress (bump 252).
    const VECTOR_OWNER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
    const VECTOR_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const VECTOR_ATA = '3kch82dBbEGMJhwjoT6X6xFuyfQLP7o8c6WTnA7Svpz9';

    it('matches the frozen vector for a wallet owner', () => {
        expect(market.getAssociatedTokenAddress(VECTOR_OWNER, VECTOR_MINT).toBase58()).toBe(VECTOR_ATA);
    });

    it('is the [owner, TOKEN_PROGRAM, mint] PDA of the ATA program', () => {
        const [expected] = PublicKey.findProgramAddressSync(
            [new PublicKey(WALLET).toBytes(), new PublicKey(TOKEN_PROGRAM_ID).toBytes(), new PublicKey(STAKE_MINT).toBytes()],
            new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
        );
        expect(market.getAssociatedTokenAddress(WALLET, STAKE_MINT).toBase58()).toBe(expected.toBase58());
    });

    it('derives the vault for an off-curve (PDA) owner', () => {
        const [marketPda] = market.getMarketPda(PROPOSAL);
        expect(PublicKey.isOnCurve(marketPda.toBytes())).toBe(false);
        const [expected] = PublicKey.findProgramAddressSync(
            [marketPda.toBytes(), new PublicKey(TOKEN_PROGRAM_ID).toBytes(), new PublicKey(STAKE_MINT).toBytes()],
            new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID)
        );
        expect(market.getVaultAddress(marketPda, STAKE_MINT).toBase58()).toBe(expected.toBase58());
    });
});

describe('buildCreateMarketIx', () => {
    const ix = () => market.buildCreateMarketIx({ proposal: PROPOSAL, stakeMint: STAKE_MINT, creator: WALLET });

    it('carries the account metas in IDL order with the IDL flags', () => {
        const names = idlFlags('create_market').map(a => a.name);
        expect(actualFlags(ix(), names)).toEqual(idlFlags('create_market'));
    });

    it('points every account at the derived address', () => {
        const [marketPda] = market.getMarketPda(PROPOSAL);
        expect(ix().keys.map(k => k.pubkey.toBase58())).toEqual([
            marketPda.toBase58(),
            PROPOSAL,
            STAKE_MINT,
            market.getVaultAddress(marketPda, STAKE_MINT).toBase58(),
            WALLET,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
            market.constants.SYSTEM_PROGRAM_ID
        ]);
        expect(ix().programId.toBase58()).toBe(market.constants.PROGRAM_ID);
    });

    it('encodes the discriminator and nothing else (the IDL declares no args)', () => {
        expect(idlInstruction('create_market').args).toEqual([]);
        expect(bytesOf(ix().data)).toEqual(bytesOf(market.IX_DISCRIMINATORS.create_market));
    });
});

describe('buildStakeIx', () => {
    const build = (over = {}) => market.buildStakeIx({
        proposal: PROPOSAL, stakeMint: STAKE_MINT, staker: WALLET, side: SIDE_YES, amount: '50000', ...over
    });

    it('carries the account metas in IDL order with the IDL flags', () => {
        const names = idlFlags('stake').map(a => a.name);
        expect(actualFlags(build(), names)).toEqual(idlFlags('stake'));
    });

    it('points every account at the derived address', () => {
        const [marketPda] = market.getMarketPda(PROPOSAL);
        expect(build().keys.map(k => k.pubkey.toBase58())).toEqual([
            marketPda.toBase58(),
            PROPOSAL,
            market.getPositionPda(marketPda, WALLET, SIDE_YES)[0].toBase58(),
            market.getVaultAddress(marketPda, STAKE_MINT).toBase58(),
            market.getAssociatedTokenAddress(WALLET, STAKE_MINT).toBase58(),
            WALLET,
            TOKEN_PROGRAM_ID,
            market.constants.SYSTEM_PROGRAM_ID
        ]);
    });

    it('encodes disc ++ u8 side ++ u64 amount little-endian', () => {
        const data = bytesOf(build().data);
        expect(data).toHaveLength(8 + 1 + 8);
        expect(data.slice(0, 8)).toEqual(bytesOf(market.IX_DISCRIMINATORS.stake));
        expect(data[8]).toBe(1);
        // 50000 = 0xC350 → little-endian u64.
        expect(data.slice(9)).toEqual([0x50, 0xC3, 0, 0, 0, 0, 0, 0]);
    });

    it('encodes the NO side as 0', () => {
        expect(bytesOf(build({ side: SIDE_NO }).data)[8]).toBe(0);
    });

    it('accepts bigint, number and digit-string amounts identically', () => {
        const fromString = bytesOf(build({ amount: '50000' }).data);
        expect(bytesOf(build({ amount: 50000 }).data)).toEqual(fromString);
        expect(bytesOf(build({ amount: 50000n }).data)).toEqual(fromString);
    });

    it('encodes an amount beyond Number.MAX_SAFE_INTEGER without loss', () => {
        const amount = 18446744073709551615n; // u64::MAX
        expect(bytesOf(build({ amount }).data).slice(9)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
    });

    it('rejects non-integer, negative, zero and oversized amounts', () => {
        expect(() => build({ amount: 1.5 })).toThrow(/integer/);
        expect(() => build({ amount: '1.5' })).toThrow(/integer/);
        expect(() => build({ amount: -1 })).toThrow(/integer|negative/);
        expect(() => build({ amount: -1n })).toThrow(/negative/);
        expect(() => build({ amount: 0 })).toThrow(/positive/);
        expect(() => build({ amount: 1n << 64n })).toThrow(/u64/);
    });

    it('rejects an invalid side', () => {
        expect(() => build({ side: 2 })).toThrow(/side must be 0/);
    });
});

describe('external market instruction builders', () => {
    const create = () => market.buildCreateExternalMarketIx({
        recipeHash: `sha256:${RECIPE_HASH}`,
        subjectHash: SUBJECT_HASH,
        yesValueHash: YES_HASH,
        noValueHash: NO_HASH,
        trustedAttester: WALLET,
        closesAt: 1728000000n,
        stakeMint: STAKE_MINT,
        credential: CREDENTIAL,
        schema: SCHEMA,
        creator: WALLET
    });

    it('builds create_external_market in IDL account and argument order', () => {
        const ix = create();
        expect(actualFlags(ix, idlFlags('create_external_market').map(a => a.name)))
            .toEqual(idlFlags('create_external_market'));
        const [marketPda] = market.getExternalMarketPda(RECIPE_HASH);
        expect(ix.keys.map(key => key.pubkey.toBase58())).toEqual([
            marketPda.toBase58(), STAKE_MINT, market.getVaultAddress(marketPda, STAKE_MINT).toBase58(),
            CREDENTIAL, SCHEMA, WALLET, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
            market.constants.SYSTEM_PROGRAM_ID
        ]);
        const data = bytesOf(ix.data);
        expect(data).toHaveLength(8 + 32 * 5 + 8);
        expect(data.slice(0, 8)).toEqual(bytesOf(market.IX_DISCRIMINATORS.create_external_market));
        expect(data.slice(8, 40)).toEqual(bytesOf(Buffer.from(RECIPE_HASH, 'hex')));
        expect(data.slice(40, 72)).toEqual(bytesOf(Buffer.from(SUBJECT_HASH, 'hex')));
        expect(data.slice(72, 104)).toEqual(bytesOf(Buffer.from(YES_HASH, 'hex')));
        expect(data.slice(104, 136)).toEqual(bytesOf(Buffer.from(NO_HASH, 'hex')));
        expect(data.slice(136, 168)).toEqual(bytesOf(new PublicKey(WALLET).toBytes()));
        expect(new DataView(ix.data.buffer, ix.data.byteOffset).getBigInt64(168, true)).toBe(1728000000n);
    });

    it('builds stake, resolve and claim against the external PDA', () => {
        const [marketPda] = market.getExternalMarketPda(RECIPE_HASH);
        const stake = market.buildStakeExternalIx({
            recipeHash: RECIPE_HASH, stakeMint: STAKE_MINT, staker: WALLET, side: SIDE_YES, amount: 50n
        });
        expect(actualFlags(stake, idlFlags('stake_external').map(a => a.name))).toEqual(idlFlags('stake_external'));
        expect(stake.keys[0].pubkey.toBase58()).toBe(marketPda.toBase58());
        expect(bytesOf(stake.data).slice(0, 8)).toEqual(bytesOf(market.IX_DISCRIMINATORS.stake_external));

        const resolve = market.buildResolveExternalIx({ recipeHash: RECIPE_HASH, attestation: ATTESTATION, schema: SCHEMA });
        expect(actualFlags(resolve, idlFlags('resolve_external').map(a => a.name))).toEqual(idlFlags('resolve_external'));
        expect(resolve.keys.map(key => key.pubkey.toBase58())).toEqual([marketPda.toBase58(), ATTESTATION, SCHEMA]);

        const claim = market.buildClaimExternalIx({
            recipeHash: RECIPE_HASH, stakeMint: STAKE_MINT, claimer: WALLET, side: SIDE_YES
        });
        expect(actualFlags(claim, idlFlags('claim_external').map(a => a.name))).toEqual(idlFlags('claim_external'));
        expect(claim.keys[0].pubkey.toBase58()).toBe(marketPda.toBase58());
    });

    it('rejects malformed commitments and out-of-range timestamps', () => {
        expect(() => market.buildCreateExternalMarketIx({
            recipeHash: '00', subjectHash: SUBJECT_HASH, yesValueHash: YES_HASH, noValueHash: NO_HASH,
            trustedAttester: WALLET, closesAt: 1, stakeMint: STAKE_MINT,
            credential: CREDENTIAL, schema: SCHEMA, creator: WALLET
        })).toThrow(/32-byte hash/);
        expect(() => market.buildCreateExternalMarketIx({
            recipeHash: RECIPE_HASH, subjectHash: SUBJECT_HASH, yesValueHash: YES_HASH, noValueHash: NO_HASH,
            trustedAttester: WALLET, closesAt: 1n << 63n, stakeMint: STAKE_MINT,
            credential: CREDENTIAL, schema: SCHEMA, creator: WALLET
        })).toThrow(/i64/);
    });
});

describe('buildResolveIx', () => {
    it('carries market(w) and proposal in IDL order with no args', () => {
        const ix = market.buildResolveIx({ proposal: PROPOSAL });
        const names = idlFlags('resolve').map(a => a.name);
        expect(actualFlags(ix, names)).toEqual(idlFlags('resolve'));
        expect(ix.keys.map(k => k.pubkey.toBase58())).toEqual([market.getMarketPda(PROPOSAL)[0].toBase58(), PROPOSAL]);
        expect(bytesOf(ix.data)).toEqual(bytesOf(market.IX_DISCRIMINATORS.resolve));
    });
});

describe('buildClaimIx', () => {
    const ix = () => market.buildClaimIx({ proposal: PROPOSAL, stakeMint: STAKE_MINT, claimer: WALLET, side: SIDE_NO });

    it('carries the account metas in IDL order with the IDL flags (market read-only, claimer signer-only)', () => {
        const names = idlFlags('claim').map(a => a.name);
        expect(actualFlags(ix(), names)).toEqual(idlFlags('claim'));
        // Guards the two flags lib.rs sets apart from the other instructions.
        expect(ix().keys[0].isWritable).toBe(false);
        expect(ix().keys[4]).toMatchObject({ isSigner: true, isWritable: false });
    });

    it('points every account at the derived address', () => {
        const [marketPda] = market.getMarketPda(PROPOSAL);
        expect(ix().keys.map(k => k.pubkey.toBase58())).toEqual([
            marketPda.toBase58(),
            market.getPositionPda(marketPda, WALLET, SIDE_NO)[0].toBase58(),
            market.getVaultAddress(marketPda, STAKE_MINT).toBase58(),
            market.getAssociatedTokenAddress(WALLET, STAKE_MINT).toBase58(),
            WALLET,
            TOKEN_PROGRAM_ID
        ]);
        expect(bytesOf(ix().data)).toEqual(bytesOf(market.IX_DISCRIMINATORS.claim));
    });
});

// Buffers assembled by hand from the IDL `types` layout, so a decoder that drifts from the program
// fails here rather than on devnet.
function encodeMarketAccount({ proposal, stakeMint, vault, yesPool, noPool, resolved, outcome, bump, discriminator }) {
    const out = new Uint8Array(market.MARKET_SIZE);
    out.set(Uint8Array.from(discriminator || market.ACCOUNT_DISCRIMINATORS.Market), 0);
    out.set(new PublicKey(proposal).toBytes(), 8);
    out.set(new PublicKey(stakeMint).toBytes(), 40);
    out.set(new PublicKey(vault).toBytes(), 72);
    const view = new DataView(out.buffer);
    view.setBigUint64(104, BigInt(yesPool), true);
    view.setBigUint64(112, BigInt(noPool), true);
    out[120] = resolved ? 1 : 0;
    out[121] = outcome;
    out[122] = bump;
    return out;
}

function encodePositionAccount({ marketPda, owner, side, amount, claimed, bump, discriminator }) {
    const out = new Uint8Array(market.POSITION_SIZE);
    out.set(Uint8Array.from(discriminator || market.ACCOUNT_DISCRIMINATORS.Position), 0);
    out.set(new PublicKey(marketPda).toBytes(), 8);
    out.set(new PublicKey(owner).toBytes(), 40);
    out[72] = side;
    new DataView(out.buffer).setBigUint64(73, BigInt(amount), true);
    out[81] = claimed ? 1 : 0;
    out[82] = bump;
    return out;
}

function encodeExternalMarketAccount(over = {}) {
    const value = {
        stakeMint: STAKE_MINT,
        vault: WALLET,
        recipeHash: RECIPE_HASH,
        subjectHash: SUBJECT_HASH,
        yesValueHash: YES_HASH,
        noValueHash: NO_HASH,
        credential: CREDENTIAL,
        schema: SCHEMA,
        trustedAttester: WALLET,
        yesPool: 25n,
        noPool: 75n,
        closesAt: 1728000000n,
        resolved: true,
        outcome: SIDE_YES,
        evidence: ATTESTATION,
        evidenceHash: '55'.repeat(32),
        resolvedAt: 1728000123n,
        bump: 252,
        ...over
    };
    const out = new Uint8Array(market.EXTERNAL_MARKET_SIZE);
    out.set(Uint8Array.from(value.discriminator || market.ACCOUNT_DISCRIMINATORS.ExternalMarket), 0);
    let offset = 8;
    for (const key of [value.stakeMint, value.vault]) {
        out.set(new PublicKey(key).toBytes(), offset); offset += 32;
    }
    for (const hex of [value.recipeHash, value.subjectHash, value.yesValueHash, value.noValueHash]) {
        out.set(Buffer.from(hex, 'hex'), offset); offset += 32;
    }
    for (const key of [value.credential, value.schema, value.trustedAttester]) {
        out.set(new PublicKey(key).toBytes(), offset); offset += 32;
    }
    const view = new DataView(out.buffer);
    view.setBigUint64(offset, value.yesPool, true); offset += 8;
    view.setBigUint64(offset, value.noPool, true); offset += 8;
    view.setBigInt64(offset, value.closesAt, true); offset += 8;
    out[offset++] = value.resolved ? 1 : 0;
    out[offset++] = value.outcome;
    out.set(new PublicKey(value.evidence).toBytes(), offset); offset += 32;
    out.set(Buffer.from(value.evidenceHash, 'hex'), offset); offset += 32;
    view.setBigInt64(offset, value.resolvedAt, true); offset += 8;
    out[offset] = value.bump;
    return out;
}

describe('decodeMarket', () => {
    const fixture = {
        proposal: PROPOSAL, stakeMint: STAKE_MINT, vault: WALLET,
        yesPool: 300n, noPool: 18446744073709551615n, resolved: true, outcome: 1, bump: 254
    };

    it('sizes the account as 8 + Market::INIT_SPACE', () => {
        expect(market.MARKET_SIZE).toBe(8 + 32 * 3 + 8 + 8 + 1 + 1 + 1);
    });

    it('round-trips a hand-assembled account', () => {
        expect(market.decodeMarket(encodeMarketAccount(fixture))).toEqual({
            proposal: PROPOSAL, stakeMint: STAKE_MINT, vault: WALLET,
            yesPool: 300n, noPool: 18446744073709551615n, resolved: true, outcome: 1, bump: 254
        });
    });

    it('decodes an unresolved market and a Buffer input', () => {
        const buffer = Buffer.from(encodeMarketAccount({ ...fixture, yesPool: 0n, noPool: 0n, resolved: false, outcome: 0 }));
        expect(market.decodeMarket(buffer)).toMatchObject({ yesPool: 0n, noPool: 0n, resolved: false, outcome: 0 });
    });

    it('rejects a wrong discriminator', () => {
        const wrong = encodeMarketAccount({ ...fixture, discriminator: market.ACCOUNT_DISCRIMINATORS.Position });
        expect(() => market.decodeMarket(wrong)).toThrow(/discriminator/);
    });

    it('rejects a truncated account', () => {
        expect(() => market.decodeMarket(encodeMarketAccount(fixture).slice(0, market.MARKET_SIZE - 1))).toThrow(/expected at least/);
    });
});

describe('decodeExternalMarket', () => {
    it('pins the full account size and round-trips all settlement commitments', () => {
        expect(market.EXTERNAL_MARKET_SIZE).toBe(395);
        expect(market.decodeExternalMarket(encodeExternalMarketAccount())).toEqual({
            stakeMint: STAKE_MINT,
            vault: WALLET,
            recipeHash: RECIPE_HASH,
            subjectHash: SUBJECT_HASH,
            yesValueHash: YES_HASH,
            noValueHash: NO_HASH,
            credential: CREDENTIAL,
            schema: SCHEMA,
            trustedAttester: WALLET,
            yesPool: 25n,
            noPool: 75n,
            closesAt: 1728000000n,
            resolved: true,
            outcome: SIDE_YES,
            evidence: ATTESTATION,
            evidenceHash: '55'.repeat(32),
            resolvedAt: 1728000123n,
            bump: 252
        });
    });

    it('rejects a legacy discriminator and truncated data', () => {
        expect(() => market.decodeExternalMarket(encodeExternalMarketAccount({
            discriminator: market.ACCOUNT_DISCRIMINATORS.Market
        }))).toThrow(/discriminator/);
        expect(() => market.decodeExternalMarket(encodeExternalMarketAccount().slice(0, 394))).toThrow(/expected at least/);
    });
});

describe('decodePosition', () => {
    const [marketPda] = market.getMarketPda(PROPOSAL);
    const fixture = { marketPda: marketPda.toBase58(), owner: WALLET, side: 0, amount: 50000n, claimed: false, bump: 251 };

    it('sizes the account as 8 + Position::INIT_SPACE', () => {
        expect(market.POSITION_SIZE).toBe(8 + 32 * 2 + 1 + 8 + 1 + 1);
    });

    it('round-trips a hand-assembled account', () => {
        expect(market.decodePosition(encodePositionAccount(fixture))).toEqual({
            market: marketPda.toBase58(), owner: WALLET, side: 0, amount: 50000n, claimed: false, bump: 251
        });
    });

    it('decodes a claimed YES position', () => {
        expect(market.decodePosition(encodePositionAccount({ ...fixture, side: 1, claimed: true })))
            .toMatchObject({ side: 1, claimed: true });
    });

    it('rejects a wrong discriminator', () => {
        const wrong = encodePositionAccount({ ...fixture, discriminator: market.ACCOUNT_DISCRIMINATORS.Market });
        expect(() => market.decodePosition(wrong)).toThrow(/discriminator/);
    });
});

describe('readMarket / readPosition', () => {
    function fakeConnection(byAddress) {
        return {
            calls: [],
            async getAccountInfo(pubkey) {
                this.calls.push(pubkey.toBase58());
                const data = byAddress[pubkey.toBase58()];
                return data ? { data, owner: new PublicKey(market.constants.PROGRAM_ID), lamports: 1 } : null;
            }
        };
    }

    const [marketPda] = market.getMarketPda(PROPOSAL);
    const [positionPda] = market.getPositionPda(marketPda, WALLET, SIDE_YES);

    it('reads and decodes the market at its PDA', async () => {
        const connection = fakeConnection({
            [marketPda.toBase58()]: encodeMarketAccount({
                proposal: PROPOSAL, stakeMint: STAKE_MINT, vault: WALLET,
                yesPool: 10n, noPool: 20n, resolved: false, outcome: 0, bump: 250
            })
        });
        expect(await market.readMarket(connection, PROPOSAL)).toMatchObject({ yesPool: 10n, noPool: 20n, resolved: false });
        expect(connection.calls).toEqual([marketPda.toBase58()]);
    });

    it('reads and decodes the position at its PDA', async () => {
        const connection = fakeConnection({
            [positionPda.toBase58()]: encodePositionAccount({
                marketPda: marketPda.toBase58(), owner: WALLET, side: 1, amount: 7n, claimed: false, bump: 249
            })
        });
        expect(await market.readPosition(connection, PROPOSAL, WALLET, SIDE_YES)).toMatchObject({ side: 1, amount: 7n });
        expect(connection.calls).toEqual([positionPda.toBase58()]);
    });

    it('returns null when the account does not exist', async () => {
        const connection = fakeConnection({});
        expect(await market.readMarket(connection, PROPOSAL)).toBeNull();
        expect(await market.readPosition(connection, PROPOSAL, WALLET, SIDE_NO)).toBeNull();
    });

    it('throws without a connection rather than silently returning null', async () => {
        await expect(market.readMarket(null, PROPOSAL)).rejects.toThrow(/connection/);
    });
});

// Mirrors the #[cfg(test)] cases in programs/proposal_market/src/lib.rs one for one.
describe('payoutAmount', () => {
    it('splits the whole pot pro rata among the winners', () => {
        expect(market.payoutAmount(SIDE_YES, 100n, 300n, 600n, SIDE_YES)).toBe(300n);
        expect(market.payoutAmount(SIDE_YES, 200n, 300n, 600n, SIDE_YES)).toBe(600n);
        expect(market.payoutAmount(SIDE_NO, 600n, 300n, 600n, SIDE_YES)).toBe(0n);
    });

    it('returns exactly the stake when nobody lost', () => {
        expect(market.payoutAmount(SIDE_NO, 50n, 0n, 50n, SIDE_NO)).toBe(50n);
    });

    it('refunds every position when the winning pool is empty', () => {
        expect(market.payoutAmount(SIDE_YES, 70n, 70n, 0n, SIDE_NO)).toBe(70n);
        expect(market.payoutAmount(SIDE_NO, 40n, 0n, 40n, SIDE_YES)).toBe(40n);
    });

    it('floors so the payouts never exceed the vault', () => {
        const a = market.payoutAmount(SIDE_YES, 1n, 3n, 1n, SIDE_YES);
        const b = market.payoutAmount(SIDE_YES, 2n, 3n, 1n, SIDE_YES);
        expect([a, b]).toEqual([1n, 2n]);
        expect(a + b).toBeLessThanOrEqual(4n);
    });

    it('does not overflow on huge pools', () => {
        const big = (2n ** 64n - 1n) / 2n;
        expect(market.payoutAmount(SIDE_YES, big, big, big, SIDE_YES)).toBe(big * 2n);
    });

    it('accepts number and string atomic units too', () => {
        expect(market.payoutAmount(SIDE_YES, 100, 300, '600', SIDE_YES)).toBe(300n);
    });
});

describe('impliedProbability', () => {
    it('is null while both pools are empty', () => {
        expect(market.impliedProbability(0n, 0n)).toBeNull();
    });

    it('splits the pools into [0,1] probabilities', () => {
        const { yes, no } = market.impliedProbability(300n, 600n);
        expect(yes).toBeCloseTo(1 / 3, 12);
        expect(no).toBeCloseTo(2 / 3, 12);
        expect(yes + no).toBeCloseTo(1, 12);
    });

    it('is 1/0 when only one side is staked', () => {
        expect(market.impliedProbability(5n, 0n)).toEqual({ yes: 1, no: 0 });
        expect(market.impliedProbability(0n, 5n)).toEqual({ yes: 0, no: 1 });
    });
});

describe('formatAtomic', () => {
    it('renders atomic units exactly, trimming trailing zeros', () => {
        expect(market.formatAtomic(50000n, 6)).toBe('0.05');
        expect(market.formatAtomic(1000000n, 6)).toBe('1');
        expect(market.formatAtomic(1234567n, 6)).toBe('1.234567');
        expect(market.formatAtomic(1n, 6)).toBe('0.000001');
        expect(market.formatAtomic(0n, 6)).toBe('0');
        expect(market.formatAtomic(42n, 0)).toBe('42');
        expect(market.formatAtomic('50000', 6)).toBe('0.05');
    });

    it('keeps full precision past the double range', () => {
        expect(market.formatAtomic(18446744073709551615n, 6)).toBe('18446744073709.551615');
    });

    it('rejects nonsense decimals', () => {
        expect(() => market.formatAtomic(1n, -1)).toThrow(/decimals/);
        expect(() => market.formatAtomic(1n, 1.5)).toThrow(/decimals/);
    });
});

describe('configure({ web3 })', () => {
    it('uses the injected implementation instead of the ambient one', () => {
        let built = 0;
        class CountingInstruction extends web3.TransactionInstruction {
            constructor(options) { super(options); built += 1; }
        }
        market.configure({ web3: { ...web3, TransactionInstruction: CountingInstruction } });
        const ix = market.buildResolveIx({ proposal: PROPOSAL });
        expect(built).toBe(1);
        expect(ix).toBeInstanceOf(CountingInstruction);
    });

    it('returns the api so calls can be chained', () => {
        expect(market.configure({})).toBe(market);
    });

    it('throws a clear error when no implementation is available at all', () => {
        const vendored = globalThis.solanaWeb3;
        delete globalThis.solanaWeb3;
        try {
            expect(() => market.getMarketPda(PROPOSAL)).toThrow(/solana-web3 is not available/);
        } finally {
            globalThis.solanaWeb3 = vendored;
        }
    });
});
