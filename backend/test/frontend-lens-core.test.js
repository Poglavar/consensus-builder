// Unit tests for frontend/js/lens-core.js, the pure lens-model logic behind the Solana lens picker, the
// agreement panel and the member console. Keys are cross-checked against @solana/web3.js, and the
// challenge check runs against the reference member's own challengeMessage so the two cannot drift.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey, Keypair } from '@solana/web3.js';
import { challengeMessage, verifyWalletSignature } from '../lens/identity/devnet-registry.js';

const require = createRequire(import.meta.url);
const core = require('../../frontend/js/lens-core.js');

const keyOf = byte => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58();
const NOTARY = keyOf(7);
const COURT = keyOf(9);
const REGISTER = keyOf(11);

describe('base58 and key validation', () => {
    it('encodes and decodes exactly like web3.js, including leading zero bytes', () => {
        const samples = [
            new Uint8Array(32),
            Uint8Array.from({ length: 32 }, (_, i) => (i < 3 ? 0 : i * 7)),
            ...Array.from({ length: 20 }, () => Keypair.generate().publicKey.toBytes())
        ];
        for (const bytes of samples) {
            const expected = new PublicKey(bytes).toBase58();
            expect(core.base58Encode(bytes)).toBe(expected);
            expect(Array.from(core.base58Decode(expected))).toEqual(Array.from(bytes));
        }
        expect(core.base58Encode(new Uint8Array(0))).toBe('');
        expect(core.base58Decode('0OIl')).toBeNull();
    });

    it('accepts only canonical 32-byte base58 keys', () => {
        expect(core.isBase58Pubkey(NOTARY)).toBe(true);
        expect(core.isBase58Pubkey(Keypair.generate().publicKey.toBase58())).toBe(true);
        expect(core.isBase58Pubkey('0xfCF94DD41B2B5d6C887a30273F995d01bacA1A45')).toBe(false);
        expect(core.isBase58Pubkey(NOTARY.slice(0, -1))).toBe(false);
        expect(core.isBase58Pubkey(`${NOTARY}1`)).toBe(false);
        expect(core.isBase58Pubkey('')).toBe(false);
        expect(core.isBase58Pubkey(null)).toBe(false);
    });
});

describe('directory normalisation', () => {
    it('keeps valid members once, clamps coverage counts and keeps only http(s) service URLs', () => {
        const members = core.normalizeDirectory({
            members: [
                { key: NOTARY, kind: 'notary', name: ' Notary 01 ', description: '', coverage: { ownership: 3, parcels: '2', executed: -1 }, serviceUrl: 'http://localhost:3095/' },
                { key: NOTARY, name: 'duplicate' },
                { key: '0xabc', name: 'EVM leftover' },
                { key: COURT, name: null, coverage: null, serviceUrl: 'javascript:alert(1)' }
            ]
        });
        expect(members).toEqual([
            { key: NOTARY, kind: 'notary', name: 'Notary 01', description: null, coverage: { ownership: 3, parcels: 2, executed: 0 }, serviceUrl: 'http://localhost:3095' },
            { key: COURT, kind: null, name: null, description: null, coverage: { ownership: 0, parcels: 0, executed: 0 }, serviceUrl: null }
        ]);
        expect(core.normalizeDirectory({ members: [] })).toEqual([]);
        expect(core.normalizeDirectory(null)).toEqual([]);
    });

    it('labels a key by directory name, else by a shortened key', () => {
        const members = core.normalizeDirectory({ members: [{ key: NOTARY, name: 'Notary 01' }] });
        expect(core.memberLabel(NOTARY, members)).toBe('Notary 01');
        expect(core.memberLabel(COURT, members)).toBe(`${COURT.slice(0, 4)}…${COURT.slice(-4)}`);
    });
});

describe('parcel coverage', () => {
    const NOW = 1_800_000_000;
    const att = (authority, parcelUid, extra = {}) => ({ address: keyOf(99), kind: 'ownership', authority, parcelUid, expiry: NOW + 100, ...extra });
    const results = [
        { memberKey: NOTARY, parcelUid: 'P1', attestations: [att(NOTARY, 'P1')] },
        { memberKey: NOTARY, parcelUid: 'P2', attestations: [] },
        { memberKey: COURT, parcelUid: 'P1', attestations: [att(COURT, 'P1', { expiry: NOW - 1 })] },
        // signed by someone else: does not make the court cover P2
        { memberKey: COURT, parcelUid: 'P2', attestations: [att(NOTARY, 'P2')] },
        { memberKey: REGISTER, parcelUid: 'P1', attestations: null },
        { memberKey: REGISTER, parcelUid: 'P2', attestations: null }
    ];

    it('counts only unexpired ownership attestations the member itself signed, and keeps unknown apart', () => {
        const coverage = core.computeParcelCoverage(['P1', 'P2'], results, NOW);
        expect(coverage.available).toBe(true);
        expect(coverage.byParcel).toEqual({
            P1: { covered: [NOTARY], unknown: [REGISTER] },
            P2: { covered: [], unknown: [REGISTER] }
        });
        expect(coverage.byMember[NOTARY]).toEqual({ covered: 1, checked: 2, unknown: 0 });
        expect(coverage.byMember[COURT]).toEqual({ covered: 0, checked: 2, unknown: 0 });
        expect(coverage.byMember[REGISTER]).toEqual({ covered: 0, checked: 0, unknown: 2 });
    });

    it('reports no data when no member could be asked', () => {
        const coverage = core.computeParcelCoverage(['P1'], [{ memberKey: REGISTER, parcelUid: 'P1', attestations: null }], NOW);
        expect(coverage.available).toBe(false);
        // the filter is a no-op without data: it never hides parcels on the strength of "unknown"
        expect(core.filterParcelsByLens(['P1'], coverage, [REGISTER], true)).toEqual(['P1']);
    });

    it('filters to parcels the chosen lens covers only when asked', () => {
        const coverage = core.computeParcelCoverage(['P1', 'P2'], results, NOW);
        expect(core.filterParcelsByLens(['P1', 'P2'], coverage, [NOTARY], true)).toEqual(['P1']);
        expect(core.filterParcelsByLens(['P1', 'P2'], coverage, [COURT], true)).toEqual([]);
        expect(core.filterParcelsByLens(['P1', 'P2'], coverage, [COURT], false)).toEqual(['P1', 'P2']);
    });

    it('sorts by measured coverage first, then directory counts, then name', () => {
        const members = core.normalizeDirectory({
            members: [
                { key: REGISTER, name: 'Register', coverage: { ownership: 50 } },
                { key: COURT, name: 'Court', coverage: { ownership: 5 } },
                { key: NOTARY, name: 'Notary', coverage: { ownership: 1 } }
            ]
        });
        expect(core.sortMembersByCoverage(members, null).map(m => m.name)).toEqual(['Register', 'Court', 'Notary']);
        const coverage = core.computeParcelCoverage(['P1', 'P2'], results, NOW);
        expect(core.sortMembersByCoverage(members, coverage).map(m => m.name)).toEqual(['Notary', 'Court', 'Register']);
    });
});

describe('lens selection', () => {
    it('splits pasted text into valid keys and rejected tokens', () => {
        expect(core.parsePastedKeys(`${NOTARY}, ${COURT}\n${NOTARY} 0xdead nope`)).toEqual({ keys: [NOTARY, COURT], invalid: ['0xdead', 'nope'] });
        expect(core.parsePastedKeys('   ')).toEqual({ keys: [], invalid: [] });
    });

    it('treats a lens without a single Solana key as an error instead of substituting one', () => {
        expect(core.validateSolanaLens([])).toMatchObject({ ok: false, error: 'empty', keys: [] });
        // the old EVM defaults do not count as a Solana lens
        expect(core.validateSolanaLens([{ address: '0xfCF94DD41B2B5d6C887a30273F995d01bacA1A45', name: 'University of Leaston' }]))
            .toMatchObject({ ok: false, error: 'empty', invalid: ['0xfCF94DD41B2B5d6C887a30273F995d01bacA1A45'] });
        expect(core.validateSolanaLens([{ address: NOTARY }, NOTARY, { address: ' ' }, COURT]))
            .toEqual({ ok: true, error: null, keys: [NOTARY, COURT], invalid: [] });
    });
});

describe('challenge handling', () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const expiresAt = 1_800_000_300;
    const response = {
        challenge: 'nonce-123',
        message: challengeMessage({ authority: NOTARY, parcelUid: 'HR-335550-1/1', owner, nonce: 'nonce-123', expiresAt }),
        expiresAt: new Date(expiresAt * 1000).toISOString()
    };
    const nowMs = 1_800_000_000 * 1000;

    it('accepts the reference member challenge for the same wallet, parcel and member', () => {
        expect(core.checkChallenge(response, { parcelUid: 'HR-335550-1/1', owner, memberKey: NOTARY, nowMs }))
            .toMatchObject({ ok: true, challenge: 'nonce-123', message: response.message });
    });

    it('refuses to sign a message about another wallet, parcel, nonce or member, or an expired one', () => {
        const opts = { parcelUid: 'HR-335550-1/1', owner, memberKey: NOTARY, nowMs };
        expect(core.checkChallenge(response, { ...opts, owner: COURT }).reason).toBe('wrong_wallet');
        expect(core.checkChallenge(response, { ...opts, parcelUid: 'HR-335550-1/11' }).reason).toBe('wrong_parcel');
        expect(core.checkChallenge({ ...response, challenge: 'other' }, opts).reason).toBe('wrong_challenge');
        expect(core.checkChallenge(response, { ...opts, memberKey: COURT }).reason).toBe('wrong_member');
        expect(core.checkChallenge(response, { ...opts, nowMs: (expiresAt + 1) * 1000 }).reason).toBe('expired');
        expect(core.checkChallenge({ message: 'x' }, opts).reason).toBe('malformed');
    });

    it('turns a wallet signature into base58 that the member service verifies', () => {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519');
        const message = core.encodeMessage(response.message);
        const signature = sign(null, Buffer.from(message), privateKey);
        const encoded = core.signatureToBase58({ signature: new Uint8Array(signature) });
        expect(core.base58Decode(encoded)).toHaveLength(64);
        const signer = new PublicKey(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')).toBase58();
        // the reference member's own verifier accepts it; a different wallet does not
        expect(verifyWalletSignature({ owner: signer, message: response.message, signature: encoded })).toBe(true);
        expect(verifyWalletSignature({ owner, message: response.message, signature: encoded })).toBe(false);
        expect(core.signatureToBase58(signature)).toBe(encoded);
        expect(() => core.signatureToBase58(new Uint8Array(10))).toThrow(/64-byte/);
    });
});

describe('service responses', () => {
    it('classifies member-service answers', () => {
        expect(core.classifyServiceResponse(201, {}).kind).toBe('ok');
        expect(core.classifyServiceResponse(402, { error: 'Payment required.' })).toMatchObject({ kind: 'payment_required', message: 'Payment required.' });
        expect(core.classifyServiceResponse(503, { error: 'operator_not_configured', message: 'LENS_OPERATOR_TOKEN is not set' }))
            .toMatchObject({ kind: 'not_configured', code: 'operator_not_configured', message: 'LENS_OPERATOR_TOKEN is not set' });
        expect(core.classifyServiceResponse(403, { error: 'owner_not_recorded', message: 'wallet x is not a recorded owner' }))
            .toMatchObject({ kind: 'refused', code: 'owner_not_recorded' });
        expect(core.classifyServiceResponse(500, null)).toMatchObject({ kind: 'error', message: null });
    });

    it('describes the advertised ownership price only when x402 is on', () => {
        expect(core.describeOwnershipPrice({ pricing: { ownership: { mode: 'x402', enabled: true, priceUsdc: '0.01', price: '$0.01', network: 'solana-devnet' } } }))
            .toBe('0.01 USDC (solana-devnet)');
        expect(core.describeOwnershipPrice({ pricing: { ownership: { mode: 'dry-run', enabled: false } } })).toBeNull();
        expect(core.describeOwnershipPrice({})).toBeNull();
    });
});

describe('agreement decision answers', () => {
    const CID = 'bafkreihnfsdwy3dz4ywcukbiknoixg3acqt7jozxg532gbcj54ymys7ale';
    const tally = { ready: true, passed: true, reason: null, acceptedOwners: 4, totalOwners: 4, acceptedAreaM2: 175, totalAreaM2: 175, tests: [] };
    // A 201 of POST /lens/agreements/:cid/decision (backend/lens/server.js).
    const answer = (extra = {}) => ({ address: NOTARY, kind: 'decision', reused: false, counted: 4, tally,
        payload: { agreementCid: CID, sponsor: COURT, decision: 'satisfied', evidenceRef: `sha256:${'a'.repeat(64)}`, sourceObservedAt: 1_800_000_000 }, ...extra });

    it('reads the decision the member reports for the agreement that was asked about', () => {
        expect(core.readDecisionAnswer(answer(), CID)).toEqual({ ok: true, reason: null, address: NOTARY, reused: false, decision: 'satisfied', counted: 4,
            tally: { passed: true, ready: true, reason: null, acceptedOwners: 4, totalOwners: 4, acceptedAreaM2: 175, totalAreaM2: 175 } });
        expect(core.readDecisionAnswer(answer({ reused: true }), CID)).toMatchObject({ ok: true, reused: true });
    });

    it('refuses an answer about another agreement or of another kind, and a malformed one', () => {
        expect(core.readDecisionAnswer(answer(), 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy')).toEqual({ ok: false, reason: 'wrong_agreement' });
        expect(core.readDecisionAnswer(answer({ kind: 'ownership' }), CID)).toEqual({ ok: false, reason: 'wrong_agreement' });
        expect(core.readDecisionAnswer({ ...answer(), address: ' ' }, CID)).toEqual({ ok: false, reason: 'malformed' });
        expect(core.readDecisionAnswer(null, CID)).toEqual({ ok: false, reason: 'malformed' });
    });

    it('keeps counts the answer does not carry as null, never 0', () => {
        expect(core.describeDecisionTally({ ready: false, passed: false, reason: 'rights-incomplete' }))
            .toEqual({ passed: false, ready: false, reason: 'rights-incomplete', acceptedOwners: null, totalOwners: null, acceptedAreaM2: null, totalAreaM2: null });
        expect(core.describeDecisionTally({ passed: 'yes', acceptedOwners: -1, totalOwners: 2.5, acceptedAreaM2: Number.NaN, totalAreaM2: '10' }))
            .toMatchObject({ passed: false, acceptedOwners: null, totalOwners: null, acceptedAreaM2: null, totalAreaM2: null });
        expect(core.describeDecisionTally(null)).toBeNull();
        expect(core.readDecisionAnswer(answer({ counted: -2, tally: undefined }), CID)).toMatchObject({ ok: true, counted: null, tally: null });
    });
});
