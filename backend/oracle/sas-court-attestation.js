// Pure decoder and trust checks for the CourtParcelOperation SAS account shapes consumed by the
// external-market scripts. V1 has four strings; V2 appends one int64 Unix source timestamp.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { SAS_PROGRAM_ID } from './court-parcel-operation.js';

const SAS_ATTESTATION_DISCRIMINATOR = 2;

function publicKey(value, label) {
    try {
        return value instanceof PublicKey ? value : new PublicKey(value);
    } catch {
        throw new Error(`${label} must be a Solana public key`);
    }
}
function readBorshString(data, state) {
    if (state.offset + 4 > data.length) throw new Error('truncated SAS string length');
    const length = data.readUInt32LE(state.offset);
    state.offset += 4;
    if (state.offset + length > data.length) throw new Error('truncated SAS string value');
    const value = new TextDecoder('utf-8', { fatal: true })
        .decode(data.subarray(state.offset, state.offset + length));
    state.offset += length;
    return value;
}

export function decodeCourtAttestation(info, { address = 'unknown' } = {}) {
    if (!info) throw new Error(`SAS attestation ${address} does not exist`);
    if (!publicKey(info.owner, 'attestation owner').equals(new PublicKey(SAS_PROGRAM_ID))) {
        throw new Error('attestation is not owned by SAS');
    }
    const data = Buffer.from(info.data);
    if (data.length < 141 || data[0] !== SAS_ATTESTATION_DISCRIMINATOR) {
        throw new Error('account is not a supported SAS attestation');
    }
    const credential = new PublicKey(data.subarray(33, 65));
    const schema = new PublicKey(data.subarray(65, 97));
    const payloadLength = data.readUInt32LE(97);
    const payloadEnd = 101 + payloadLength;
    const recordEnd = payloadEnd + 40;
    if (recordEnd > data.length) throw new Error('truncated SAS attestation record');
    const authority = new PublicKey(data.subarray(payloadEnd, payloadEnd + 32));
    const expiry = data.readBigInt64LE(payloadEnd + 32);
    const payload = data.subarray(101, payloadEnd);
    const state = { offset: 0 };
    const fields = {
        parcelUid: readBorshString(payload, state),
        decisionUuid: readBorshString(payload, state),
        operation: readBorshString(payload, state),
        decisionLink: readBorshString(payload, state)
    };
    if (state.offset < payload.length) {
        if (payload.length - state.offset !== 8) {
            throw new Error('SAS V2 sourceObservedAt must be one int64');
        }
        const timestamp = payload.readBigInt64LE(state.offset);
        if (timestamp <= 0n || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('SAS V2 sourceObservedAt is outside the supported Unix-time range');
        }
        fields.sourceObservedAt = Number(timestamp);
        state.offset += 8;
    }
    if (state.offset !== payload.length) throw new Error('SAS payload has unexpected trailing fields');
    return {
        credential,
        schema,
        authority,
        expiry,
        fields,
        version: fields.sourceObservedAt ? 2 : 1,
        accountHash: createHash('sha256').update(data).digest('hex')
    };
}

export function assertCourtAttestation(evidence, {
    credential,
    schema,
    attester,
    requireSourceTime = false,
    nowSeconds = Math.floor(Date.now() / 1000)
}) {
    if (!evidence.credential.equals(publicKey(credential, 'credential'))) throw new Error('unexpected SAS credential');
    if (!evidence.schema.equals(publicKey(schema, 'schema'))) throw new Error('unexpected SAS schema');
    if (!evidence.authority.equals(publicKey(attester, 'attester'))) throw new Error('unexpected SAS issuer');
    if (evidence.expiry <= BigInt(nowSeconds)) throw new Error('SAS attestation has expired');
    if (requireSourceTime && evidence.version !== 2) {
        throw new Error('CourtParcelOperationV2 sourceObservedAt is missing');
    }
    return evidence;
}
