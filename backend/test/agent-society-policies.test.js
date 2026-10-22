// The society policies (agents/policies/contrarian.js, speculator.js) and the history they read, on
// agreements: which single action each chooses over discovery.js agreement summaries and their markets
// (keyed by the agreement account), and when it chooses none. History is keyed by agreement CID.
import { describe, expect, it } from 'vitest';
import * as contrarian from '../agents/policies/contrarian.js';
import * as speculator from '../agents/policies/speculator.js';
import { agreementAgeDays, impliedYesProbability } from '../agents/policies/common.js';
import { societyHistory } from '../agents/policies/history.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const OWN_WALLET = 'OwnWallet1111111111111111111111111111111111';
const PRESERVATIONIST = { name: 'preservationist-01', role: 'contrarian', policy: { amountUsdc: '0.01' } };
const SPECULATOR = { name: 'speculator-01', role: 'speculator', policy: { amountUsdc: '0.05', minPledgeProbability: 0.6, revokeBelowProbability: 0.5, pledgeWithinDays: 3, maxAgeDays: 7 } };
const ROOMY = { actionsLeft: 4, usdcLeft: 0.05 };

// A square footprint of roughly `side` metres at Zagreb's latitude.
function square(side) {
    const dLat = side / 110_540;
    const dLng = side / (111_320 * Math.cos((45.8 * Math.PI) / 180));
    return { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.97 + dLng, 45.8], [15.97 + dLng, 45.8 + dLat], [15.97, 45.8 + dLat], [15.97, 45.8]]] };
}

// A discovery.js summary of a minted agreement, open on chain.
function agreement(id, extra = {}) {
    return {
        cid: `cid-${id}`, name: `Agreement ${id}`, author: `author-${id}`, sponsor: `sponsor-${id}`, account: `account-${id}`,
        createdAt: '2026-10-21T12:00:00Z', deadline: '2026-11-01T00:00:00Z', chainStatus: 'active',
        designs: [{ cid: `design-${id}`, goal: 'buildings', title: `Design ${id}` }], ...extra
    };
}

// A building design/v1 content, as society-run reads it from POST /designs/batch.
function building(side, floors) {
    return { schema: 'design/v1', goal: 'buildings', title: 'Infill', geometry: { buildings: [{ type: 'Feature', geometry: square(side), properties: { floors } }] } };
}

describe('contrarian policy (preservationist-01)', () => {
    const agreements = [
        agreement('small', { designContents: [building(10, 3)] }),
        agreement('tower', { designContents: [building(20, 12)] }),
        agreement('words', { name: 'A 20-storey tower', designContents: [] }),
        agreement('park', { name: 'Pocket park', designs: [{ cid: 'design-park', goal: 'park', title: 'Pocket park' }], designContents: [{ schema: 'design/v1', goal: 'park', title: 'Pocket park', description: 'green square with trees' }] }),
        agreement('mine', { sponsor: OWN_WALLET, designContents: [building(40, 30)] }),
        agreement('authored', { author: 'preservationist-01', designContents: [building(40, 30)] }),
        agreement('executed', { chainStatus: 'executed', designContents: [building(40, 30)] }),
        agreement('lapsed', { deadline: '2026-10-22T00:00:00Z', designContents: [building(40, 30)] })
    ];
    const base = { persona: PRESERVATIONIST, seed: '2026-10-22', now: NOW, wallet: OWN_WALLET, agreements, markets: {}, budget: ROOMY };

    it('bets NO on the densest design-measured open agreement by another actor', () => {
        const decision = contrarian.decide(base);
        expect(decision.action).toMatchObject({
            type: 'stake', side: 'no', amount: '0.01', usdc: 0.01, agreementCid: 'cid-tower', account: 'account-tower',
            agreementName: 'Agreement tower', signedActions: 2
        });
        expect(decision.action.rationale).toMatch(/gross floor area ≈ 48\d\d m²/);
        // Design-measured first (by floor area), then the text heuristic; the park, its own, terminal and lapsed ones never.
        expect(decision.eligibleCids).toEqual(['cid-tower', 'cid-small', 'cid-words']);
    });

    it('scores floor area from footprint × floors, and falls back to text only without a massing', () => {
        const tower = contrarian.densityEvidence(agreement('x', { designContents: [building(20, 12)] }));
        expect(tower).toMatchObject({ source: 'designs' });
        expect(tower.floorAreaM2).toBeGreaterThan(4700);
        expect(contrarian.densityEvidence({ name: 'A 20-storey tower' })).toMatchObject({ source: 'heuristic', score: 2000 + 100 });
        // The linked designs' titles count as text too.
        expect(contrarian.densityEvidence({ name: 'Deal', designs: [{ title: '8 storeys of apartments' }] })).toMatchObject({ source: 'heuristic', score: 800 + 50 + 50 });
        expect(contrarian.densityEvidence({ name: 'Pocket park', designContents: [{ description: 'green square' }] })).toMatchObject({ source: 'none', score: 0 });
    });

    it('never bets twice against the same agreement', () => {
        const decision = contrarian.decide({ ...base, history: { againstCids: ['cid-tower'] } });
        expect(decision.action.agreementCid).toBe('cid-small');
        expect(decision.alreadyAgainst).toEqual(['cid-tower']);
    });

    it('chooses nothing when everything is already opposed, nothing is eligible, or the market resolved', () => {
        const all = contrarian.decide({ ...base, history: { againstCids: ['cid-small', 'cid-tower', 'cid-words', 'cid-park'] } });
        expect(all).toMatchObject({ action: null, capped: false });
        expect(all.reason).toMatch(/already bet against/);
        const none = contrarian.decide({ ...base, agreements: [agreements[3], agreements[4], agreement('unminted', { account: null, chainStatus: null })] });
        expect(none).toMatchObject({ action: null, capped: false, eligibleCids: [] });
        const resolved = contrarian.decide({ ...base, agreements: [agreements[1]], markets: { 'account-tower': { yesPool: 1n, noPool: 0n, resolved: true } } });
        expect(resolved.action).toBeNull();
    });

    it('reports cap exhaustion instead of acting, and counts a missing market as a second signature', () => {
        const capped = contrarian.decide({ ...base, agreements: [agreements[1]], budget: { actionsLeft: 1, usdcLeft: 0.05 } });
        expect(capped).toMatchObject({ action: null, capped: true });
        expect(capped.reason).toMatch(/Cap reached/);
        const withMarket = contrarian.decide({ ...base, agreements: [agreements[1]], markets: { 'account-tower': { yesPool: 250000n, noPool: 0n, resolved: false } }, budget: { actionsLeft: 1, usdcLeft: 0.05 } });
        expect(withMarket.action).toMatchObject({ agreementCid: 'cid-tower', signedActions: 1 });
        const noUsdc = contrarian.decide({ ...base, agreements: [agreements[1]], budget: { actionsLeft: 4, usdcLeft: 0 } });
        expect(noUsdc).toMatchObject({ action: null, capped: true });
    });
});

describe('speculator policy (speculator-01)', () => {
    const markets = {
        'account-hot': { yesPool: 900000n, noPool: 100000n, resolved: false },
        'account-warm': { yesPool: 700000n, noPool: 300000n, resolved: false },
        'account-cold': { yesPool: 100000n, noPool: 300000n, resolved: false },
        'account-old': { yesPool: 900000n, noPool: 0n, resolved: false },
        'account-mine': { yesPool: 900000n, noPool: 0n, resolved: false }
    };
    const agreements = [
        agreement('hot'), agreement('warm'), agreement('cold'),
        agreement('old', { createdAt: '2026-10-10T12:00:00Z' }),
        agreement('nomarket'),
        agreement('mine', { sponsor: OWN_WALLET })
    ];
    const base = { persona: SPECULATOR, seed: '2026-10-22', now: NOW, wallet: OWN_WALLET, agreements, markets, budget: ROOMY };

    it('reads implied YES probability from the pools, no market as no signal, and age from createdAt', () => {
        expect(impliedYesProbability(markets['account-hot'])).toBeCloseTo(0.9);
        expect(impliedYesProbability(null)).toBeNull();
        expect(impliedYesProbability({ yesPool: 0n, noPool: 0n })).toBeNull();
        expect(impliedYesProbability({ yesPool: 5n, noPool: 5n, resolved: true })).toBeNull();
        expect(agreementAgeDays(agreement('x'), NOW)).toBe(1);
        expect(agreementAgeDays({ createdAt: null }, NOW)).toBeNull();
    });

    it('pledges early on the highest implied YES probability it has not pledged to', () => {
        const decision = speculator.decide(base);
        expect(decision.action).toMatchObject({ type: 'pledge', amount: '0.05', agreementCid: 'cid-hot', account: 'account-hot', signedActions: 1 });
        // cold is below 60%, old is past pledgeWithinDays, nomarket has no signal, mine is its own.
        expect(decision.eligibleCids).toEqual(['cid-hot', 'cid-warm']);
    });

    it('revokes an active pledge when the probability drops below the threshold, before any new pledge', () => {
        const decision = speculator.decide({ ...base, history: { pledges: { 'cid-cold': { status: 'active' }, 'cid-hot': { status: 'active' } } } });
        expect(decision.action).toMatchObject({ type: 'revokePledge', agreementCid: 'cid-cold', account: 'account-cold', usdc: 0 });
        expect(decision.action.rationale).toMatch(/fell to 25% \(< 50%\)/);
    });

    it('revokes an active pledge when the agreement ages past maxAgeDays', () => {
        const decision = speculator.decide({ ...base, history: { pledges: { 'cid-old': { status: 'active' }, 'cid-hot': { status: 'active' }, 'cid-warm': { status: 'active' } } } });
        expect(decision.action).toMatchObject({ type: 'revokePledge', agreementCid: 'cid-old' });
        expect(decision.action.rationale).toMatch(/days old \(> 7\)/);
        expect(speculator.revokeReason({ probability: 0.9, ageDays: 2 }, speculator.policyConfig(SPECULATOR))).toBeNull();
    });

    it('leaves a pledge on an agreement no longer open alone: it is settled elsewhere', () => {
        const closed = agreements.map(item => (item.cid === 'cid-cold' ? { ...item, chainStatus: 'expired' } : item));
        const decision = speculator.decide({ ...base, agreements: closed, history: { pledges: { 'cid-cold': { status: 'active' }, 'cid-hot': { status: 'active' }, 'cid-warm': { status: 'active' } } } });
        expect(decision).toMatchObject({ action: null, eligibleCids: [] });
    });

    it('never re-pledges a revoked or fulfilled pledge and says so when nothing is left', () => {
        const decision = speculator.decide({ ...base, history: { pledges: { 'cid-hot': { status: 'revoked' }, 'cid-warm': { status: 'fulfilled' } } } });
        expect(decision).toMatchObject({ action: null, capped: false, eligibleCids: [] });
        expect(decision.reason).toMatch(/No pledge is due/);
    });

    it('still revokes when the USDC cap is spent, and reports a cap when no action fits', () => {
        const usdcSpent = speculator.decide({ ...base, budget: { actionsLeft: 1, usdcLeft: 0 }, history: { pledges: { 'cid-cold': { status: 'active' } } } });
        expect(usdcSpent.action).toMatchObject({ type: 'revokePledge', agreementCid: 'cid-cold' });
        const noPledgeRoom = speculator.decide({ ...base, budget: { actionsLeft: 1, usdcLeft: 0.01 } });
        expect(noPledgeRoom).toMatchObject({ action: null, capped: true });
        const noActions = speculator.decide({ ...base, budget: { actionsLeft: 0, usdcLeft: 1 }, history: { pledges: { 'cid-cold': { status: 'active' } } } });
        expect(noActions).toMatchObject({ action: null, capped: true });
    });

    it('refuses thresholds that would flap, and a missing clock', () => {
        expect(() => speculator.policyConfig({ name: 'x', policy: { minPledgeProbability: 0.4, revokeBelowProbability: 0.5 } })).toThrow(/≥ revokeBelowProbability/);
        expect(() => speculator.policyConfig({ name: 'x', policy: { pledgeWithinDays: 9, maxAgeDays: 7 } })).toThrow(/pledgeWithinDays must be ≤ maxAgeDays/);
        expect(() => speculator.decide({ ...base, now: undefined })).toThrow(/now \(ms\) is required/);
    });
});

describe('society history', () => {
    it('folds checkpointed acts, then the chain, then this invocation\'s dry-run turns, by agreement CID', () => {
        const runs = [
            { run_id: '2026-10-20-x', started_at: '2026-10-20T02:20:00Z', summary: { society: { acted: true, action: { type: 'pledge', agreementCid: 'a' } } } },
            { run_id: '2026-10-21-x', started_at: '2026-10-21T02:20:00Z', summary: { society: { acted: true, action: { type: 'stake', side: 'no', agreementCid: 'b' } } } },
            { run_id: '2026-10-21-y', started_at: '2026-10-21T02:21:00Z', summary: { society: { acted: false, action: { type: 'pledge', agreementCid: 'c' } } } },
            { run_id: '2026-10-21-z', started_at: '2026-10-21T02:22:00Z', summary: { society: { acted: true, action: { type: 'stake', side: 'yes', agreementCid: 'f' } } } }
        ];
        const history = societyHistory({
            runs,
            chain: { noPositionCids: ['d'], yesPositionCids: ['g'], pledges: { a: { status: 'fulfilled' } } },
            simulated: [{ type: 'revokePledge', agreementCid: 'e' }, { type: 'claim', side: 'yes', agreementCid: 'f' }]
        });
        expect(history.againstCids.sort()).toEqual(['b', 'd']);
        expect(history.forCids.sort()).toEqual(['f', 'g']);
        expect(history.pledges).toEqual({ a: { status: 'fulfilled' }, e: { status: 'revoked' } });
        expect(history.claimedPositions).toEqual(['f:yes']);
    });
});
