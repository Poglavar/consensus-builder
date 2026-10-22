// The backer policy (agents/policies/backer.js) and the collect step every society turn runs first
// (agents/policies/collect.js), on agreements: which open agreement the backer bets YES on, and which
// settled market position a persona claims (winning side, empty-winner refund, already claimed, not
// yet resolvable). Markets, positions and chain statuses are keyed by the agreement account.
import { describe, expect, it } from 'vitest';
import * as backer from '../agents/policies/backer.js';
import * as contrarian from '../agents/policies/contrarian.js';
import { decideCollect, decideTurn, settlement } from '../agents/policies/collect.js';
import { societyHistory } from '../agents/policies/history.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const OWN_WALLET = 'OwnWallet1111111111111111111111111111111111';
const BACKER = { name: 'backer-01', role: 'backer', policy: { amountUsdc: '0.02' } };
const ROOMY = { actionsLeft: 4, usdcLeft: 0.05 };
const YES = 1;
const NO = 0;

function square(side) {
    const dLat = side / 110_540;
    const dLng = side / (111_320 * Math.cos((45.8 * Math.PI) / 180));
    return { type: 'Polygon', coordinates: [[[15.97, 45.8], [15.97 + dLng, 45.8], [15.97 + dLng, 45.8 + dLat], [15.97, 45.8 + dLat], [15.97, 45.8]]] };
}

function agreement(id, extra = {}) {
    return {
        cid: `cid-${id}`, name: `Agreement ${id}`, author: `author-${id}`, sponsor: `sponsor-${id}`, account: `account-${id}`,
        createdAt: '2026-10-21T12:00:00Z', deadline: '2026-11-01T00:00:00Z', chainStatus: 'active', designs: [], ...extra
    };
}

const building = (side, floors) => [{ schema: 'design/v1', goal: 'buildings', geometry: { buildings: [{ type: 'Feature', geometry: square(side), properties: { floors } }] } }];
const market = (yesPool, noPool, extra = {}) => ({ yesPool, noPool, resolved: false, outcome: 0, ...extra });
const position = (amount, claimed = false) => ({ amount, claimed });

describe('backer policy (backer-01)', () => {
    const agreements = [
        agreement('small', { designContents: building(10, 3) }),
        agreement('medium', { designContents: building(14, 4) }),
        agreement('tower', { designContents: building(20, 12) }),
        agreement('words', { name: 'A 20-storey tower', designContents: [] }),
        agreement('park', { name: 'Pocket park', designContents: [{ title: 'Pocket park', description: 'green square with trees' }] }),
        agreement('mine', { sponsor: OWN_WALLET, designContents: building(5, 1) }),
        agreement('cancelled', { chainStatus: 'cancelled', designContents: building(4, 1) })
    ];
    const base = { persona: BACKER, seed: '2026-10-22', now: NOW, wallet: OWN_WALLET, agreements, markets: {}, budget: ROOMY };

    it('bets YES on the most modest measured agreement by another actor, then unmeasured, then text-dense', () => {
        const decision = backer.decide(base);
        expect(decision.action).toMatchObject({
            type: 'stake', side: 'yes', amount: '0.02', usdc: 0.02, agreementCid: 'cid-small', account: 'account-small', signedActions: 2
        });
        expect(decision.action.rationale).toMatch(/^Bet YES on Agreement small: proposed gross floor area ≈ 3\d\d m²/);
        // Its own and terminal agreements never; the park (no density signal) after every measured one.
        expect(decision.eligibleCids).toEqual(['cid-small', 'cid-medium', 'cid-tower', 'cid-park', 'cid-words']);
    });

    it('reuses the contrarian\'s density evidence rather than its own', () => {
        const decision = backer.decide({ ...base, agreements: [agreements[2]] });
        expect(decision.options[0].evidence.floorAreaM2).toBe(contrarian.densityEvidence(agreements[2]).floorAreaM2);
    });

    it('prefers the underdog within a tier, and a market with fewer YES than NO only', () => {
        const markets = { 'account-tower': market(10000n, 30000n), 'account-small': market(50000n, 10000n), 'account-park': market(0n, 5000n) };
        const decision = backer.decide({ ...base, markets });
        expect(decision.action).toMatchObject({ agreementCid: 'cid-tower', signedActions: 1 });
        expect(decision.action.rationale).toMatch(/backs the underdog \(YES 0\.01 < NO 0\.03 USDC\)/);
        expect(decision.eligibleCids).toEqual(['cid-tower', 'cid-small', 'cid-medium', 'cid-park', 'cid-words']);
        expect(backer.underdogPools(market(5n, 5n))).toBeNull();
        expect(backer.underdogPools(market(1n, 5n, { resolved: true }))).toBeNull();
        expect(backer.underdogPools(null)).toBeNull();
    });

    it('never backs the same agreement twice (chain YES position or checkpointed stake) nor a resolved market', () => {
        const history = societyHistory({
            runs: [{ run_id: 'r1', started_at: '2026-10-21T00:00:00Z', summary: { society: { acted: true, action: { type: 'stake', side: 'yes', agreementCid: 'cid-small' } } } }],
            chain: { yesPositionCids: ['cid-medium'] }
        });
        const markets = { 'account-tower': market(1n, 0n, { resolved: true }) };
        const decision = backer.decide({ ...base, markets, history });
        expect(decision.action.agreementCid).toBe('cid-park');
        expect(decision.alreadyBacked.sort()).toEqual(['cid-medium', 'cid-small']);
        const none = backer.decide({ ...base, history: { forCids: ['cid-small', 'cid-medium', 'cid-tower', 'cid-words', 'cid-park'] } });
        expect(none).toMatchObject({ action: null, capped: false });
        expect(none.reason).toMatch(/already backed/);
    });

    it('reports a cap instead of acting', () => {
        const capped = backer.decide({ ...base, agreements: [agreements[0]], budget: { actionsLeft: 4, usdcLeft: 0.01 } });
        expect(capped).toMatchObject({ action: null, capped: true });
    });
});

describe('collect step: claims a persona is owed', () => {
    const settled = [
        agreement('won', { chainStatus: 'executed' }),
        agreement('lost', { chainStatus: 'cancelled' }),
        agreement('refund', { chainStatus: 'expired' }),
        agreement('done', { chainStatus: 'executed' }),
        agreement('open', { chainStatus: 'active' }),
        agreement('terminal', { chainStatus: 'cancelled' })
    ];
    const markets = {
        'account-won': market(20000n, 60000n, { resolved: true, outcome: YES }),
        'account-lost': market(20000n, 60000n, { resolved: true, outcome: NO }),
        // Resolved NO but nobody backed NO: every YES stake comes back.
        'account-refund': market(30000n, 0n, { resolved: true, outcome: NO }),
        'account-done': market(20000n, 0n, { resolved: true, outcome: YES }),
        'account-open': market(10000n, 10000n),
        'account-terminal': market(10000n, 40000n)
    };
    const positions = {
        'account-won': { yes: position(20000n), no: null },
        'account-lost': { yes: position(20000n), no: null },
        'account-refund': { yes: position(30000n), no: null },
        'account-done': { yes: position(20000n, true), no: null },
        'account-open': { yes: null, no: position(10000n) },
        'account-terminal': { yes: null, no: position(10000n) }
    };
    const base = { agreements: settled, markets, positions, chainStatuses: { 'account-open': 'active', 'account-terminal': 'cancelled' }, budget: ROOMY };

    it('claims the largest resolved payout first, then a refund, then one that must resolve first', () => {
        const decision = decideCollect(base);
        expect(decision.action).toMatchObject({
            type: 'claim', side: 'yes', agreementCid: 'cid-won', account: 'account-won', agreementName: 'Agreement won',
            resolveFirst: false, usdc: 0, signedActions: 1, payout: '0.08'
        });
        expect(decision.options.map(option => `${option.agreementCid}:${option.action.side}:${option.action.payout}`))
            .toEqual(['cid-won:yes:0.08', 'cid-refund:yes:0.03', 'cid-terminal:no:0.0125']);
        expect(decision.options[1].action.rationale).toMatch(/nobody backed that side/);
        expect(decision.options[2].action).toMatchObject({ resolveFirst: true, outcome: 'no', signedActions: 2 });
        expect(decision.options[2].action.rationale).toMatch(/the agreement is terminal on-chain; resolve the market first/);
    });

    it('skips positions already claimed on-chain or in this invocation\'s history', () => {
        const decision = decideCollect({ ...base, history: { claimedPositions: ['cid-won:yes', 'cid-refund:yes'] } });
        expect(decision.action).toMatchObject({ agreementCid: 'cid-terminal', resolveFirst: true });
        expect(societyHistory({ simulated: [{ type: 'claim', side: 'yes', agreementCid: 'cid-won' }] }).claimedPositions).toEqual(['cid-won:yes']);
    });

    it('resolves an executed agreement YES and a cancelled or expired one NO, and owes nothing while it is open', () => {
        expect(settlement(markets['account-open'], 'active')).toBeNull();
        expect(settlement(markets['account-open'], null)).toBeNull();
        expect(settlement(markets['account-open'], 'executed')).toEqual({ outcome: 'yes', resolveFirst: true });
        expect(settlement(markets['account-open'], 'Cancelled')).toEqual({ outcome: 'no', resolveFirst: true });
        expect(settlement(markets['account-open'], 'expired')).toEqual({ outcome: 'no', resolveFirst: true });
        expect(settlement(markets['account-won'], 'active')).toEqual({ outcome: 'yes', resolveFirst: false });
        expect(settlement(null, 'executed')).toBeNull();
        const decision = decideCollect({ ...base, agreements: [settled[4], settled[1], settled[3]] });
        expect(decision).toMatchObject({ action: null, capped: false, options: [] });
    });

    it('leaves a resolve-first claim for a later turn when only one signed action is left', () => {
        const decision = decideCollect({ ...base, agreements: [settled[5]], budget: { actionsLeft: 1, usdcLeft: 0 } });
        expect(decision).toMatchObject({ action: null, capped: true });
    });

    it('runs before the role policy and falls through to it when nothing is owed', () => {
        const roleDecide = () => ({ action: { type: 'stake', side: 'yes', agreementCid: 'x' }, options: [], capped: false, reason: 'role' });
        const owed = decideTurn(roleDecide, base);
        expect(owed).toMatchObject({ step: 'collect', action: { type: 'claim', agreementCid: 'cid-won' }, eligibleCids: ['cid-won', 'cid-refund', 'cid-terminal'] });
        const nothing = decideTurn(roleDecide, { ...base, positions: {} });
        expect(nothing).toMatchObject({ step: 'role', action: { type: 'stake' }, owedClaims: 0 });
        const capped = decideTurn(() => ({ action: null, options: [], capped: false, reason: 'none' }), { ...base, agreements: [settled[5]], budget: { actionsLeft: 1, usdcLeft: 0 } });
        expect(capped).toMatchObject({ step: 'role', action: null, capped: true, owedClaims: 1 });
    });
});
