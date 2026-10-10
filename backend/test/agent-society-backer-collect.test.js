// The backer policy (agents/policies/backer.js) and the collect step every society turn runs first
// (agents/policies/collect.js): which proposal the backer bets YES on, and which settled market
// position a persona claims (winning side, empty-winner refund, already claimed, not yet resolvable).
import { describe, expect, it } from 'vitest';
import * as backer from '../agents/policies/backer.js';
import * as contrarian from '../agents/policies/contrarian.js';
import { decideCollect, decideTurn, settlement } from '../agents/policies/collect.js';
import { isOthersActiveMinted } from '../agents/policies/common.js';
import { societyHistory } from '../agents/policies/history.js';

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

function proposal(id, extra = {}) {
    return {
        id, proposalId: id, name: `Proposal ${id}`, lifecycleStatus: 'Active', author: `Author-${id}`,
        createdAt: '2026-09-30T12:00:00Z', onchain: { proposalId: `PDA-${id}` }, ...extra
    };
}

function building(side, floors) {
    return { geometry: { buildings: [{ type: 'Feature', geometry: square(side), properties: { floors } }] } };
}

const market = (yesPool, noPool, extra = {}) => ({ yesPool, noPool, resolved: false, outcome: 0, ...extra });
const position = (amount, claimed = false) => ({ amount, claimed });

describe('backer policy (backer-01)', () => {
    const proposals = [
        proposal('small', { record: building(10, 3) }),
        proposal('medium', { record: building(14, 4) }),
        proposal('tower', { record: building(20, 12) }),
        proposal('words', { name: 'A 20-storey tower', record: { name: 'A 20-storey tower' } }),
        proposal('park', { name: 'Pocket park', record: { name: 'Pocket park', description: 'green square with trees' } }),
        proposal('mine', { author: OWN_WALLET, record: building(5, 1) }),
        proposal('evm', { onchain: { chainId: '0xaa36a7', proposalId: '51' }, record: building(4, 1) })
    ];

    it('bets YES on the most modest measured proposal by another actor, then unmeasured, then text-dense', () => {
        const decision = backer.decide({ persona: BACKER, seed: '2026-10-11', wallet: OWN_WALLET, proposals, markets: {}, budget: ROOMY });
        expect(decision.action).toMatchObject({ type: 'stake', side: 'yes', amount: '0.02', usdc: 0.02, proposalId: 'small', proposalAccount: 'PDA-small', signedActions: 2 });
        expect(decision.action.rationale).toMatch(/^Bet YES on Proposal small: proposed gross floor area ≈ 3\d\d m²/);
        // Own and EVM-minted proposals never; the park (no density signal) after every measured one.
        expect(decision.eligibleProposalIds).toEqual(['small', 'medium', 'tower', 'park', 'words']);
    });

    it('reuses the contrarian\'s density evidence rather than its own', () => {
        const decision = backer.decide({ persona: BACKER, seed: 's', wallet: OWN_WALLET, proposals: [proposals[2]], budget: ROOMY });
        expect(decision.options[0].evidence.floorAreaM2).toBe(contrarian.densityEvidence(proposals[2]).floorAreaM2);
    });

    it('prefers the underdog within a tier, and a market with fewer YES than NO only', () => {
        const markets = { 'PDA-tower': market(10000n, 30000n), 'PDA-small': market(50000n, 10000n), 'PDA-park': market(0n, 5000n) };
        const decision = backer.decide({ persona: BACKER, seed: 's', wallet: OWN_WALLET, proposals, markets, budget: ROOMY });
        expect(decision.action).toMatchObject({ proposalId: 'tower', signedActions: 1 });
        expect(decision.action.rationale).toMatch(/backs the underdog \(YES 0\.01 < NO 0\.03 USDC\)/);
        expect(decision.eligibleProposalIds).toEqual(['tower', 'small', 'medium', 'park', 'words']);
        expect(backer.underdogPools(market(5n, 5n))).toBeNull();
        expect(backer.underdogPools(market(1n, 5n, { resolved: true }))).toBeNull();
        expect(backer.underdogPools(null)).toBeNull();
    });

    it('never backs the same proposal twice (chain YES position or checkpointed stake) nor a resolved market', () => {
        const history = societyHistory({
            runs: [{ run_id: 'r1', started_at: '2026-10-10T00:00:00Z', summary: { society: { acted: true, action: { type: 'stake', side: 'yes', proposalId: 'small' } } } }],
            chain: { yesPositionProposalIds: ['medium'] }
        });
        const markets = { 'PDA-tower': market(1n, 0n, { resolved: true }) };
        const decision = backer.decide({ persona: BACKER, seed: 's', wallet: OWN_WALLET, proposals, markets, history, budget: ROOMY });
        expect(decision.action.proposalId).toBe('park');
        expect(decision.alreadyBacked.sort()).toEqual(['medium', 'small']);
        const none = backer.decide({ persona: BACKER, seed: 's', wallet: OWN_WALLET, proposals, history: { forProposalIds: ['small', 'medium', 'tower', 'words', 'park'] }, budget: ROOMY });
        expect(none).toMatchObject({ action: null, capped: false });
        expect(none.reason).toMatch(/already backed/);
    });

    it('reports a cap instead of acting', () => {
        const capped = backer.decide({ persona: BACKER, seed: 's', wallet: OWN_WALLET, proposals: [proposals[0]], budget: { actionsLeft: 4, usdcLeft: 0.01 } });
        expect(capped).toMatchObject({ action: null, capped: true });
    });

    it('treats EVM-minted proposals as not minted on Solana', () => {
        expect(isOthersActiveMinted(proposals[6])).toBe(false);
        expect(isOthersActiveMinted(proposal('x', { onchain: { chainId: 'solana-devnet', proposalId: 'PDA-x' } }))).toBe(true);
    });
});

describe('collect step: claims a persona is owed', () => {
    const settled = [
        proposal('won', { lifecycleStatus: 'Executed' }),
        proposal('lost', { lifecycleStatus: 'Cancelled' }),
        proposal('refund', { lifecycleStatus: 'Cancelled' }),
        proposal('done', { lifecycleStatus: 'Executed' }),
        proposal('open', { lifecycleStatus: 'Active' }),
        proposal('terminal', { lifecycleStatus: 'Cancelled' })
    ];
    const markets = {
        'PDA-won': market(20000n, 60000n, { resolved: true, outcome: YES }),
        'PDA-lost': market(20000n, 60000n, { resolved: true, outcome: NO }),
        // Resolved NO but nobody backed NO: every YES stake comes back.
        'PDA-refund': market(30000n, 0n, { resolved: true, outcome: NO }),
        'PDA-done': market(20000n, 0n, { resolved: true, outcome: YES }),
        'PDA-open': market(10000n, 10000n),
        'PDA-terminal': market(10000n, 40000n)
    };
    const positions = {
        'PDA-won': { yes: position(20000n), no: null },
        'PDA-lost': { yes: position(20000n), no: null },
        'PDA-refund': { yes: position(30000n), no: null },
        'PDA-done': { yes: position(20000n, true), no: null },
        'PDA-open': { yes: null, no: position(10000n) },
        'PDA-terminal': { yes: null, no: position(10000n) }
    };
    const base = { proposals: settled, markets, positions, proposalStatuses: { 'PDA-open': 'active', 'PDA-terminal': 'cancelled' }, budget: ROOMY };

    it('claims the largest resolved payout first, then a refund, then one that must resolve first', () => {
        const decision = decideCollect(base);
        expect(decision.action).toMatchObject({ type: 'claim', side: 'yes', proposalId: 'won', proposalAccount: 'PDA-won', resolveFirst: false, usdc: 0, signedActions: 1, payout: '0.08' });
        expect(decision.options.map(option => `${option.proposalId}:${option.action.side}:${option.action.payout}`))
            .toEqual(['won:yes:0.08', 'refund:yes:0.03', 'terminal:no:0.0125']);
        expect(decision.options[1].action.rationale).toMatch(/nobody backed that side/);
        expect(decision.options[2].action).toMatchObject({ resolveFirst: true, outcome: 'no', signedActions: 2 });
    });

    it('skips positions already claimed on-chain or in this invocation\'s history', () => {
        const decision = decideCollect({ ...base, history: { claimedPositions: ['won:yes', 'refund:yes'] } });
        expect(decision.action).toMatchObject({ proposalId: 'terminal', resolveFirst: true });
        expect(societyHistory({ simulated: [{ type: 'claim', side: 'yes', proposalId: 'won' }] }).claimedPositions).toEqual(['won:yes']);
    });

    it('owes nothing on an open market whose proposal is not terminal, nor without a status read', () => {
        expect(settlement(markets['PDA-open'], 'active')).toBeNull();
        expect(settlement(markets['PDA-open'], null)).toBeNull();
        expect(settlement(markets['PDA-open'], 'executed')).toEqual({ outcome: 'yes', resolveFirst: true });
        expect(settlement(null, 'executed')).toBeNull();
        const decision = decideCollect({ ...base, proposals: [settled[4], settled[1], settled[3]] });
        expect(decision).toMatchObject({ action: null, capped: false, options: [] });
    });

    it('leaves a resolve-first claim for a later turn when only one signed action is left', () => {
        const decision = decideCollect({ ...base, proposals: [settled[5]], budget: { actionsLeft: 1, usdcLeft: 0 } });
        expect(decision).toMatchObject({ action: null, capped: true });
    });

    it('runs before the role policy and falls through to it when nothing is owed', () => {
        const roleDecide = () => ({ action: { type: 'stake', side: 'yes', proposalId: 'x' }, options: [], capped: false, reason: 'role' });
        const owed = decideTurn(roleDecide, base);
        expect(owed).toMatchObject({ step: 'collect', action: { type: 'claim', proposalId: 'won' } });
        const nothing = decideTurn(roleDecide, { ...base, positions: {} });
        expect(nothing).toMatchObject({ step: 'role', action: { type: 'stake' }, owedClaims: 0 });
        const capped = decideTurn(() => ({ action: null, options: [], capped: false, reason: 'none' }), { ...base, proposals: [settled[5]], budget: { actionsLeft: 1, usdcLeft: 0 } });
        expect(capped).toMatchObject({ step: 'role', action: null, capped: true, owedClaims: 1 });
    });
});
