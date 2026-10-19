// Devnet stand-in identity adapter for the reference lens member: the owner set of a parcel comes
// from consensus.lens_devnet_owner (or an in-memory row list for dry runs and tests), and a wallet
// proves control by signing a server-issued challenge (ed25519, verified with node:crypto).

import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getBase58Encoder } from '@solana/kit';
import { LensError } from '../errors.js';

export const CHALLENGE_TTL_SECONDS = 300;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function secondsOf(value) {
    if (value === null || value === undefined) return null;
    const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value * 1000 : Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function rowOf(row) {
    return {
        parcelUid: row.parcel_uid ?? row.parcelUid,
        owner: row.owner_wallet ?? row.owner,
        ownerCount: Number(row.owner_count ?? row.ownerCount),
        establishedAt: secondsOf(row.established_at ?? row.establishedAt)
    };
}

// The exact UTF-8 text a wallet signs (Phantom/Solflare signMessage).
export function challengeMessage({ authority, parcelUid, owner, nonce, expiresAt }) {
    return [
        `Urban Game Theory lens member ${authority}`,
        `Wallet ${owner} asks to be attested as an owner of parcel ${parcelUid}.`,
        `Challenge: ${nonce}`,
        `Expires: ${new Date(expiresAt * 1000).toISOString()}`
    ].join('\n');
}

// Base58 (wallet default) or base64; must decode to 64 bytes.
export function decodeSignature(signature) {
    if (typeof signature !== 'string' || !signature) return null;
    try {
        const bytes = Buffer.from(getBase58Encoder().encode(signature));
        if (bytes.length === 64) return bytes;
    } catch { /* not base58 */ }
    const bytes = Buffer.from(signature, 'base64');
    return bytes.length === 64 ? bytes : null;
}

export function verifyWalletSignature({ owner, message, signature }) {
    const sig = decodeSignature(signature);
    if (!sig) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(owner).toBuffer()]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, sig);
}

/**
 * @param {{ pool?: import('pg').Pool, rows?: object[], clock: { nowSeconds(): number }, authority: string }} options
 * Exactly one of `pool` (reads consensus.lens_devnet_owner) or `rows` (in-memory) is required.
 */
export function createDevnetRegistryIdentity({ pool = null, rows = null, clock, authority, ttlSeconds = CHALLENGE_TTL_SECONDS }) {
    if (!pool === !rows) throw new Error('devnet-registry: pass exactly one of pool or rows');
    if (!authority) throw new Error('devnet-registry: authority is required (it is named in the signed challenge)');
    const memory = rows ? rows.map(rowOf) : null;
    const challenges = new Map();

    function prune(now) {
        for (const [nonce, entry] of challenges) if (entry.expiresAt < now) challenges.delete(nonce);
    }

    async function ownerSet(parcelUid) {
        if (memory) return memory.filter(row => row.parcelUid === parcelUid);
        const result = await pool.query(`
            SELECT parcel_uid, owner_wallet, owner_count, established_at
            FROM consensus.lens_devnet_owner
            WHERE parcel_uid = $1
            ORDER BY owner_wallet
        `, [parcelUid]);
        return result.rows.map(rowOf);
    }

    return {
        kind: 'devnet-registry',
        ownerSet,

        async issueChallenge({ parcelUid, owner }) {
            const rowsForParcel = await ownerSet(parcelUid);
            if (!rowsForParcel.length) throw new LensError(404, 'unknown_parcel', `no recorded owners for parcel ${parcelUid}`);
            if (!rowsForParcel.some(row => row.owner === owner)) {
                throw new LensError(403, 'owner_not_recorded', `wallet ${owner} is not a recorded owner of parcel ${parcelUid}`);
            }
            const now = clock.nowSeconds();
            prune(now);
            const nonce = randomBytes(24).toString('base64url');
            const expiresAt = now + ttlSeconds;
            const message = challengeMessage({ authority, parcelUid, owner, nonce, expiresAt });
            challenges.set(nonce, { parcelUid, owner, message, expiresAt });
            return { challenge: nonce, message, expiresAt: new Date(expiresAt * 1000).toISOString() };
        },

        // Checks the signature over the stored challenge text; the challenge stays usable until
        // consume() so a payment that fails after this check can be retried.
        async verifyOwner({ parcelUid, owner, signature, challenge }) {
            const now = clock.nowSeconds();
            prune(now);
            const entry = challenges.get(challenge);
            if (!entry) throw new LensError(401, 'challenge_unknown', 'challenge is unknown or expired; request a new one');
            if (entry.parcelUid !== parcelUid || entry.owner !== owner) {
                throw new LensError(401, 'challenge_mismatch', 'challenge was issued for another parcel or wallet');
            }
            if (!verifyWalletSignature({ owner, message: entry.message, signature })) {
                throw new LensError(401, 'bad_signature', 'signature does not verify for this wallet and challenge');
            }
            return { verified: true };
        },

        consume(challenge) {
            challenges.delete(challenge);
        }
    };
}
