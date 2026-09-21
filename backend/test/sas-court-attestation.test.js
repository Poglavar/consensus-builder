import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { COURT_ATTESTER, COURT_CREDENTIAL, COURT_SCHEMA, SAS_PROGRAM_ID } from '../oracle/court-parcel-operation.js';
import { assertCourtAttestation, decodeCourtAttestation } from '../oracle/sas-court-attestation.js';

function borshString(value) {
    const bytes = Buffer.from(value, 'utf8');
    const out = Buffer.alloc(4 + bytes.length);
    out.writeUInt32LE(bytes.length);
    bytes.copy(out, 4);
    return out;
}

function int64(value) {
    const out = Buffer.alloc(8);
    out.writeBigInt64LE(BigInt(value));
    return out;
}

function account({ sourceObservedAt, expiry = 2_000_000_000n } = {}) {
    const credential = new PublicKey(COURT_CREDENTIAL);
    const schema = new PublicKey(COURT_SCHEMA);
    const authority = new PublicKey(COURT_ATTESTER);
    const fields = ['HR-335347-1208/3', 'decision-42', 'transfer', 'https://court.example/42'];
    const payload = Buffer.concat([
        ...fields.map(borshString),
        ...(sourceObservedAt === undefined
            ? []
            : [int64(sourceObservedAt)])
    ]);
    const data = Buffer.alloc(101);
    data[0] = 2;
    credential.toBuffer().copy(data, 33);
    schema.toBuffer().copy(data, 65);
    data.writeUInt32LE(payload.length, 97);
    const complete = Buffer.concat([data, payload, authority.toBuffer(), Buffer.alloc(8)]);
    complete.writeBigInt64LE(expiry, complete.length - 8);
    return { owner: new PublicKey(SAS_PROGRAM_ID), data: complete };
}

describe('CourtParcelOperation SAS decoder', () => {
    it('decodes the live V1 shape without inventing a source timestamp', () => {
        const info = account();
        const evidence = decodeCourtAttestation(info);
        expect(evidence).toMatchObject({
            version: 1,
            fields: {
                parcelUid: 'HR-335347-1208/3',
                decisionUuid: 'decision-42',
                operation: 'transfer',
                decisionLink: 'https://court.example/42'
            }
        });
        expect(evidence.fields).not.toHaveProperty('sourceObservedAt');
        expect(evidence.accountHash).toBe(createHash('sha256').update(info.data).digest('hex'));
    });

    it('decodes V2 int64 source time and requires it for prospective use', () => {
        const evidence = decodeCourtAttestation(account({ sourceObservedAt: 1_900_000_100 }));
        expect(evidence).toMatchObject({ version: 2, fields: { sourceObservedAt: 1_900_000_100 } });
        expect(assertCourtAttestation(evidence, {
            credential: COURT_CREDENTIAL,
            schema: COURT_SCHEMA,
            attester: COURT_ATTESTER,
            requireSourceTime: true,
            nowSeconds: 1_900_000_200
        })).toBe(evidence);
    });

    it('rejects malformed V2 tails, expired evidence and V1 when source time is required', () => {
        const malformed = account();
        malformed.data = Buffer.concat([malformed.data.subarray(0, -40), Buffer.from([0]), malformed.data.subarray(-40)]);
        malformed.data.writeUInt32LE(malformed.data.readUInt32LE(97) + 1, 97);
        expect(() => decodeCourtAttestation(malformed)).toThrow(/sourceObservedAt/);

        const expired = decodeCourtAttestation(account({ expiry: 100n }));
        expect(() => assertCourtAttestation(expired, {
            credential: COURT_CREDENTIAL, schema: COURT_SCHEMA, attester: COURT_ATTESTER, nowSeconds: 101
        })).toThrow(/expired/);

        const v1 = decodeCourtAttestation(account());
        expect(() => assertCourtAttestation(v1, {
            credential: COURT_CREDENTIAL, schema: COURT_SCHEMA, attester: COURT_ATTESTER,
            requireSourceTime: true, nowSeconds: 1_900_000_000
        })).toThrow(/sourceObservedAt is missing/);
    });
});
