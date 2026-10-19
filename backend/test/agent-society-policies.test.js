// The society policies (agents/policies/contrarian.js, speculator.js) and the history they read:
// which single action each chooses on fixture proposals and markets, and when it chooses none.
import { describe, expect, it } from 'vitest';
import * as contrarian from '../agents/policies/contrarian.js';
import * as speculator from '../agents/policies/speculator.js';
import { impliedYesProbability } from '../agents/policies/common.js';
import { societyHistory } from '../agents/policies/history.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
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

function proposal(id, extra = {}) {
    return {
        id, proposalId: id, name: `Proposal ${id}`, lifecycleStatus: 'Active', author: `Author-${id}`,
        createdAt: '2026-09-30T12:00:00Z', onchain: { proposalId: `PDA-${id}` }, ...extra
    };
}

function building(side, floors) {
    return { geometry: { buildings: [{ type: 'Feature', geometry: square(side), properties: { floors } }] } };
}

describe('contrarian policy (preservationist-01)', () => {
    const proposals = [
        proposal('small', { record: building(10, 3) }),
        proposal('tower', { record: building(20, 12) }),
        proposal('words', { name: 'A 20-storey tower', record: { name: 'A 20-storey tower' } }),
        proposal('park', { name: 'Pocket park', record: { name: 'Pocket park', description: 'green square with trees' } }),
        proposal('mine', { author: OWN_WALLET, record: building(40, 30) })
    ];

    it('bets NO on the densest record-measured proposal by another actor', () => {
        const decision = contrarian.decide({ persona: PRESERVATIONIST, seed: '2026-10-01', wallet: OWN_WALLET, proposals, markets: {}, budget: ROOMY });
        expect(decision.action).toMatchObject({ type: 'stake', side: 'no', amount: '0.01', usdc: 0.01, proposalId: 'tower', proposalAccount: 'PDA-tower', signedActions: 2 });
        expect(decision.action.rationale).toMatch(/gross floor area ≈ 48\d\d m²/);
        // Record-measured first (by floor area), then the text heuristic; the park and own proposal never.
        expect(decision.eligibleProposalIds).toEqual(['tower', 'small', 'words']);
    });

    it('scores floor area from footprint × floors, and falls back to text only without a massing', () => {
        expect(contrarian.densityEvidence(proposal('x', { record: building(20, 12) }))).toMatchObject({ source: 'record' });
        expect(contrarian.densityEvidence(proposal('x', { record: building(20, 12) })).floorAreaM2).toBeGreaterThan(4700);
        expect(contrarian.densityEvidence({ name: 'A 20-storey tower' })).toMatchObject({ source: 'heuristic', score: 2000 + 100 });
        expect(contrarian.densityEvidence({ name: 'Pocket park', description: 'green square' })).toMatchObject({ source: 'none', score: 0 });
    });

    it('never bets twice against the same proposal', () => {
        const decision = contrarian.decide({
            persona: PRESERVATIONIST, seed: '2026-10-01', wallet: OWN_WALLET, proposals, budget: ROOMY,
            history: { againstProposalIds: ['tower'] }
        });
        expect(decision.action.proposalId).toBe('small');
        expect(decision.alreadyAgainst).toEqual(['tower']);
    });

    it('chooses nothing when everything is already opposed or nothing is eligible', () => {
        const all = contrarian.decide({
            persona: PRESERVATIONIST, seed: 's', wallet: OWN_WALLET, proposals, budget: ROOMY,
            history: { againstProposalIds: ['small', 'tower', 'words', 'park'] }
        });
        expect(all).toMatchObject({ action: null, capped: false });
        expect(all.reason).toMatch(/already bet against/);
        const none = contrarian.decide({ persona: PRESERVATIONIST, seed: 's', wallet: OWN_WALLET, proposals: [proposals[3], proposals[4], proposal('unminted', { onchain: null })], budget: ROOMY });
        expect(none).toMatchObject({ action: null, capped: false, eligibleProposalIds: [] });
        const resolved = contrarian.decide({ persona: PRESERVATIONIST, seed: 's', proposals: [proposals[1]], markets: { 'PDA-tower': { yesPool: 1n, noPool: 0n, resolved: true } }, budget: ROOMY });
        expect(resolved.action).toBeNull();
    });

    it('reports cap exhaustion instead of acting, and counts a missing market as a second signature', () => {
        const capped = contrarian.decide({ persona: PRESERVATIONIST, seed: 's', proposals: [proposals[1]], budget: { actionsLeft: 1, usdcLeft: 0.05 } });
        expect(capped).toMatchObject({ action: null, capped: true });
        expect(capped.reason).toMatch(/Cap reached/);
        const withMarket = contrarian.decide({ persona: PRESERVATIONIST, seed: 's', proposals: [proposals[1]], markets: { 'PDA-tower': { yesPool: 250000n, noPool: 0n, resolved: false } }, budget: { actionsLeft: 1, usdcLeft: 0.05 } });
        expect(withMarket.action).toMatchObject({ proposalId: 'tower', signedActions: 1 });
        const noUsdc = contrarian.decide({ persona: PRESERVATIONIST, seed: 's', proposals: [proposals[1]], budget: { actionsLeft: 4, usdcLeft: 0 } });
        expect(noUsdc).toMatchObject({ action: null, capped: true });
    });
});

describe('speculator policy (speculator-01)', () => {
    const markets = {
        'PDA-hot': { yesPool: 900000n, noPool: 100000n, resolved: false },
        'PDA-warm': { yesPool: 700000n, noPool: 300000n, resolved: false },
        'PDA-cold': { yesPool: 100000n, noPool: 300000n, resolved: false },
        'PDA-old': { yesPool: 900000n, noPool: 0n, resolved: false }
    };
    const proposals = [
        proposal('hot'), proposal('warm'), proposal('cold'),
        proposal('old', { createdAt: '2026-09-20T12:00:00Z' }),
        proposal('nomarket'),
        proposal('mine', { author: OWN_WALLET })
    ];
    const base = { persona: SPECULATOR, seed: '2026-10-01', now: NOW, wallet: OWN_WALLET, proposals, markets, budget: ROOMY };

    it('reads implied YES probability from the pools, and no market as no signal', () => {
        expect(impliedYesProbability(markets['PDA-hot'])).toBeCloseTo(0.9);
        expect(impliedYesProbability(null)).toBeNull();
        expect(impliedYesProbability({ yesPool: 0n, noPool: 0n })).toBeNull();
        expect(impliedYesProbability({ yesPool: 5n, noPool: 5n, resolved: true })).toBeNull();
    });

    it('pledges early on the highest implied YES probability it has not pledged to', () => {
        const decision = speculator.decide(base);
        expect(decision.action).toMatchObject({ type: 'pledge', amount: '0.05', proposalId: 'hot', proposalAccount: 'PDA-hot', signedActions: 1 });
        // cold is below 60%, old is past pledgeWithinDays, nomarket has no signal, mine is its own.
        expect(decision.eligibleProposalIds).toEqual(['hot', 'warm']);
    });

    it('revokes an active pledge when the probability drops below the threshold, before any new pledge', () => {
        const decision = speculator.decide({ ...base, history: { pledges: { cold: { status: 'active' }, hot: { status: 'active' } } } });
        expect(decision.action).toMatchObject({ type: 'revokePledge', proposalId: 'cold', usdc: 0 });
        expect(decision.action.rationale).toMatch(/fell to 25% \(< 50%\)/);
    });

    it('revokes an active pledge when the proposal ages past maxAgeDays', () => {
        const decision = speculator.decide({ ...base, history: { pledges: { old: { status: 'active' }, hot: { status: 'active' }, warm: { status: 'active' } } } });
        expect(decision.action).toMatchObject({ type: 'revokePledge', proposalId: 'old' });
        expect(decision.action.rationale).toMatch(/days old \(> 7\)/);
        expect(speculator.revokeReason({ probability: 0.9, ageDays: 2 }, speculator.policyConfig(SPECULATOR))).toBeNull();
    });

    it('never re-pledges a revoked or fulfilled pledge and says so when nothing is left', () => {
        const decision = speculator.decide({ ...base, history: { pledges: { hot: { status: 'revoked' }, warm: { status: 'fulfilled' } } } });
        expect(decision).toMatchObject({ action: null, capped: false, eligibleProposalIds: [] });
        expect(decision.reason).toMatch(/No pledge is due/);
    });

    it('still revokes when the USDC cap is spent, and reports a cap when no action fits', () => {
        const usdcSpent = speculator.decide({ ...base, budget: { actionsLeft: 1, usdcLeft: 0 }, history: { pledges: { cold: { status: 'active' } } } });
        expect(usdcSpent.action).toMatchObject({ type: 'revokePledge', proposalId: 'cold' });
        const noPledgeRoom = speculator.decide({ ...base, budget: { actionsLeft: 1, usdcLeft: 0.01 } });
        expect(noPledgeRoom).toMatchObject({ action: null, capped: true });
        const noActions = speculator.decide({ ...base, budget: { actionsLeft: 0, usdcLeft: 1 }, history: { pledges: { cold: { status: 'active' } } } });
        expect(noActions).toMatchObject({ action: null, capped: true });
    });

    it('refuses thresholds that would flap', () => {
        expect(() => speculator.policyConfig({ name: 'x', policy: { minPledgeProbability: 0.4, revokeBelowProbability: 0.5 } })).toThrow(/≥ revokeBelowProbability/);
    });
});

describe('society history', () => {
    it('folds checkpointed acts, then the chain, then this invocation\'s dry-run turns', () => {
        const runs = [
            { run_id: '2026-09-29-x', started_at: '2026-09-29T02:20:00Z', summary: { society: { acted: true, action: { type: 'pledge', proposalId: 'a' } } } },
            { run_id: '2026-09-30-x', started_at: '2026-09-30T02:20:00Z', summary: { society: { acted: true, action: { type: 'stake', side: 'no', proposalId: 'b' } } } },
            { run_id: '2026-09-30-y', started_at: '2026-09-30T02:21:00Z', summary: { society: { acted: false, action: { type: 'pledge', proposalId: 'c' } } } }
        ];
        const history = societyHistory({
            runs,
            chain: { noPositionProposalIds: ['d'], pledges: { a: { status: 'fulfilled' } } },
            simulated: [{ type: 'revokePledge', proposalId: 'e' }]
        });
        expect(history.againstProposalIds.sort()).toEqual(['b', 'd']);
        expect(history.pledges).toEqual({ a: { status: 'fulfilled' }, e: { status: 'revoked' } });
    });
});
