// The supporter persona's $0 policy (agents/supporter-picker.js) on agreements: only an agreement open on
// chain (Active and before its deadline), sponsored and authored by somebody else and not yet supported is
// a target; the choice is a stable daily hash, and a replayed adapter result is never a new support.
import { describe, expect, it } from 'vitest';
import { classifySupportExecution, eligibleSupportAgreements, isOthersOpen, selectSupportAction } from '../agents/supporter-picker.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const WALLET = 'SupporterWallet111111111111111111111111111';

const agreement = (cid, extra = {}) => ({
    cid, name: `Agreement ${cid}`, city: 'zagreb', author: `author-${cid}`, sponsor: `sponsor-${cid}`,
    account: `account-${cid}`, createdAt: '2026-10-20T12:00:00Z', deadline: '2026-11-01T00:00:00Z', chainStatus: 'active',
    ...extra
});

describe('supporter eligibility', () => {
    it('admits only agreements open on chain, by another sponsor and author', () => {
        const agreements = [
            agreement('good'),
            agreement('no-deadline', { deadline: null }),
            agreement('unminted', { account: null, chainStatus: null }),
            agreement('executed', { chainStatus: 'executed' }),
            agreement('expired', { chainStatus: 'expired' }),
            agreement('cancelled', { chainStatus: 'cancelled' }),
            agreement('lapsed', { deadline: '2026-10-22T11:59:59Z' }),
            agreement('own-sponsor', { sponsor: WALLET }),
            agreement('own-author', { author: 'supporter-01' })
        ];
        expect(eligibleSupportAgreements(agreements, { wallet: WALLET, personaName: 'supporter-01', now: NOW }).map(item => item.cid))
            .toEqual(['good', 'no-deadline']);
        // Without a wallet or persona name only the chain state and the deadline decide.
        expect(isOthersOpen(agreement('own-sponsor', { sponsor: WALLET }), { now: NOW })).toBe(true);
        expect(isOthersOpen(agreement('lapsed', { deadline: '2026-10-22T12:00:00Z' }), { now: NOW })).toBe(false);
    });

    it('drops agreements this wallet already supports before ranking', () => {
        const agreements = [agreement('a'), agreement('b')];
        expect(eligibleSupportAgreements(agreements, { now: NOW, excludeCids: ['b'] }).map(item => item.cid)).toEqual(['a']);
    });
});

describe('supporter selection', () => {
    const persona = { name: 'supporter-01', support: { actions: ['pledge', 'donate', 'stake'], amountUsdc: '0.10' } };
    const agreements = [agreement('a'), agreement('b'), agreement('c')];

    it('makes the same auditable choice for the same day, naming the agreement and its account', () => {
        const input = { day: '2026-10-22', persona, agreements, wallet: WALLET, now: NOW };
        const first = selectSupportAction(input);
        expect(selectSupportAction(input)).toEqual(first);
        const chosen = agreements.find(item => item.cid === first.selected.agreementCid);
        expect(first.selected).toMatchObject({
            amount: '0.10', agreementCid: chosen.cid, account: chosen.account, agreementName: chosen.name
        });
        expect(['pledge', 'donate', 'stake']).toContain(first.selected.type);
        expect(first.selected.side).toBe(first.selected.type === 'stake' ? 'yes' : null);
        expect(first.eligibleCids).toEqual(['a', 'b', 'c']);
        expect(first.selected.rationale).toMatch(/^Selected deterministically from 3 open agreements by other actors; .* without using an LLM\.$/);
        // Another day ranks again; across a few days more than one agreement is chosen.
        const days = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
        const picked = new Set(days.map(day => selectSupportAction({ ...input, day }).selected.agreementCid));
        expect(picked.size).toBeGreaterThan(1);
    });

    it('stakes YES only when staking is its action, at the persona amount (default 0.10 USDC)', () => {
        const staker = selectSupportAction({ day: '2026-10-22', persona: { name: 'staker', support: { actions: ['stake'] } }, agreements, now: NOW });
        expect(staker.selected).toMatchObject({ type: 'stake', side: 'yes', amount: '0.10' });
        expect(() => selectSupportAction({ day: '2026-10-22', persona: { name: 'x', support: { actions: ['vote'] } }, agreements, now: NOW }))
            .toThrow(/no valid support actions/);
        expect(() => selectSupportAction({ persona, agreements })).toThrow(/day is required/);
    });

    it('excludes what it already supports and says so', () => {
        const all = selectSupportAction({ day: '2026-10-22', persona, agreements, wallet: WALLET, now: NOW });
        const next = selectSupportAction({ day: '2026-10-22', persona, agreements, wallet: WALLET, now: NOW, excludeCids: [all.selected.agreementCid] });
        expect(next.selected.agreementCid).not.toBe(all.selected.agreementCid);
        expect(next.eligibleCids).toHaveLength(2);
        expect(next.excludedCids).toEqual([all.selected.agreementCid]);
        expect(next.selected.rationale).toMatch(/skipping 1 already supported/);
    });

    it('returns an explicit no-op when nothing is open, or everything is already supported', () => {
        expect(selectSupportAction({ day: '2026-10-22', persona, agreements: [], now: NOW })).toEqual({
            selected: null, eligibleCids: [], excludedCids: [], reason: 'No open agreement by another actor was available.'
        });
        const done = selectSupportAction({ day: '2026-10-22', persona, agreements, now: NOW, excludeCids: ['a', 'b', 'c', 'a'] });
        expect(done.selected).toBeNull();
        expect(done.excludedCids).toEqual(['a', 'b', 'c']);
        expect(done.reason).toBe('No open agreement by another actor remains unsupported (3 already supported).');
        // A terminal agreement the index still lists as active is never a target: only the chain counts.
        const terminal = agreements.map(item => ({ ...item, chainStatus: 'executed' }));
        expect(selectSupportAction({ day: '2026-10-22', persona, agreements: terminal, now: NOW }).selected).toBeNull();
    });
});

describe('support execution verdict', () => {
    it('classifies a replayed adapter result as a no-op, never as a completed support', () => {
        expect(classifySupportExecution({ replayed: true, signature: null })).toEqual({ acted: false, runOutcome: 'already-supported' });
        expect(classifySupportExecution({ replayed: true, signature: 'sig' })).toEqual({ acted: false, runOutcome: 'already-supported' });
        expect(classifySupportExecution({ replayed: false, signature: null })).toEqual({ acted: false, runOutcome: 'already-supported' });
        expect(classifySupportExecution({ replayed: false, signature: 'sig' })).toEqual({ acted: true, runOutcome: 'completed' });
        expect(classifySupportExecution({ stakeSignature: 'stake-sig' })).toEqual({ acted: true, runOutcome: 'completed' });
        expect(classifySupportExecution(undefined)).toEqual({ acted: false, runOutcome: 'already-supported' });
    });
});
