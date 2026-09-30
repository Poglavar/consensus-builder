// The two lens-model SAS schemas (ParcelOwnership-v1, ProposalVerdict-v1) as data, with their borsh payload codec, a generic SAS attestation account parser, payload
// validators and the sas-lib credential/schema PDA derivations. Pure: no network, no database.
// Layout strings are frozen by lens-model.md; programs, parsers and the frontend must agree on bytes.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { SAS_PROGRAM_ID } from './court-parcel-operation.js';

export { SAS_PROGRAM_ID };

// SAS layout byte per field type (sas-lib / SAS program IDL: U8=0 … I64=8 … String=12).
export const SAS_LAYOUT_TYPES = Object.freeze({ uint8: 0, int64: 8, string: 12 });

function schemaDefinition(kind, name, description, layout) {
    const fields = layout.split(',').map((entry) => {
        const [type, fieldName] = entry.trim().split(/\s+/);
        if (!(type in SAS_LAYOUT_TYPES)) throw new Error(`unsupported lens field type ${type}`);
        return Object.freeze({ name: fieldName, type });
    });
    return Object.freeze({
        kind,
        id: `${name}-v1`,
        name,
        version: 1,
        description,
        layout,
        fields: Object.freeze(fields),
        sasLayout: Object.freeze(fields.map(field => SAS_LAYOUT_TYPES[field.type]))
    });
}

export const LENS_SCHEMAS = Object.freeze({
    ownership: schemaDefinition(
        'ownership',
        'ParcelOwnership',
        'A lens member attests that a wallet owns a cadastral parcel as of a source time.',
        'string parcelUid, string owner, uint8 ownerCount, string evidenceRef, int64 sourceObservedAt'
    ),
    verdict: schemaDefinition(
        'verdict',
        'ProposalVerdict',
        'A lens member attests that a proposal was executed or has expired.',
        'string proposalAccount, string verdict, string evidenceRef, int64 sourceObservedAt'
    )
});

export const LENS_SCHEMA_KINDS = Object.freeze(Object.keys(LENS_SCHEMAS));

function schemaOf(kind) {
    const schema = LENS_SCHEMAS[kind];
    if (!schema) throw new Error(`unknown lens schema kind ${kind}`);
    return schema;
}

// ---- hashing ------------------------------------------------------------------------------------

export function sha256Hex(bytes) {
    return createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)).digest('hex');
}

// ---- borsh payload codec ------------------------------------------------------------------------

function int64Of(value, label) {
    const parsed = typeof value === 'bigint' ? value
        : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value)
            : null;
    if (parsed === null) throw new Error(`${label} must be an integer`);
    if (parsed < -(2n ** 63n) || parsed >= 2n ** 63n) throw new Error(`${label} does not fit int64`);
    return parsed;
}

export function encodeLensPayload(kind, values = {}) {
    const parts = [];
    for (const field of schemaOf(kind).fields) {
        const value = values[field.name];
        if (field.type === 'string') {
            if (typeof value !== 'string') throw new Error(`${field.name} must be a string`);
            const bytes = Buffer.from(value, 'utf8');
            const length = Buffer.alloc(4);
            length.writeUInt32LE(bytes.length);
            parts.push(length, bytes);
        } else if (field.type === 'uint8') {
            if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${field.name} must be a uint8`);
            parts.push(Buffer.from([value]));
        } else {
            const out = Buffer.alloc(8);
            out.writeBigInt64LE(int64Of(value, field.name));
            parts.push(out);
        }
    }
    return Buffer.concat(parts);
}

export function decodeLensPayload(kind, bytes) {
    const data = Buffer.from(bytes);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let offset = 0;
    const need = (count, name) => {
        if (offset + count > data.length) throw new Error(`truncated ${kind} payload at ${name}`);
    };
    const out = {};
    for (const field of schemaOf(kind).fields) {
        if (field.type === 'string') {
            need(4, field.name);
            const length = data.readUInt32LE(offset);
            offset += 4;
            need(length, field.name);
            out[field.name] = decoder.decode(data.subarray(offset, offset + length));
            offset += length;
        } else if (field.type === 'uint8') {
            need(1, field.name);
            out[field.name] = data[offset];
            offset += 1;
        } else {
            need(8, field.name);
            const value = data.readBigInt64LE(offset);
            if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new Error(`${field.name} is outside the safe integer range`);
            }
            out[field.name] = Number(value);
            offset += 8;
        }
    }
    if (offset !== data.length) throw new Error(`${kind} payload has ${data.length - offset} trailing bytes`);
    return out;
}

// ---- SAS attestation account --------------------------------------------------------------------
// Same layout as sas-court-attestation.js: discriminator u8 (2) | nonce 32 | credential 32 |
// schema 32 | data (u32 LE length + bytes) | signer 32 | expiry i64 LE | [token account 32].

export const SAS_ATTESTATION_DISCRIMINATOR = 2;
const DATA_OFFSET = 101;

export function parseLensAttestation(accountBytes) {
    const data = Buffer.from(accountBytes);
    if (data.length < DATA_OFFSET + 40 || data[0] !== SAS_ATTESTATION_DISCRIMINATOR) {
        throw new Error('account is not a SAS attestation');
    }
    const payloadLength = data.readUInt32LE(97);
    const payloadEnd = DATA_OFFSET + payloadLength;
    if (payloadEnd + 40 > data.length) throw new Error('truncated SAS attestation record');
    return {
        nonce: new PublicKey(data.subarray(1, 33)).toBase58(),
        credential: new PublicKey(data.subarray(33, 65)).toBase58(),
        schema: new PublicKey(data.subarray(65, 97)).toBase58(),
        authority: new PublicKey(data.subarray(payloadEnd, payloadEnd + 32)).toBase58(),
        expiry: data.readBigInt64LE(payloadEnd + 32),
        payload: data.subarray(DATA_OFFSET, payloadEnd)
    };
}

// Builds the account bytes a SAS attestation would have; used by tests and local tooling so the
// parser is exercised against the exact on-chain layout.
export function buildSasAttestationAccount({ nonce, credential, schema, payload, authority, expiry, tokenAccount = PublicKey.default }) {
    const key = value => new PublicKey(value).toBuffer();
    const length = Buffer.alloc(4);
    length.writeUInt32LE(payload.length);
    const expiryBytes = Buffer.alloc(8);
    expiryBytes.writeBigInt64LE(BigInt(expiry));
    return Buffer.concat([
        Buffer.from([SAS_ATTESTATION_DISCRIMINATOR]),
        key(nonce), key(credential), key(schema),
        length, Buffer.from(payload),
        key(authority), expiryBytes, key(tokenAccount)
    ]);
}

// ---- validators ---------------------------------------------------------------------------------
// Each returns the fields unchanged or throws with the first violated rule. `nowSeconds`, when
// given, also enforces the contract's "source time is not in the future" check.

function isBase58Pubkey(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        return new PublicKey(value).toBase58() === value;
    } catch {
        return false;
    }
}

function requireText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function requireTime(value, label, nowSeconds) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive Unix timestamp`);
    if (nowSeconds !== undefined && value > nowSeconds) throw new Error(`${label} is in the future`);
}

export function validateOwnership(fields, { nowSeconds } = {}) {
    requireText(fields?.parcelUid, 'parcelUid');
    if (!isBase58Pubkey(fields.owner)) throw new Error('owner must be a base58 public key');
    if (!Number.isInteger(fields.ownerCount) || fields.ownerCount < 1 || fields.ownerCount > 255) {
        throw new Error('ownerCount must be an integer from 1 to 255');
    }
    if (typeof fields.evidenceRef !== 'string') throw new Error('evidenceRef must be a string');
    requireTime(fields.sourceObservedAt, 'sourceObservedAt', nowSeconds);
    return fields;
}

export const LENS_VERDICTS = Object.freeze(['executed', 'expired']);

export function validateVerdict(fields, { nowSeconds } = {}) {
    if (!isBase58Pubkey(fields?.proposalAccount)) throw new Error('proposalAccount must be a base58 public key');
    if (!LENS_VERDICTS.includes(fields.verdict)) throw new Error('verdict must be "executed" or "expired"');
    if (typeof fields.evidenceRef !== 'string') throw new Error('evidenceRef must be a string');
    requireTime(fields.sourceObservedAt, 'sourceObservedAt', nowSeconds);
    return fields;
}

export const LENS_VALIDATORS = Object.freeze({
    ownership: validateOwnership,
    verdict: validateVerdict
});

// Parse + decode + validate in one step, for a caller that already knows which schema it expects.
export function decodeLensAttestation(kind, accountBytes, options = {}) {
    const attestation = parseLensAttestation(accountBytes);
    const fields = LENS_VALIDATORS[kind](decodeLensPayload(kind, attestation.payload), options);
    return { ...attestation, kind, fields, accountHash: sha256Hex(accountBytes) };
}

// ---- PDA derivations ----------------------------------------------------------------------------
// Byte-identical to sas-lib 1.0.10 deriveCredentialPda / deriveSchemaPda (src/pdas.ts):
//   credential = PDA(["credential", authority, name])
//   schema     = PDA(["schema", credential, name, u8 version])

const SAS_PROGRAM = new PublicKey(SAS_PROGRAM_ID);

function nameSeed(name) {
    const bytes = Buffer.from(String(name), 'utf8');
    if (!bytes.length || bytes.length > 32) throw new Error('SAS names must be 1-32 bytes (PDA seed limit)');
    return bytes;
}

export function deriveCredentialPda({ authority, name }) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('credential'), new PublicKey(authority).toBuffer(), nameSeed(name)],
        SAS_PROGRAM
    )[0].toBase58();
}

export function deriveSchemaPda({ credential, name, version }) {
    if (!Number.isInteger(version) || version < 1 || version > 255) throw new Error('schema version must be 1-255');
    return PublicKey.findProgramAddressSync(
        [Buffer.from('schema'), new PublicKey(credential).toBuffer(), nameSeed(name), Buffer.from([version])],
        SAS_PROGRAM
    )[0].toBase58();
}

// Every lens member issues under its own credential, so the schema PDAs are per authority. An
// owner's yes is its signature on the accept transaction, not a SAS attestation.
export function deriveLensSchemaPdas({ authority, credentialName }) {
    const credential = deriveCredentialPda({ authority, name: credentialName });
    const schemas = Object.fromEntries(LENS_SCHEMA_KINDS.map(kind => {
        const { name, version } = LENS_SCHEMAS[kind];
        return [kind, deriveSchemaPda({ credential, name, version })];
    }));
    return { credential, schemas };
}

// Public description served by GET /lenses/schemas.
export function describeLensSchemas() {
    return LENS_SCHEMA_KINDS.map(kind => {
        const { id, name, version, description, layout, fields, sasLayout } = LENS_SCHEMAS[kind];
        return { kind, id, name, version, description, layout, fields, sasLayout };
    });
}
