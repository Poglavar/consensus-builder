// What the society and supporter policies read (agents/discovery.js): every city's proposal
// summaries, paged and deduplicated by authored id, newest first, and the chain state of the minted
// ones checked as a batch before any of it is applied. Named plans are gone (plan-design-agreement.md
// M2), so discovery never asks for them.
import { describe, expect, it, vi } from 'vitest';
import { applyProposalStatuses, discoverProposalInputs, SUMMARY_PAGE } from '../agents/discovery.js';
import { proposalAccountBytes } from './fixtures/proposal-account.js';
import { PublicKey } from '@solana/web3.js';
import { PROPOSAL_PROGRAM_ID } from '../agents/lifecycle-actions.js';

const accountFor = value => new PublicKey(Buffer.alloc(32, value)).toBase58();
const minted = (proposalId, value, extra = {}) => ({
    proposalId, lifecycleStatus: 'Active',
    onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(value) }, ...extra
});
const chainInfo = status => ({ owner: new PublicKey(PROPOSAL_PROGRAM_ID), data: proposalAccountBytes({ status }) });

function apiFetch(byCity) {
    return vi.fn(async url => {
        const parsed = new URL(url);
        if (parsed.pathname !== '/proposals/summary') throw new Error(`unexpected request ${url}`);
        const proposals = byCity[parsed.searchParams.get('city') || ''] || [];
        const offset = Number(parsed.searchParams.get('offset') || 0);
        const limit = Number(parsed.searchParams.get('limit') || SUMMARY_PAGE);
        return { proposals: proposals.slice(offset, offset + limit), count: proposals.length };
    });
}

describe('agent proposal discovery', () => {
    it('pages every city\'s summaries, merges them by authored id, newest first, and never asks for named plans', async () => {
        const ordinary = Array.from({ length: 1001 }, (_, index) => ({
            id: String(index + 1), proposalId: `authored-${index + 1}`, createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`
        }));
        const shared = { id: '5000', proposalId: 'shared-record', createdAt: '2026-10-01T00:00:00Z' };
        const fetchJson = apiFetch({ '': ordinary, zagreb: [shared, { ...ordinary[0] }] });
        const result = await discoverProposalInputs({ apiBase: 'http://api', cities: [null, 'zagreb'], fetchJson });

        const offsets = fetchJson.mock.calls.map(([url]) => new URL(url)).filter(url => !url.searchParams.get('city'))
            .map(url => url.searchParams.get('offset'));
        expect(offsets).toEqual(['0', '1000']);
        expect(fetchJson.mock.calls.every(([url]) => new URL(url).pathname === '/proposals/summary')).toBe(true);
        expect(result).toHaveLength(1002);
        expect(result[0]).toBe(shared);
        expect(new Set(result.map(item => item.proposalId)).size).toBe(1002);
        expect(result.some(item => item.planSlug || String(item.id).startsWith('plan:'))).toBe(false);
    });

    it('refuses a summary without its authored id rather than merging records by row number', async () => {
        const fetchJson = apiFetch({ '': [{ id: '7', proposalId: '7' }] });
        await expect(discoverProposalInputs({ apiBase: 'http://api', cities: [null], fetchJson })).rejects.toThrow(/authored proposalId/);
    });
});

describe('applyProposalStatuses', () => {
    it('applies decoded chain states to the minted proposals only, after checking the whole batch', () => {
        const proposals = [
            minted('active', 10, { lifecycleStatus: 'Unknown' }),
            minted('executed', 11),
            { proposalId: 'off-chain', lifecycleStatus: 'Active' },
            minted('expired', 12),
            minted('cancelled', 13)
        ];
        const out = applyProposalStatuses(proposals, [0, 1, 3, 2].map(chainInfo));
        expect(out).toBe(proposals);
        expect(proposals.map(item => item.lifecycleStatus)).toEqual(['Active', 'Executed', 'Active', 'Expired', 'Cancelled']);
        expect(proposals.map(item => item.onchainLifecycleStatus)).toEqual(['Active', 'Executed', undefined, 'Expired', 'Cancelled']);
        // A local deadline that passed still keeps a chain-Active proposal out of support.
        const lapsed = [minted('lapsed', 14, { expiresAt: '2000-01-01T00:00:00Z' })];
        applyProposalStatuses(lapsed, [chainInfo(0)]);
        expect(lapsed[0]).toMatchObject({ onchainLifecycleStatus: 'Active', lifecycleStatus: 'Expired' });
    });

    it('refuses a missing, foreign or malformed account, and then changes nothing', () => {
        const first = () => [minted('first', 20), minted('second', 21)];
        expect(() => applyProposalStatuses([minted('only', 22)], [null])).toThrow(/chain account .* is missing/);
        expect(() => applyProposalStatuses([minted('only', 22)], [{ owner: PublicKey.default, data: proposalAccountBytes() }]))
            .toThrow(/not owned by the proposal program/);
        expect(() => applyProposalStatuses([minted('only', 22)], [{ owner: new PublicKey(PROPOSAL_PROGRAM_ID), data: Buffer.alloc(64) }]))
            .toThrow(/not a Proposal account/);
        expect(() => applyProposalStatuses([minted('only', 22)], [chainInfo(9)])).toThrow(/invalid on-chain status 9/);
        expect(() => applyProposalStatuses(first(), [chainInfo(1)])).toThrow(/received 1 chain states for 2/);

        const untouched = first();
        expect(() => applyProposalStatuses(untouched, [chainInfo(1), { owner: PublicKey.default, data: proposalAccountBytes() }]))
            .toThrow(/not owned by the proposal program/);
        expect(untouched.map(item => [item.lifecycleStatus, item.onchainLifecycleStatus])).toEqual([['Active', undefined], ['Active', undefined]]);
    });
});
