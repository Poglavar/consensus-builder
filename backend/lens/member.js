// The reference lens member (lens-model.md, "Reference lens member") as a library: one key, one SAS
// credential, issuing ParcelOwnership-v1 and ProposalVerdict-v1 attestations. Identity proof, the
// SAS issuer, the attestation store and the clock are injected, so every rule here runs headless.

import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
    LENS_SCHEMAS,
    SAS_PROGRAM_ID,
    decodeLensPayload,
    deriveCredentialPda,
    deriveSchemaPda,
    encodeLensPayload,
    parseLensAttestation,
    sha256Hex,
    validateOwnership,
    validateVerdict
} from '../oracle/lens-schemas.js';
import { LensError, lensLog } from './errors.js';

export const DEFAULT_CREDENTIAL_NAME = 'LensMember';
export const DEFAULT_EXPIRY_SECONDS = 365 * 24 * 3600;

export const systemClock = Object.freeze({ nowSeconds: () => Math.floor(Date.now() / 1000) });

// sas-lib 1.0.10 deriveAttestationPda: PDA(["attestation", credential, schema, nonce]).
export function deriveAttestationPda({ credential, schema, nonce }) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('attestation'), new PublicKey(credential).toBuffer(), new PublicKey(schema).toBuffer(), new PublicKey(nonce).toBuffer()],
        new PublicKey(SAS_PROGRAM_ID)
    )[0].toBase58();
}

// Deterministic nonce: the same fact from the same member always lands on the same attestation
// address, so a retry finds what was already issued instead of issuing a twin. A new owner set has
// a new source time and therefore a new address.
export function factNonce(parts) {
    return new PublicKey(createHash('sha256').update(parts.join('|'), 'utf8').digest()).toBase58();
}

// The fact the member will state about `owner` on `parcelUid`, from the identity adapter's owner
// set. ownerCount is the recognised owner count (every row must agree and cover the rows present);
// sourceObservedAt is when that owner set came to be (the latest established_at in it). A row
// without a source time makes the whole parcel unattestable: the time is never invented.
export function ownershipFromOwnerSet(rows, { parcelUid, owner }) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new LensError(404, 'unknown_parcel', `no recorded owners for parcel ${parcelUid}`);
    }
    if (!rows.some(row => row.owner === owner)) {
        throw new LensError(403, 'owner_not_recorded', `wallet ${owner} is not a recorded owner of parcel ${parcelUid}`);
    }
    const missing = rows.filter(row => !(typeof row.establishedAt === 'number' && Number.isFinite(row.establishedAt)));
    if (missing.length) {
        throw new LensError(422, 'source_time_missing',
            `parcel ${parcelUid}: ${missing.length} recorded owner(s) have no established_at; refusing to attest without a source time`);
    }
    const counts = new Set(rows.map(row => row.ownerCount));
    if (counts.size !== 1) {
        throw new LensError(409, 'registry_inconsistent', `parcel ${parcelUid}: recorded owners disagree on owner_count (${[...counts].join(', ')})`);
    }
    const ownerCount = rows[0].ownerCount;
    if (!Number.isInteger(ownerCount) || ownerCount < rows.length) {
        throw new LensError(409, 'registry_inconsistent', `parcel ${parcelUid}: owner_count ${ownerCount} is below the ${rows.length} recorded owners`);
    }
    const sourceObservedAt = Math.max(...rows.map(row => row.establishedAt));
    const evidenceRef = `sha256:${sha256Hex(['lens-owner-set', parcelUid, ownerCount, sourceObservedAt,
        ...rows.map(row => row.owner).sort()].join('|'))}`;
    return { parcelUid, owner, ownerCount, sourceObservedAt, evidenceRef };
}

function schemaAddresses(credential) {
    const derive = kind => deriveSchemaPda({ credential, name: LENS_SCHEMAS[kind].name, version: LENS_SCHEMAS[kind].version });
    return { ownership: derive('ownership'), verdict: derive('verdict') };
}

export function createLensMember({
    keypair = null,
    authority: authorityOverride = null,
    credentialName = DEFAULT_CREDENTIAL_NAME,
    kind = 'owner-consent',
    issuer,
    store,
    identity,
    clock = systemClock,
    expirySeconds = DEFAULT_EXPIRY_SECONDS,
    dryRun = false
}) {
    if (!issuer || typeof issuer.createAttestation !== 'function') throw new Error('createLensMember: issuer.createAttestation is required');
    if (!store) throw new Error('createLensMember: store is required');
    if (!identity) throw new Error('createLensMember: identity adapter is required');
    // No key file (dry run): the authority is an ephemeral or borrowed public key that signs nothing,
    // reported as such by status().
    const ephemeral = !keypair;
    const authority = keypair ? keypair.publicKey.toBase58()
        : authorityOverride ? new PublicKey(authorityOverride).toBase58()
            : Keypair.generate().publicKey.toBase58();
    if (issuer.authority && issuer.authority !== authority) {
        throw new Error(`issuer signs as ${issuer.authority} but the member key is ${authority}`);
    }
    const credential = deriveCredentialPda({ authority, name: credentialName });
    const schemas = schemaAddresses(credential);

    // Issue, then verify the artifact the issuer returned: address, authority, credential, schema and
    // payload bytes must be the ones we asked for before anything is recorded.
    async function issue(schemaKind, fields, nonce, extra) {
        const schema = schemas[schemaKind];
        const address = deriveAttestationPda({ credential, schema, nonce });
        const existing = await store.get(address);
        if (existing) {
            lensLog(`${schemaKind} ${address} already issued, returning the stored record`);
            return { ...existing, reused: true };
        }
        const payload = encodeLensPayload(schemaKind, fields);
        const expiry = clock.nowSeconds() + expirySeconds;
        const result = await issuer.createAttestation({ credential, schema, payload, expiry, nonce, address });
        if (result.address !== address) throw new Error(`issuer returned attestation ${result.address}, expected ${address}`);
        const account = parseLensAttestation(result.accountBytes);
        if (account.authority !== authority || account.credential !== credential || account.schema !== schema) {
            throw new Error(`issued attestation ${address} does not carry this member's authority/credential/schema`);
        }
        if (!Buffer.from(account.payload).equals(payload)) throw new Error(`issued attestation ${address} payload differs from the request`);
        const record = {
            address,
            kind: schemaKind,
            credential,
            schema,
            authority,
            parcelUid: fields.parcelUid ?? null,
            proposalAccount: fields.proposalAccount ?? null,
            owner: fields.owner ?? null,
            payload: decodeLensPayload(schemaKind, account.payload),
            accountHash: sha256Hex(result.accountBytes),
            expiry: Number(account.expiry),
            transactionSignature: result.signature ?? null,
            payment: extra.payment ?? null,
            // Chain time of the issuing transaction; null when the issuer could not learn it.
            issuedAt: typeof result.issuedAt === 'number' && Number.isFinite(result.issuedAt)
                ? new Date(result.issuedAt * 1000).toISOString() : null
        };
        await store.record(record);
        lensLog(`issued ${schemaKind} ${address} (${schemaKind === 'ownership' ? `parcel ${record.parcelUid}, owner ${record.owner}` : `proposal ${record.proposalAccount}, ${fields.verdict}`})`);
        return { ...record, reused: false };
    }

    // What the member would attest for (parcelUid, owner) right now, and whether it already has:
    // the server runs this before asking for payment so every refusal is free.
    // evidenceRef and sourceObservedAt are optional cross-checks: the source time must equal the
    // identity adapter's, and a caller evidenceRef replaces the default opaque owner-set hash.
    async function planOwnership({ parcelUid, owner, evidenceRef, sourceObservedAt }) {
        const rows = await identity.ownerSet(parcelUid);
        const derived = ownershipFromOwnerSet(rows, { parcelUid, owner });
        if (sourceObservedAt !== undefined && sourceObservedAt !== derived.sourceObservedAt) {
            throw new LensError(409, 'source_time_mismatch',
                `sourceObservedAt ${sourceObservedAt} differs from the identity record (${derived.sourceObservedAt})`);
        }
        const fields = { ...derived, evidenceRef: evidenceRef ?? derived.evidenceRef };
        try {
            validateOwnership(fields, { nowSeconds: clock.nowSeconds() });
        } catch (error) {
            throw new LensError(422, 'invalid_ownership', error.message);
        }
        const nonce = factNonce([LENS_SCHEMAS.ownership.id, parcelUid, owner, fields.ownerCount, fields.sourceObservedAt]);
        const address = deriveAttestationPda({ credential, schema: schemas.ownership, nonce });
        return { fields, nonce, address, existing: await store.get(address) };
    }

    return {
        authority,
        credential,
        schemas,
        kind,
        identity,
        async status() {
            return {
                key: authority,
                kind,
                credential,
                credentialName,
                schemas: { ...schemas },
                identity: identity.kind,
                dryRun,
                ephemeralKey: ephemeral,
                counts: await store.counts()
            };
        },

        planOwnership,

        listAttestations(filter = {}) {
            return store.list(filter);
        },

        async attestOwnership({ payment = null, ...request }) {
            const plan = await planOwnership(request);
            return issue('ownership', plan.fields, plan.nonce, { payment });
        },

        async attestVerdict({ proposalAccount, verdict, evidenceRef, sourceObservedAt }) {
            const fields = { proposalAccount, verdict, evidenceRef, sourceObservedAt };
            try {
                validateVerdict(fields, { nowSeconds: clock.nowSeconds() });
            } catch (error) {
                throw new LensError(422, 'invalid_verdict', error.message);
            }
            const nonce = factNonce([LENS_SCHEMAS.verdict.id, proposalAccount, verdict, sourceObservedAt]);
            return issue('verdict', fields, nonce, {});
        }
    };
}
