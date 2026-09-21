// Recipe adapter for the court oracle's live Solana Attestation Service schema. This module never
// fetches or republishes court records; it produces the exact public commitments that an
// ExternalMarket account verifies directly on-chain.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { canonicalJson, sha256 } from './proposal-lifecycle.js';

export const COURT_RECIPE_ID = 'court-parcel-operation-v1';
export const COURT_RECIPE_V2_ID = 'court-parcel-operation-v2';
export const COURT_EVENT_TYPE = 'court_parcel_operation';
export const SAS_PROGRAM_ID = '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG';
export const COURT_CREDENTIAL = '6fibS3XSgE7c4XDSFUuArBcmnD8bN26XNpjZTC8bBbcY';
export const COURT_SCHEMA_V1 = '2SdzCg62opMYbEfE4wcwUWYghA7n8GdAmkCC192FbUy9';
export const COURT_SCHEMA_V2 = 'G747jAqNr6ZwBiNAdeW1Bc4PWQH7arfvq5cjDXDcSoMG';
export const COURT_SCHEMA = COURT_SCHEMA_V1;
export const COURT_ATTESTER = 'AMbsiP9F8YY2y8n9uFdqtw7yNZZHvTWFEWSQGHKtmkoQ';
export const MARKET_PROGRAM_ID = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';

function hashText(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requiredText(value, label, maxLength = 200) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new Error(`${label} is required`);
    if (text.length > maxLength) throw new Error(`${label} is too long`);
    return text;
}

function unixSeconds(value) {
    const parsed = typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
            ? BigInt(value)
            : typeof value === 'string' && /^\d+$/.test(value.trim())
                ? BigInt(value.trim())
                : null;
    if (parsed === null || parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('closesAt must be a positive Unix timestamp in seconds');
    }
    return Number(parsed);
}

function publicKey(value, label) {
    const text = requiredText(value, label, 44);
    try {
        return new PublicKey(text).toBase58();
    } catch {
        throw new Error(`${label} must be a Solana public key`);
    }
}

function buildRecipe({
    parcelUid,
    yesOperation,
    noOperation,
    closesAt,
    schema,
    version
}) {
    const subject = requiredText(parcelUid, 'parcelUid');
    const yes = requiredText(yesOperation, 'yesOperation');
    const no = requiredText(noOperation, 'noOperation');
    if (yes === no) throw new Error('yesOperation and noOperation must differ');
    const closeTime = unixSeconds(closesAt);
    const commitments = {
        subjectHash: `sha256:${hashText(subject)}`,
        yesValueHash: `sha256:${hashText(yes)}`,
        noValueHash: `sha256:${hashText(no)}`
    };
    const v2 = version === 2;
    const body = {
        id: v2 ? COURT_RECIPE_V2_ID : COURT_RECIPE_ID,
        version,
        question: `Which committed court operation is attested for parcel ${subject}?`,
        eventType: COURT_EVENT_TYPE,
        subject: { chain: 'solana:devnet', parcelUid: subject },
        trustedAttesters: [{
            kind: 'solana_sas_issuer',
            address: COURT_ATTESTER,
            credential: COURT_CREDENTIAL
        }],
        outcomes: { [yes]: 'YES', [no]: 'NO' },
        verification: {
            kind: `sas_court_parcel_operation_v${version}`,
            permissionless: true,
            sasProgram: SAS_PROGRAM_ID,
            credential: COURT_CREDENTIAL,
            schema,
            payloadFields: v2
                ? ['parcelUid', 'decisionUuid', 'operation', 'decisionLink', 'sourceObservedAt']
                : ['parcelUid', 'decisionUuid', 'operation', 'decisionLink'],
            subjectField: 'parcelUid',
            outcomeField: 'operation',
            closesAt: closeTime,
            marketProgram: MARKET_PROGRAM_ID,
            marketSeed: 'external_market',
            commitments
        }
    };
    if (v2) {
        body.verification.temporalIntegrity = {
            sourceObservedAtField: 'sourceObservedAt',
            minimum: 'market_closes_at',
            maximum: 'resolution_time',
            enforcedBy: 'proposal_market'
        };
    }
    return { ...body, hash: `sha256:${sha256(canonicalJson(body))}` };
}

export function buildCourtParcelOperationRecipe(input = {}) {
    return buildRecipe({ ...input, schema: COURT_SCHEMA_V1, version: 1 });
}

export function buildCourtParcelOperationRecipeV2({ schema = COURT_SCHEMA_V2, ...input } = {}) {
    const selected = publicKey(schema, 'schema');
    if (selected !== COURT_SCHEMA_V2) throw new Error('schema must be the registered CourtParcelOperationV2 schema');
    return buildRecipe({ ...input, schema: selected, version: 2 });
}

export function externalMarketAddress(recipeHash) {
    const hex = requiredText(recipeHash, 'recipeHash').replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('recipeHash must contain 32 bytes');
    const bytes = Buffer.from(hex, 'hex');
    return PublicKey.findProgramAddressSync(
        [Buffer.from('external_market'), bytes],
        new PublicKey(MARKET_PROGRAM_ID)
    )[0].toBase58();
}
