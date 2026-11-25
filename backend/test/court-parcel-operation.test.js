// The court-evidence market recipes (court-parcel-operation-v1/v2): what they commit, their hash over
// the canonical body (keys sorted at every depth, no whitespace) and the ExternalMarket address it keys.
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

// The recipe hash's canonical form, written out independently of the module.
const canonicalJson = value => (Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
        : JSON.stringify(value));

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

    it('keeps the hashes of precommitted recipes, and so their market addresses, byte for byte', () => {
        // A market keyed on them must still resolve. A recipe commits to its market program, so these are
        // the hashes under the lens-set proposal_market program (9S7jXSk…); the canonical form is the one
        // recorded before M3 moved it into this module (under the previous program id the same bodies hash
        // to sha256:9c0b0b69… and sha256:b877cf3e…).
        const v1 = buildCourtParcelOperationRecipe(input);
        const v2 = buildCourtParcelOperationRecipeV2(input);
        expect(v1.verification.marketProgram).toBe(MARKET_PROGRAM_ID);
        expect(v1.hash).toBe('sha256:3f5aca30f11333dbb1e13205c998af24c24b4bfa83f69834111a2b633b5f21f1');
        expect(externalMarketAddress(v1.hash)).toBe('HT69NhYjpKyrPUrYUizUmg9HgzAewFWTx93tNSBN8Kr');
        expect(v2.hash).toBe('sha256:a363312dbd8e94f412d33822f224a406fdbf836d793435cc520dab11866af6ab');
        expect(externalMarketAddress(v2.hash)).toBe('BpStroG1qmBUowsyHhARCNCTvvo8jGyrygg4ePzmkSNP');
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
