// The verified agreement fact the paid oracle endpoint sells (oracle/verified-fact.js): an agreement's
// terminal agreement_lifecycle event, as the lifecycle oracle writes it and GET /oracle/events serves it,
// bound to the agreement-execution-v1 recipe of that account (and market) and evaluated by it; every
// claim of the event is checked against the hashed account bytes it carries.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { buildVerifiedAgreementFact } from '../oracle/verified-fact.js';
import { buildAgreementEvents, decodeTerminalEvent, landEventParams } from '../oracle/agreement-lifecycle.js';
import { buildAgreementExecutionRecipe } from '../oracle/market-recipe.js';
import { eventFromRow } from '../routes/land-events.js';
import { AGREEMENT_PROGRAM_ID, AgreementClient, agreementAccountOf } from '../agreements/onchain.js';
import { agreementAccountBytes } from './fixtures/agreement-account.js';
import { cidOf } from './helpers/content-fixtures.js';

const keyFrom = seed => Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => (index * 13 + seed) % 256)).publicKey.toBase58();
const SPONSOR = keyFrom(1);
const LENS = keyFrom(2);
const MARKET = keyFrom(3);
const CID = cidOf({ schema: 'agreement/v1', title: 'Corner lot' });
const ACCOUNT = agreementAccountOf(CID, SPONSOR);
const AT = Math.floor(Date.parse('2026-10-22T07:30:00.000Z') / 1000);
const STATUS = { executed: 1, cancelled: 2, expired: 3 };

const fields = (outcome, overrides = {}) => ({
    cid: CID, authority: SPONSOR, lens: LENS, deadline: AT + 3600, requiredLamports: 0, escrowLamports: 0, status: STATUS[outcome],
    ...(outcome === 'executed' ? { decision: 1, decisionAttestation: keyFrom(4), decisionHash: Buffer.alloc(32, 1), executedAt: AT } : {}),
    ...overrides
});

// The terminal event as GET /oracle/events serves it: built by the lifecycle oracle, stored as its
// land_event columns and read back through the route's row mapping.
function servedEvent(outcome) {
    const data = agreementAccountBytes(fields(outcome));
    const account = AgreementClient.readAgreement(new Uint8Array(data), ACCOUNT);
    const event = outcome === 'executed'
        ? { outcome, agreement: ACCOUNT, cid: CID, payout: SPONSOR, lamports: '0', lens: LENS, decisionAttestation: keyFrom(4), at: AT }
        : { outcome, agreement: ACCOUNT, cid: CID, refundedLamports: '0', at: AT };
    const [lifecycle] = buildAgreementEvents({
        agreement: { cid: CID, inputParcelIds: ['HR-1/1'], parcelSourceId: null }, account, accountData: data, cluster: 'devnet',
        programId: AGREEMENT_PROGRAM_ID, source: { signature: `${outcome}-tx`, slot: 880, event }
    });
    const params = landEventParams(lifecycle);
    return eventFromRow({
        event_id: params[0], event_type: params[1], subject_type: params[2], subject_id: params[3], outcome: params[4], source_url: params[5],
        source_hash: params[6], source_observed_at: new Date(params[7]), attester: params[8], transaction_signature: params[9],
        evidence: JSON.parse(params[10]), created_at: new Date('2026-10-22T07:35:00.000Z')
    });
}
const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('buildVerifiedAgreementFact', () => {
    it('binds an executed account\'s event to its agreement-execution-v1 recipe, which resolves YES', () => {
        const event = servedEvent('executed');
        const bundle = buildVerifiedAgreementFact({ event, agreementAccount: ACCOUNT });
        const recipe = buildAgreementExecutionRecipe({ agreementAccount: ACCOUNT, agreementCid: CID });
        expect(bundle.fact).toBe(event);
        expect(bundle.recipe).toEqual(recipe);
        expect(bundle.recipe).toMatchObject({ id: 'agreement-execution-v1', subject: { chain: 'solana:devnet', agreementAccount: ACCOUNT, agreementCid: CID, marketAccount: null } });
        expect(bundle.verification).toMatchObject({
            status: 'verified', eventId: event.id, recipeId: 'agreement-execution-v1', recipeHash: recipe.hash,
            lens: { status: 'resolved', decision: 'YES', outcome: 'executed' }
        });
        expect(Object.values(bundle.verification.checks).every(Boolean)).toBe(true);
    });

    it('resolves a cancelled or expired account NO', () => {
        for (const outcome of ['cancelled', 'expired']) {
            const bundle = buildVerifiedAgreementFact({ event: servedEvent(outcome), agreementAccount: ACCOUNT });
            expect(bundle.verification.lens, outcome).toMatchObject({ status: 'resolved', decision: 'NO', outcome });
        }
    });

    it('binds the market when one is named, which changes the recipe hash', () => {
        const event = servedEvent('executed');
        const bound = buildVerifiedAgreementFact({ event, agreementAccount: ACCOUNT, marketAccount: MARKET });
        expect(bound.recipe.subject.marketAccount).toBe(MARKET);
        expect(bound.recipe.hash).not.toBe(buildVerifiedAgreementFact({ event, agreementAccount: ACCOUNT }).recipe.hash);
    });

    it('refuses an event about something else, or not terminal, or not from the agreement program', () => {
        const event = servedEvent('executed');
        const refusal = (overrides, account = ACCOUNT) => () => buildVerifiedAgreementFact({ event: { ...event, ...overrides }, agreementAccount: account });
        expect(() => buildVerifiedAgreementFact({ agreementAccount: ACCOUNT })).toThrow(/event is required/);
        expect(refusal({ eventType: 'agreement_executed' })).toThrow(/eventType must be agreement_lifecycle/);
        expect(refusal({}, MARKET)).toThrow(/subject does not match/);
        expect(refusal({ subject: { type: 'parcel', id: ACCOUNT } })).toThrow(/subject does not match/);
        expect(refusal({ outcome: 'active' })).toThrow(/not a terminal agreement status/);
        expect(refusal({ attester: { kind: 'solana_program', address: MARKET } })).toThrow(/not attested by the agreement program/);
        expect(refusal({ source: { ...event.source, hash: null } })).toThrow(/no canonical source hash/);
        expect(refusal({ source: { ...event.source, transaction: null } })).toThrow(/no source transaction/);
        expect(refusal({ observedAt: 'yesterday' })).toThrow(/no source transaction or source timestamp/);
    });

    it('refuses account bytes that are not the hashed ones, not an agreement, or say another status or CID', () => {
        const event = servedEvent('cancelled');
        const withBytes = (bytes, evidence = {}) => () => buildVerifiedAgreementFact({
            event: { ...event, source: { ...event.source, hash: sha256(bytes) }, evidence: { ...event.evidence, accountDataBase64: bytes.toString('base64'), ...evidence } },
            agreementAccount: ACCOUNT
        });
        const swapped = agreementAccountBytes(fields('cancelled', { lens: SPONSOR }));
        expect(() => buildVerifiedAgreementFact({
            event: { ...event, evidence: { ...event.evidence, accountDataBase64: swapped.toString('base64') } }, agreementAccount: ACCOUNT
        })).toThrow(/do not match its source hash/);
        expect(withBytes(Buffer.from('not an account'))).toThrow(/not an agreement account/);
        expect(withBytes(agreementAccountBytes(fields('executed')))).toThrow(/does not match its agreement account status/);
        expect(withBytes(agreementAccountBytes(fields('cancelled')), { agreementCid: cidOf({ schema: 'agreement/v1', title: 'Another' }) }))
            .toThrow(/CID does not match/);
    });
});
