import { describe, expect, it, vi } from 'vitest';
import { applyProposalStatuses, discoverProposalInputs, loadPlanRecord, verifiedPlanMembership } from '../agents/discovery.js';
import { proposalAccountBytes } from './fixtures/proposal-account.js';
import { PublicKey } from '@solana/web3.js';
import { PROPOSAL_PROGRAM_ID } from '../agents/lifecycle-actions.js';
import { eligibleSupportProposals, selectSupportAction } from '../agents/supporter-picker.js';
import { decide as decideContrarian } from '../agents/policies/contrarian.js';

const accountFor = value => new PublicKey(Buffer.alloc(32, value)).toBase58();
const planRecord = ({ slug, account, proposalRowIds, ...rest }) => ({
    slug, proposalRowIds, planHash: 'a'.repeat(64),
    onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: account }, ...rest
});

function apiFetch({ proposals = [], plans = [], details = {} } = {}) {
    return vi.fn(async (url, options = {}) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/proposals/summary') {
            const offset = Number(parsed.searchParams.get('offset') || 0);
            const limit = Number(parsed.searchParams.get('limit') || 1000);
            return { proposals: proposals.slice(offset, offset + limit), count: proposals.length };
        }
        if (parsed.pathname === '/plans') return { plans };
        if (parsed.pathname.startsWith('/plans/')) {
            const slug = decodeURIComponent(parsed.pathname.split('/').at(-1));
            if (!details[slug]) throw new Error('404');
            return details[slug];
        }
        if (parsed.pathname === '/proposals/batch') {
            const ids = JSON.parse(options.body).ids;
            return { items: ids.map(id => ({ id, proposal: { id, geometry: { buildings: [{ id: `building-${id}` }] } } })) };
        }
        throw new Error(`unexpected request ${url}`);
    });
}

describe('agent named-plan discovery', () => {
    it('accepts only a complete current membership and matching chain account commitment', () => {
        const listed = planRecord({ slug: 'plan', account: accountFor(8), proposalRowIds: ['31'] });
        const detail = { ...listed, members: [{ proposalRowId: '31', changed: false }] };
        expect(verifiedPlanMembership(listed, detail)).toBeNull();
        expect(verifiedPlanMembership(listed, { ...detail, planHash: 'bad' })).toBe('commitment unavailable');
        expect(verifiedPlanMembership(listed, { ...detail, proposalRowIds: ['31', '32'] })).toBe('membership changed');
        expect(verifiedPlanMembership(listed, { ...detail, onchain: { ...listed.onchain, proposalId: accountFor(9) } }))
            .toBe('chain account changed');
    });

    it('paginates ordinary proposals independently, includes minted plans for all cities, and namespaces plan ids', async () => {
        const ordinary = Array.from({ length: 1001 }, (_, index) => ({ id: String(index + 1), proposalId: `authored-${index + 1}` }));
        const fetchJson = apiFetch({
            proposals: ordinary,
            plans: [
                planRecord({ slug: 'minted-plan', account: accountFor(1), proposalRowIds: ['11'], createdAt: '2026-01-01' }),
                { slug: 'unminted-plan', proposalAccount: null, proposalRowIds: ['12'] }
            ],
            details: { 'minted-plan': { slug: 'minted-plan', proposalRowIds: ['11'], planHash: 'a'.repeat(64),
                onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(1) },
                members: [{ proposalRowId: '11', changed: false }] } }
        });
        const result = await discoverProposalInputs({ apiBase: 'http://api', cities: [null], fetchJson });
        expect(fetchJson.mock.calls.filter(([url]) => url.includes('/proposals/summary')).map(([url]) => new URL(url).searchParams.get('offset'))).toEqual(['0', '1000']);
        expect(fetchJson).toHaveBeenCalledWith('http://api/plans');
        expect(fetchJson).toHaveBeenCalledWith('http://api/plans/minted-plan');
        expect(fetchJson).not.toHaveBeenCalledWith('http://api/plans/unminted-plan');
        expect(result).toHaveLength(1002);
        expect(result.find(item => item.planSlug)).toMatchObject({
            id: 'plan:minted-plan', proposalId: 'plan:minted-plan', planSlug: 'minted-plan', goal: 'plan',
            lifecycleStatus: 'Unknown', onchain: { proposalId: accountFor(1) }
        });
    });

    it('excludes missing, changed, and account-colliding plans with a reason', async () => {
        const logs = [];
        const fetchJson = apiFetch({
            proposals: [{ id: '7', proposalId: 'ordinary', onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(2) } }],
            plans: ['missing', 'changed', 'duplicate'].map((slug, index) => planRecord({ slug, account: slug === 'duplicate' ? accountFor(2) : accountFor(3 + index), proposalRowIds: ['7'] })),
            details: {
                missing: { slug: 'missing', proposalRowIds: ['7'], planHash: 'a'.repeat(64), onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(3) }, members: [{ proposalRowId: '7', missing: true }] },
                changed: { slug: 'changed', proposalRowIds: ['7'], planHash: 'a'.repeat(64), onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(4) }, members: [{ proposalRowId: '7', changed: true }] },
                duplicate: { slug: 'duplicate', proposalRowIds: ['7'], planHash: 'a'.repeat(64), onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(2) }, members: [{ proposalRowId: '7', changed: false }] }
            }
        });
        const result = await discoverProposalInputs({ apiBase: 'http://api', cities: ['zagreb'], fetchJson, log: message => logs.push(message) });
        expect(result.map(item => item.id)).toEqual(['7']);
        expect(logs).toEqual(expect.arrayContaining([
            expect.stringContaining('missing: excluded (member missing)'),
            expect.stringContaining('changed: excluded (member changed)'),
            expect.stringContaining('duplicate: excluded (Solana account already represented)')
        ]));
        expect(fetchJson).toHaveBeenCalledWith('http://api/plans?city=zagreb');
    });

    it('propagates plan-detail read errors and refuses an authored-id collision', async () => {
        const failingFetch = apiFetch({ plans: [planRecord({ slug: 'unavailable', account: accountFor(5), proposalRowIds: ['1'] })] });
        await expect(discoverProposalInputs({ apiBase: 'http://api', cities: [null], fetchJson: failingFetch }))
            .rejects.toThrow(/named plan unavailable detail request failed/);

        const collisionFetch = apiFetch({
            proposals: [{ id: '2', proposalId: 'plan:conflict' }],
            plans: [planRecord({ slug: 'conflict', account: accountFor(6), proposalRowIds: ['1'] })],
            details: { conflict: { slug: 'conflict', proposalRowIds: ['1'], planHash: 'a'.repeat(64),
                onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(6) },
                members: [{ proposalRowId: '1', changed: false }] } }
        });
        await expect(discoverProposalInputs({ apiBase: 'http://api', cities: [null], fetchJson: collisionFetch }))
            .rejects.toThrow(/proposal identifier collision with named plan conflict/);
    });

    it('applies decoded terminal chain states to named plans and ordinary minted proposals atomically', () => {
        const proposals = [
            { planSlug: 'active', onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(10) }, lifecycleStatus: 'Unknown', planHash: 'committed-hash' },
            { planSlug: 'executed', onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(11) }, lifecycleStatus: 'Active', planHash: 'committed-hash' },
            { planSlug: 'expired', onchain: { chainId: 'solana-devnet', contractAddress: PROPOSAL_PROGRAM_ID, proposalId: accountFor(12) }, lifecycleStatus: 'Active', planHash: 'committed-hash' },
            { proposalId: 'ordinary-minted', onchain: { chainId: 'solana-devnet', proposalId: accountFor(13) }, lifecycleStatus: 'Active' }
        ];
        const infos = [0, 1, 3, 2].map((status, index) => ({ owner: new PublicKey(PROPOSAL_PROGRAM_ID),
            data: proposalAccountBytes({ status, imageUri: index < 3
                ? `ugt-plan:${proposals[index].planSlug}@committed-hash` : 'https://example.test/ordinary' }) }));
        expect(applyProposalStatuses(proposals, infos).map(plan => plan.lifecycleStatus))
            .toEqual(['Active', 'Executed', 'Expired', 'Cancelled']);
        expect(proposals.map(plan => plan.onchainLifecycleStatus)).toEqual(['Active', 'Executed', 'Expired', 'Cancelled']);

        expect(() => applyProposalStatuses([proposals[0]], [{ owner: new PublicKey(PROPOSAL_PROGRAM_ID),
            data: proposalAccountBytes({ imageUri: 'ugt-plan:different@hash' }) }]))
            .toThrow(/does not commit to its current content/);
        expect(() => applyProposalStatuses([proposals[0]], [null])).toThrow(/chain account .* is missing/);
        expect(() => applyProposalStatuses([proposals[0]], [{ owner: PublicKey.default, data: proposalAccountBytes() }]))
            .toThrow(/not owned by the proposal program/);

        const untouched = [
            { ...proposals[0], lifecycleStatus: 'Unknown', onchainLifecycleStatus: undefined },
            { ...proposals[1], lifecycleStatus: 'Active', onchainLifecycleStatus: undefined }
        ];
        expect(() => applyProposalStatuses(untouched, [infos[0], { ...infos[1], data: proposalAccountBytes({ imageUri: 'ugt-plan:wrong@hash' }) }]))
            .toThrow(/does not commit to its current content/);
        expect(untouched.map(plan => [plan.lifecycleStatus, plan.onchainLifecycleStatus]))
            .toEqual([['Unknown', undefined], ['Active', undefined]]);
    });

    it('loads the same named plan once when it appears in more than one city result', async () => {
        const plan = planRecord({ slug: 'same-plan', account: accountFor(7), proposalRowIds: ['8'] });
        const fetchJson = apiFetch({
            plans: [plan],
            details: { 'same-plan': { slug: 'same-plan', proposalRowIds: ['8'], planHash: 'a'.repeat(64), onchain: plan.onchain,
                members: [{ proposalRowId: '8', changed: false }] } }
        });
        const result = await discoverProposalInputs({ apiBase: 'http://api', cities: ['zagreb', 'sibenik'], fetchJson });
        expect(result.filter(proposal => proposal.planSlug)).toHaveLength(1);
        expect(fetchJson.mock.calls.filter(([url]) => url.endsWith('/plans/same-plan'))).toHaveLength(1);
    });

    it('loads 1001 member rows in bounded batch calls and carries each building source row ID', async () => {
        const ids = Array.from({ length: 1001 }, (_, index) => String(index + 1));
        const fetchJson = apiFetch();
        const record = await loadPlanRecord({
            apiBase: 'http://api', fetchJson,
            plan: { id: 'plan:large', proposalId: 'plan:large', planSlug: 'large', title: 'Large', proposalRowIds: ids }
        });
        const calls = fetchJson.mock.calls.filter(([url]) => url.endsWith('/proposals/batch'));
        expect(calls.map(([, options]) => JSON.parse(options.body).ids.length)).toEqual([1000, 1]);
        expect(record.evidence).toEqual({ sourceProposalRowIds: ids, buildingCount: 1001 });
        expect(record.geometry.buildings[1000]).toMatchObject({ id: 'building-1001', sourceProposalRowId: '1001' });
    });

    it('lets the existing support policy select a named plan by its real chain account', async () => {
        const plan = { id: 'plan:park', proposalId: 'plan:park', title: 'Pocket park', lifecycleStatus: 'Active', author: 'other', onchain: { proposalId: 'real-plan-account' } };
        expect(eligibleSupportProposals([plan], { wallet: 'supporter' })).toEqual([plan]);
        expect(selectSupportAction({ day: '2026-10-19', persona: { name: 'supporter', support: { actions: ['pledge'] } }, proposals: [plan], wallet: 'supporter' }).selected)
            .toMatchObject({ proposalId: 'plan:park', proposalAccount: 'real-plan-account', proposalName: 'Pocket park' });
    });

    it('lets the society density policy score plan member geometry as record evidence', () => {
        const plan = {
            id: 'plan:tower-plan', proposalId: 'plan:tower-plan', planSlug: 'tower-plan', goal: 'plan',
            title: 'Tower plan', lifecycleStatus: 'Active', author: 'other', onchain: { proposalId: 'real-plan-account' },
            record: { geometry: { buildings: [{
                geometry: { type: 'Polygon', coordinates: [[[15, 45], [15.001, 45], [15.001, 45.001], [15, 45.001], [15, 45]]] },
                properties: { floors: 8, sourceProposalRowId: '51' }
            }] } }
        };
        const result = decideContrarian({ persona: { name: 'preservationist-01' }, seed: 'day', wallet: 'self', proposals: [plan] });
        expect(result.options[0]).toMatchObject({ proposalId: 'plan:tower-plan', action: { proposalAccount: 'real-plan-account', side: 'no' } });
        expect(result.options[0].evidence).toMatchObject({ source: 'record', score: expect.any(Number) });
    });
});
