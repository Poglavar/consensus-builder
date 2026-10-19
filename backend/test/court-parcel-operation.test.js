import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    buildCourtParcelOperationRecipe,
    buildCourtParcelOperationRecipeV2,
    COURT_ATTESTER,
    COURT_CREDENTIAL,
    COURT_SCHEMA,
    COURT_SCHEMA_V2,
    externalMarketAddress,
    MARKET_PROGRAM_ID,
    SAS_PROGRAM_ID
} from '../oracle/court-parcel-operation.js';
import { canonicalJson } from '../oracle/proposal-lifecycle.js';

const input = {
    parcelUid: 'HR-335347-1208/3',
    yesOperation: 'transfer',
    noOperation: 'no_event',
    closesAt: 1790000000
};

describe('court parcel operation recipe', () => {
    it('commits every value the on-chain SAS verifier checks', () => {
        const recipe = buildCourtParcelOperationRecipe(input);
        const textHash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
        expect(recipe).toMatchObject({
            id: 'court-parcel-operation-v1',
            subject: { chain: 'solana:devnet', parcelUid: input.parcelUid },
            trustedAttesters: [{ address: COURT_ATTESTER, credential: COURT_CREDENTIAL }],
            outcomes: { transfer: 'YES', no_event: 'NO' },
            verification: {
                kind: 'sas_court_parcel_operation_v1',
                permissionless: true,
                sasProgram: SAS_PROGRAM_ID,
                schema: COURT_SCHEMA,
                marketProgram: MARKET_PROGRAM_ID,
                closesAt: input.closesAt,
                commitments: {
                    subjectHash: textHash(input.parcelUid),
                    yesValueHash: textHash(input.yesOperation),
                    noValueHash: textHash(input.noOperation)
                }
            }
        });
        const { hash, ...body } = recipe;
        expect(hash).toBe(`sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`);
        expect(externalMarketAddress(hash)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });

    it('changes both the recipe hash and market when a committed rule changes', () => {
        const first = buildCourtParcelOperationRecipe(input);
        const second = buildCourtParcelOperationRecipe({ ...input, yesOperation: 'parcel_split' });
        expect(second.hash).not.toBe(first.hash);
        expect(externalMarketAddress(second.hash)).not.toBe(externalMarketAddress(first.hash));
    });

    it('builds a V2 recipe whose source time is enforced against the market clock', () => {
        const recipe = buildCourtParcelOperationRecipeV2(input);
        expect(recipe).toMatchObject({
            id: 'court-parcel-operation-v2',
            version: 2,
            verification: {
                kind: 'sas_court_parcel_operation_v2',
                schema: COURT_SCHEMA_V2,
                payloadFields: ['parcelUid', 'decisionUuid', 'operation', 'decisionLink', 'sourceObservedAt'],
                temporalIntegrity: {
                    sourceObservedAtField: 'sourceObservedAt',
                    minimum: 'market_closes_at',
                    maximum: 'resolution_time',
                    enforcedBy: 'proposal_market'
                }
            }
        });
        expect(recipe.hash).not.toBe(buildCourtParcelOperationRecipe(input).hash);
    });

    it('rejects ambiguous, missing and malformed inputs', () => {
        expect(() => buildCourtParcelOperationRecipe({ ...input, noOperation: 'transfer' })).toThrow(/must differ/);
        expect(() => buildCourtParcelOperationRecipe({ ...input, parcelUid: '' })).toThrow(/parcelUid is required/);
        expect(() => buildCourtParcelOperationRecipe({ ...input, closesAt: 'tomorrow' })).toThrow(/Unix timestamp/);
        expect(() => buildCourtParcelOperationRecipeV2({ ...input, schema: 'nope' })).toThrow(/Solana public key/);
        expect(() => buildCourtParcelOperationRecipeV2({ ...input, schema: '11111111111111111111111111111111' })).toThrow(/registered/);
        expect(() => externalMarketAddress('sha256:nope')).toThrow(/32 bytes/);
    });
});
