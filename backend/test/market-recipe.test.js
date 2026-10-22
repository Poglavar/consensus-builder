// The settlement rule of an agreement's prediction market (oracle/market-recipe.js): the status words
// the index stores, the agreement-execution-v1 recipe (shape, hash, recipe.schema.json conformance) and
// how the recipe evaluator reads the lifecycle oracle's events for one agreement account.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    AGREEMENT_EXECUTION_RECIPE_ID,
    SETTLEMENT,
    agreementEventMatches,
    buildAgreementExecutionRecipe,
    chainStatusOf,
    evaluateAgreementMarket,
    marketOutcome
} from '../oracle/market-recipe.js';
import { AGREEMENT_PROGRAM_ID } from '../agreements/onchain.js';
import { AGREEMENT_EXECUTED_EVENT_TYPE, AGREEMENT_LIFECYCLE_EVENT_TYPE } from '../oracle/agreement-lifecycle.js';

const AGREEMENT = 'Ekpt4qMsJWyyraDfPfq2zkT1JwMsJCKrSmkoNGgHreFR';
const OTHER = 'Fh3K8apDKKKjPUPLVV5Y327Hd5s2HY9Y7bqAvjidFcC5';
const MARKET = '5A9kzK2SzjP5nU2Dnz958wQcy96KkMnavoMNGxt7p1h3';
const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const MARKET_PROGRAM = 'GDYnzduynKhKgxDhvvKVarn2s23DtzA26s6hycuUYDRB';
const SCHEMA = JSON.parse(fs.readFileSync(new URL('../oracle/recipe.schema.json', import.meta.url), 'utf8'));

const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value));

// A lifecycle event as GET /oracle/events serves it (routes/land-events.js eventFromRow).
function event(outcome, overrides = {}) {
    return {
        id: `solana-devnet:${AGREEMENT_LIFECYCLE_EVENT_TYPE}:${AGREEMENT}:${outcome}`,
        eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE,
        subject: { type: 'agreement', id: AGREEMENT },
        outcome,
        observedAt: '2026-10-20T10:00:00.000Z',
        recordedAt: '2026-10-20T10:05:00.000Z',
        attester: { kind: 'solana_program', address: AGREEMENT_PROGRAM_ID },
        source: { hash: `sha256:${outcome}` },
        ...overrides
    };
}

describe('chainStatusOf and marketOutcome', () => {
    it('reads only the program statuses the index spells, in lower case', () => {
        for (const status of ['active', 'executed', 'cancelled', 'expired']) expect(chainStatusOf({ status })).toBe(status);
        for (const onchain of [null, undefined, 'executed', {}, { status: 'Executed' }, { status: 'settled' }, { status: 3 }]) {
            expect(chainStatusOf(onchain)).toBeNull();
        }
    });

    it('settles YES on executed, NO on cancelled or expired, and nothing while active or unobserved', () => {
        expect(SETTLEMENT).toEqual({ executed: 'yes', cancelled: 'no', expired: 'no' });
        expect(marketOutcome('executed')).toBe('yes');
        expect(marketOutcome('cancelled')).toBe('no');
        expect(marketOutcome('expired')).toBe('no');
        for (const status of ['active', null, undefined, 'Executed', 'toString', '__proto__', 'constructor']) {
            expect(marketOutcome(status), String(status)).toBeNull();
        }
    });
});

describe('buildAgreementExecutionRecipe', () => {
    it('commits the agreement account, its CID and the agreement program as the trusted attester', () => {
        const recipe = buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID, marketAccount: MARKET });
        expect(recipe).toMatchObject({
            id: AGREEMENT_EXECUTION_RECIPE_ID,
            version: 1,
            eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE,
            subject: { chain: 'solana:devnet', agreementAccount: AGREEMENT, agreementCid: CID, marketAccount: MARKET },
            trustedAttesters: [{ kind: 'solana_program', address: AGREEMENT_PROGRAM_ID }],
            outcomes: { executed: 'YES', cancelled: 'NO', expired: 'NO' },
            verification: {
                kind: 'program_account_state',
                marketProgram: MARKET_PROGRAM,
                agreementProgram: AGREEMENT_PROGRAM_ID,
                statusOffset: 136,
                statusBytes: { executed: 1, cancelled: 2, expired: 3 },
                permissionless: true
            }
        });
        // The hash is sha256 over the canonical body (every field but the hash itself).
        const { hash, ...body } = recipe;
        expect(hash).toBe(`sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`);
    });

    it('is deterministic per agreement and market, and a market-less recipe names none', () => {
        const a = buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID });
        expect(a.subject.marketAccount).toBeNull();
        expect(buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID }).hash).toBe(a.hash);
        const hashes = new Set([
            a.hash,
            buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID, marketAccount: MARKET }).hash,
            buildAgreementExecutionRecipe({ agreementAccount: OTHER, agreementCid: CID }).hash,
            buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: `${CID.slice(0, -1)}a` }).hash
        ]);
        expect(hashes.size).toBe(4);
    });

    it('conforms to the published recipe schema (oracle/recipe.schema.json)', () => {
        const recipe = buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID, marketAccount: MARKET });
        expect(SCHEMA.required.filter(key => !(key in recipe))).toEqual([]);
        expect(Object.keys(recipe).filter(key => !(key in SCHEMA.properties))).toEqual([]);
        for (const key of ['id', 'eventType', 'hash']) expect(recipe[key], key).toMatch(new RegExp(SCHEMA.properties[key].pattern));
        expect(SCHEMA.properties.verification.required.filter(key => !(key in recipe.verification))).toEqual([]);
        expect(recipe.trustedAttesters.every(attester => attester.kind && attester.address)).toBe(true);
    });

    it('refuses anything but canonical base58 accounts and a CID', () => {
        expect(() => buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT.toLowerCase(), agreementCid: CID })).toThrow(/agreementAccount/);
        expect(() => buildAgreementExecutionRecipe({ agreementAccount: ` ${AGREEMENT}`, agreementCid: CID })).toThrow(/agreementAccount/);
        expect(() => buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: '' })).toThrow(/agreementCid/);
        expect(() => buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID, marketAccount: 'not-a-key' })).toThrow(/marketAccount/);
        expect(() => buildAgreementExecutionRecipe()).toThrow(/agreementAccount/);
    });
});

describe('agreementEventMatches', () => {
    const recipe = buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID });

    it('matches an event whose subject is this agreement account, by subject.type and subject.id', () => {
        expect(agreementEventMatches(event('executed'), recipe)).toBe(true);
        expect(agreementEventMatches(event('executed', { subject: { type: 'agreement', id: OTHER } }), recipe)).toBe(false);
        // A per-parcel execution entry names the parcel, never the account, as its subject.
        expect(agreementEventMatches(event('executed', { subject: { type: 'parcel', id: AGREEMENT } }), recipe)).toBe(false);
        expect(agreementEventMatches(event('executed', { subject: { type: 'agreement' } }), recipe)).toBe(false);
        expect(agreementEventMatches({ eventType: AGREEMENT_LIFECYCLE_EVENT_TYPE }, recipe)).toBe(false);
        expect(agreementEventMatches(event('executed'), {})).toBe(false);
    });
});

describe('evaluateAgreementMarket', () => {
    const recipe = buildAgreementExecutionRecipe({ agreementAccount: AGREEMENT, agreementCid: CID, marketAccount: MARKET });
    const now = '2026-10-21T00:00:00Z';

    it('resolves YES on the executed event and NO on cancelled or expired', () => {
        expect(evaluateAgreementMarket({ recipe, events: [event('executed')], now })).toMatchObject({ status: 'resolved', decision: 'YES', outcome: 'executed' });
        expect(evaluateAgreementMarket({ recipe, events: [event('cancelled')], now })).toMatchObject({ status: 'resolved', decision: 'NO', outcome: 'cancelled' });
        expect(evaluateAgreementMarket({ recipe, events: [event('expired')], now })).toMatchObject({ status: 'resolved', decision: 'NO', outcome: 'expired' });
    });

    it('stays open while the account is active: no terminal event, no decision', () => {
        expect(evaluateAgreementMarket({ recipe, events: [], now })).toMatchObject({ status: 'insufficient_evidence', decision: null });
    });

    it('rejects events of another account, another attester, another type or an unknown outcome', () => {
        const result = evaluateAgreementMarket({
            recipe,
            now,
            events: [
                event('executed', { id: 'other-account', subject: { type: 'agreement', id: OTHER } }),
                event('executed', { id: 'other-program', attester: { kind: 'solana_program', address: MARKET_PROGRAM } }),
                event('executed', { id: 'per-parcel', eventType: AGREEMENT_EXECUTED_EVENT_TYPE, subject: { type: 'parcel', id: 'HR-1' } }),
                event('active', { id: 'not-terminal' })
            ]
        });
        expect(result).toMatchObject({ status: 'insufficient_evidence', decision: null });
        expect(result.rejectedEvidence).toEqual([
            { id: 'other-account', reason: 'subject_mismatch' },
            { id: 'other-program', reason: 'untrusted_attester' },
            { id: 'per-parcel', reason: 'event_type_mismatch' },
            { id: 'not-terminal', reason: 'unsupported_outcome' }
        ]);
    });

    it('disputes an account the same attester reports both executed and cancelled', () => {
        const result = evaluateAgreementMarket({ recipe, now, events: [event('executed'), event('cancelled')] });
        expect(result).toMatchObject({ status: 'disputed', decision: null });
        expect(result.rejectedEvidence).toEqual([{ id: event('cancelled').id, reason: 'attester_equivocation' }]);
    });

    it('evaluates only its own recipe', () => {
        expect(() => evaluateAgreementMarket({ recipe: { ...recipe, id: 'proposal-lifecycle-v2' }, events: [], now })).toThrow(/agreement-execution-v1/);
    });
});
