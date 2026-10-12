// Lens-member side of abstract proposal approval: compares a proposal's pinned parcel-rights snapshot
// with this member's own registry of abstract owners, then signs two separate facts with the member
// key: "these rights are correct" and "this wallet, which proved control, may act for owner X".
// Members state facts; they never accept proposals. Statement formats: frontend/js/proposals/approval-proof.js.

import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { PublicKey } from '@solana/web3.js';
import { LensError, lensLog } from './errors.js';
import { verifyWalletSignature } from './identity/devnet-registry.js';

const require = createRequire(import.meta.url);
const approval = require('../../frontend/js/proposals/approval.js');
const proof = require('../../frontend/js/proposals/approval-proof.js');
const LensCore = require('../../frontend/js/lens-core.js');

export const REGISTRY_SCHEMA = 'lens-rights-registry/v1';
export const DEFAULT_VALIDITY_SECONDS = 7 * 24 * 3600;
export const CHALLENGE_TTL_SECONDS = 300;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const iso = seconds => new Date(seconds * 1000).toISOString();
const sha256 = value => `sha256:${createHash('sha256').update(approval.stableStringify(value), 'utf8').digest('hex')}`;

function isPubkey(value) {
    try {
        return typeof value === 'string' && new PublicKey(value).toBase58() === value;
    } catch {
        return false;
    }
}

// The member's registry: complete owner lists with exact shares and areas per parcel, plus which
// wallets may act for which abstract owner. No names: owners are opaque, stable IDs.
export function normalizeRegistry(raw) {
    if (!raw || raw.schema !== REGISTRY_SCHEMA) throw new Error(`Expected a ${REGISTRY_SCHEMA} registry.`);
    if (!Array.isArray(raw.parcels) || !Array.isArray(raw.signers)) throw new Error('A rights registry needs parcels and signers arrays.');
    const rights = approval.normalizeRights({
        schema: approval.RIGHTS_SCHEMA,
        source: { provider: 'lens-registry' },
        parcels: raw.parcels.map(parcel => ({
            parcelId: parcel?.parcelId, complete: true, areaM2: parcel?.areaM2 ?? null, owners: parcel?.owners
        }))
    });
    const owners = new Set(rights.parcels.flatMap(parcel => parcel.owners.map(owner => owner.ownerId)));
    const signers = new Map();
    raw.signers.forEach((row, index) => {
        if (!owners.has(row?.ownerId)) throw new Error(`Signer ${index + 1} names an owner with no registered parcel.`);
        if (!isPubkey(row.wallet)) throw new Error(`Signer ${index + 1} needs a base58 wallet public key.`);
        if (!signers.has(row.wallet)) signers.set(row.wallet, new Set());
        signers.get(row.wallet).add(row.ownerId);
    });
    return { parcels: new Map(rights.parcels.map(parcel => [parcel.parcelId, parcel])), signers, owners: owners.size };
}

/**
 * @param {{ keypair: import('@solana/web3.js').Keypair, registry: ReturnType<typeof normalizeRegistry>,
 *   clock: { nowSeconds(): number }, validitySeconds?: number, ttlSeconds?: number }} options
 */
export function createApprovalAttester({ keypair, registry, clock, validitySeconds = DEFAULT_VALIDITY_SECONDS, ttlSeconds = CHALLENGE_TTL_SECONDS }) {
    if (!keypair?.secretKey || keypair.secretKey.length !== 64) throw new Error('createApprovalAttester: a signing keypair is required');
    if (!registry?.parcels || !registry?.signers) throw new Error('createApprovalAttester: a normalized registry is required');
    if (!clock) throw new Error('createApprovalAttester: clock is required');
    if (!(validitySeconds > 0)) throw new Error('createApprovalAttester: validitySeconds must be positive');
    const member = keypair.publicKey.toBase58();
    const privateKey = createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(keypair.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8'
    });
    const challenges = new Map();

    // The proposal's own approval context, recomputed here, and the member's verdict on its rights.
    // Only in-scope parcels (the proposal's cadastral parcels) count; others in the snapshot do not.
    function checkContext(body) {
        const input = { cadastreParcelIds: body?.cadastreParcelIds, approvalConfig: body?.approvalConfig, lens: body?.lens };
        let content, contextHash, state;
        try {
            content = approval.contextContent(input);
            contextHash = approval.contextHash(input);
            state = approval.inspect(input);
        } catch (error) {
            throw new LensError(400, 'bad_request', error.message);
        }
        if (!content.lens.includes(member)) {
            throw new LensError(409, 'not_in_lens', 'this lens member is not in the proposal lens, so its attestations would not count');
        }
        if (!state.ready) throw new LensError(422, 'rights_incomplete', `the approval context cannot be attested: ${state.reason}`);
        for (const parcel of state.parcels) {
            const known = registry.parcels.get(parcel.parcelId);
            if (!known) throw new LensError(404, 'unknown_parcel', `parcel ${parcel.parcelId} is not in this member's registry`);
            if (approval.stableStringify(known.owners) !== approval.stableStringify(parcel.owners)) {
                throw new LensError(409, 'rights_mismatch', `parcel ${parcel.parcelId}: the owners or shares differ from this member's registry`);
            }
            if (known.areaM2 !== parcel.areaM2) {
                throw new LensError(409, 'area_mismatch', `parcel ${parcel.parcelId}: the declared area differs from this member's registry`);
            }
        }
        return { content, contextHash, state };
    }

    function signFact(fields) {
        const statement = proof.statementOf(fields);
        const signature = sign(null, Buffer.from(proof.attestationMessage(statement), 'utf8'), privateKey);
        return { ...statement, signature: LensCore.base58Encode(new Uint8Array(signature)) };
    }

    function validity() {
        const now = clock.nowSeconds();
        return { issuedAt: iso(now), expiresAt: iso(now + validitySeconds) };
    }

    function rightsFact(context) {
        return signFact({
            schema: proof.RIGHTS_SCHEMA, member, contextHash: context.contextHash,
            parcelIds: context.content.cadastreParcelIds,
            evidenceRef: sha256({ kind: 'lens-rights', member, contextHash: context.contextHash, parcels: context.state.parcels }),
            ...validity()
        });
    }

    function prune(now) {
        for (const [nonce, entry] of challenges) if (entry.expiresAt < now) challenges.delete(nonce);
    }

    return {
        member,

        status() {
            return { enabled: true, parcels: registry.parcels.size, owners: registry.owners, signers: registry.signers.size, validitySeconds };
        },

        // Anyone may ask whether a snapshot is right; the answer names no wallet.
        attestRights(body) {
            const context = checkContext(body);
            const fact = rightsFact(context);
            lensLog(`attested rights for approval context ${context.contextHash} (${context.state.parcels.length} parcel(s))`);
            return fact;
        },

        issueChallenge({ wallet, contextHash }) {
            if (!isPubkey(wallet)) throw new LensError(400, 'bad_request', 'wallet must be a base58 public key');
            if (typeof contextHash !== 'string' || !contextHash.trim() || contextHash.length > 256) {
                throw new LensError(400, 'bad_request', 'contextHash is required');
            }
            const now = clock.nowSeconds();
            prune(now);
            const challenge = randomBytes(24).toString('base64url');
            const expiresAt = now + ttlSeconds;
            const message = proof.approvalChallengeMessage({ member, wallet, contextHash, challenge, expiresAt: iso(expiresAt) });
            challenges.set(challenge, { wallet, contextHash, message, expiresAt });
            return { challenge, message, expiresAt: iso(expiresAt) };
        },

        // The wallet proved control by signing the challenge; it learns only the owners it may act for.
        attestAuthority({ wallet, challenge, signature, ...body }) {
            const now = clock.nowSeconds();
            prune(now);
            const entry = typeof challenge === 'string' ? challenges.get(challenge) : null;
            if (!entry) throw new LensError(401, 'challenge_unknown', 'challenge is unknown or expired; request a new one');
            if (entry.wallet !== wallet) throw new LensError(401, 'challenge_mismatch', 'challenge was issued for another wallet');
            if (!verifyWalletSignature({ owner: wallet, message: entry.message, signature })) {
                throw new LensError(401, 'bad_signature', 'signature does not verify for this wallet and challenge');
            }
            const context = checkContext(body);
            if (context.contextHash !== entry.contextHash) {
                throw new LensError(409, 'context_mismatch', 'the challenge was issued for another approval context');
            }
            const ownerIds = context.state.ownerIds.filter(ownerId => registry.signers.get(wallet)?.has(ownerId));
            if (!ownerIds.length) {
                throw new LensError(403, 'not_authorized', 'this wallet may not act for any owner in this approval context');
            }
            challenges.delete(challenge);
            const rights = rightsFact(context);
            const authority = ownerIds.map(ownerId => signFact({
                schema: proof.AUTHORITY_SCHEMA, member, contextHash: context.contextHash, ownerId, actorId: wallet,
                evidenceRef: sha256({ kind: 'lens-authority', member, contextHash: context.contextHash, ownerId, wallet }),
                ...validity()
            }));
            lensLog(`attested ${ownerIds.length} owner authority(ies) for wallet ${wallet} in approval context ${context.contextHash}`);
            return { rights, authority };
        }
    };
}
