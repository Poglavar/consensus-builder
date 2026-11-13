// The reference lens member (lens-model.md, "Reference lens member") as a library: one key, one SAS
// credential, issuing ParcelOwnership-v1, AgreementDecision-v1 and MarketEvidence-v1 attestations, and,
// with an EVM issuer (evm-issuer.js), AgreementDecision-v1 through EAS for agreements minted on EVM.
// Identity proof, the SAS issuer, the attestation store and the clock are injected, so every rule here
// runs headless. Which decision an agreement gets is decided before this (agreement-decision.js); the
// member only issues it, at most one decision per agreement.

import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import {
    LENS_SCHEMAS,
    SAS_PROGRAM_ID,
    decodeLensPayload,
    deriveCredentialPda,
    deriveSchemaPda,
    encodeLensPayload,
    parseLensAttestation,
    sha256Hex,
    validateDecision,
    validateMarketEvidence,
    validateOwnership
} from '../oracle/lens-schemas.js';
import { LensError, lensLog } from './errors.js';
import { agreementAddresses } from '../chain/evm.js';
import { isEvmAddress, sameKey } from '../chain/keys.js';
import { encodeDecisionData } from './evm-issuer.js';

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
    return { ownership: derive('ownership'), decision: derive('decision'), evidence: derive('evidence') };
}

// What an issued attestation states, for its log line.
function describeFact(kind, fields) {
    if (kind === 'ownership') return `parcel ${fields.parcelUid}, owner ${fields.owner}`;
    if (kind === 'decision') return `agreement ${fields.agreementCid} of ${fields.sponsor}, ${fields.decision}`;
    return `recipe ${fields.recipeHash}, "${fields.value}", event ${new Date(fields.eventTime * 1000).toISOString()}`;
}

// What a member attests about, reported as `kind` by /lens/status (lens-model.md member kinds).
export const LENS_MEMBER_KINDS = Object.freeze(['owner-consent', 'court', 'permit', 'imagery', 'osm', 'lifecycle']);

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
    dryRun = false,
    evmIssuer = null
}) {
    if (!issuer || typeof issuer.createAttestation !== 'function') throw new Error('createLensMember: issuer.createAttestation is required');
    if (evmIssuer && (!isEvmAddress(evmIssuer.address) || typeof evmIssuer.attest !== 'function')) {
        throw new Error('createLensMember: evmIssuer needs an EVM address and attest()');
    }
    // The key this member attests with on EVM (Agreement.sol's `lens`), checksummed; null without an EVM issuer.
    const evmAddress = evmIssuer ? ethers.getAddress(evmIssuer.address) : null;
    if (!store) throw new Error('createLensMember: store is required');
    if (!identity) throw new Error('createLensMember: identity adapter is required');
    if (!LENS_MEMBER_KINDS.includes(kind)) throw new Error(`createLensMember: unknown kind "${kind}" (one of ${LENS_MEMBER_KINDS.join(', ')})`);
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
        lensLog(`issued ${schemaKind} ${address} (${describeFact(schemaKind, fields)})`);
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

    // The MarketEvidence-v1 the member would issue. recipe: { recipeHash, subject }, the recipe's hash
    // and its subject text, both committed by the market; fact: { value, eventTime, sourceObservedAt,
    // sourceRef } as a source adapter reports it (../evidence/sf-dbi-permits.js). The address is per
    // (recipeHash, value, eventTime), so a retry, even one with a later sourceObservedAt, finds the
    // stored attestation. A recipe has one subject: the same key stated for another subject is a
    // conflicting request, not a retry.
    async function planMarketEvidence({ recipe, fact } = {}) {
        const fields = {
            recipeHash: recipe?.recipeHash,
            subject: recipe?.subject,
            value: fact?.value,
            eventTime: fact?.eventTime,
            sourceObservedAt: fact?.sourceObservedAt,
            sourceRef: fact?.sourceRef
        };
        try {
            validateMarketEvidence(fields, { nowSeconds: clock.nowSeconds() });
        } catch (error) {
            throw new LensError(422, 'invalid_market_evidence', error.message);
        }
        const nonce = factNonce([LENS_SCHEMAS.evidence.id, fields.recipeHash, fields.value, fields.eventTime]);
        const address = deriveAttestationPda({ credential, schema: schemas.evidence, nonce });
        const existing = await store.get(address);
        if (existing && existing.payload?.subject !== fields.subject) {
            throw new LensError(409, 'evidence_conflict',
                `attestation ${address} already states recipe ${fields.recipeHash} for subject ${JSON.stringify(existing.payload?.subject)}`);
        }
        return { fields, nonce, address, existing };
    }

    // AgreementDecision-v1 through EAS on the EVM chain the agreement is minted on (`chain.chainId`): at
    // most one per agreement, like the Solana path, since an EAS uid is not derived from the fact.
    async function attestDecisionOnEvm(fields, chain) {
        if (!evmIssuer) throw new LensError(503, 'evm_not_configured', 'this lens member has no EVM key (LENS_EVM_PRIVATE_KEY)');
        let contracts;
        try {
            contracts = agreementAddresses(chain.chainId);
        } catch (error) {
            throw new LensError(422, 'unsupported_chain', error.message);
        }
        const existing = await findDecision({ agreementCid: fields.agreementCid, sponsor: fields.sponsor });
        if (existing) {
            lensLog(`decision ${existing.address} already issued for ${fields.agreementCid}, returning the stored record`);
            return { ...existing, reused: true };
        }
        const schema = contracts.AgreementDecisionSchema;
        const expiry = clock.nowSeconds() + expirySeconds;
        const result = await evmIssuer.attest({ chainId: contracts.chainId, schemaUid: schema, data: encodeDecisionData(fields), expirationTime: expiry });
        if (!/^0x[0-9a-fA-F]{64}$/.test(result?.uid || '') || !/^0x[0-9a-fA-F]{64}$/.test(result?.txHash || '')) {
            throw new Error(`the EVM issuer returned no attestation uid and transaction hash on chain ${contracts.chainId}`);
        }
        const uid = result.uid.toLowerCase();
        const record = {
            address: uid,
            kind: 'decision',
            chain: 'evm',
            chainId: contracts.chainId,
            uid,
            credential: null,
            schema,
            authority: evmAddress,
            parcelUid: null,
            owner: null,
            payload: { ...fields },
            accountHash: null,
            expiry,
            transactionSignature: result.txHash,
            payment: null,
            // The attestation's EAS time; null when the issuer could not learn it.
            issuedAt: typeof result.issuedAt === 'number' && Number.isFinite(result.issuedAt)
                ? new Date(result.issuedAt * 1000).toISOString() : null
        };
        await store.record(record);
        lensLog(`issued decision ${uid} on EVM chain ${contracts.chainId} (${describeFact('decision', fields)})`);
        return { ...record, reused: false };
    }

    // The AgreementDecision this member already issued for the agreement (agreementCid, sponsor),
    // whatever its decision and source time, or null: signed by its Solana key, or by its EVM address
    // for an EVM sponsor. The program and the contract record only the first decision an agreement
    // receives, so the member issues at most one per agreement.
    async function findDecision({ agreementCid, sponsor }) {
        const signer = isEvmAddress(sponsor) ? evmAddress : authority;
        if (!signer) return null;
        const records = await store.list({ kind: 'decision', agreementCid, limit: 50 });
        return records.find(record => record.authority === signer && sameKey(record.payload?.sponsor, sponsor)) ?? null;
    }

    return {
        authority,
        evmAddress,
        credential,
        schemas,
        kind,
        identity,
        async status() {
            return {
                key: authority,
                ...(evmAddress ? { evmAddress } : {}),
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

        findDecision,

        // Issues AgreementDecision-v1 (programs/agreement/README.md). An EVM sponsor's agreement is
        // attested through EAS on the chain it is minted on, `chain` = { family: 'evm', chainId } (the
        // index's onchain.chainId); 409 not_minted without it. Otherwise SAS: the nonce is deterministic
        // per (agreement, sponsor, decision, source time), so a retry lands on the same attestation address.
        async attestDecision({ agreementCid, sponsor, decision, evidenceRef, sourceObservedAt }, { chain = null } = {}) {
            const fields = { agreementCid, sponsor, decision, evidenceRef, sourceObservedAt };
            try {
                validateDecision(fields, { nowSeconds: clock.nowSeconds() });
            } catch (error) {
                throw new LensError(422, 'invalid_decision', error.message);
            }
            if (isEvmAddress(sponsor)) {
                if (chain?.family !== 'evm') {
                    throw new LensError(409, 'not_minted', `agreement ${agreementCid} has an EVM sponsor; its decision is attested on the EVM chain it is minted on, and none is recorded yet`);
                }
                return attestDecisionOnEvm(fields, chain);
            }
            if (chain?.family === 'evm') throw new LensError(422, 'invalid_decision', 'an agreement minted on EVM has an EVM sponsor');
            const nonce = factNonce([LENS_SCHEMAS.decision.id, agreementCid, sponsor, decision, sourceObservedAt]);
            return issue('decision', fields, nonce, {});
        },

        async issueMarketEvidence({ recipe, fact } = {}) {
            const plan = await planMarketEvidence({ recipe, fact });
            return issue('evidence', plan.fields, plan.nonce, {});
        }
    };
}
