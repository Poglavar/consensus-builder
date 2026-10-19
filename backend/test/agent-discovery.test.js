import { describe, expect, it, vi } from 'vitest';
import { applyPlanStatuses, discoverProposalInputs, loadPlanRecord } from '../agents/discovery.js';
import { PublicKey } from '@solana/web3.js';
import { PROPOSAL_PROGRAM_ID } from '../agents/lifecycle-actions.js';
import { eligibleSupportProposals, selectSupportAction } from '../agents/supporter-picker.js';
import { decide as decideContrarian } from '../agents/policies/contrarian.js';

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
            return { items: ids.map(id => ({ id, proposal: { geometry: { buildings: [{ id: `building-${id}` }] } } })) };
        }
        throw new Error(`unexpected request ${url}`);
    });
}

describe('agent named-plan discovery', () => {
    it('paginates ordinary proposals independently, includes minted plans for all cities, and namespaces plan ids', async () => {
        const ordinary = Array.from({ length: 1001 }, (_, index) => ({ id: String(index + 1), proposalId: `authored-${index + 1}` }));
        const fetchJson = apiFetch({
            proposals: ordinary,
            plans: [
                { slug: 'minted-plan', proposalAccount: 'plan-account', onchain: { chainId: 'solana-devnet' }, proposalRowIds: ['11'], createdAt: '2026-01-01' },
                { slug: 'unminted-plan', proposalAccount: null, proposalRowIds: ['12'] }
            ],
            details: { 'minted-plan': { slug: 'minted-plan', proposalAccount: 'plan-account', proposalRowIds: ['11'], members: [{ proposalRowId: '11', changed: false }] } }
        });
        const result = await discoverProposalInputs({ apiBase: 'http://api', cities: [null], fetchJson });
        expect(fetchJson.mock.calls.filter(([url]) => url.includes('/proposals/summary')).map(([url]) => new URL(url).searchParams.get('offset'))).toEqual(['0', '1000']);
        expect(fetchJson).toHaveBeenCalledWith('http://api/plans');
        expect(fetchJson).toHaveBeenCalledWith('http://api/plans/minted-plan');
        expect(fetchJson).not.toHaveBeenCalledWith('http://api/plans/unminted-plan');
        expect(result).toHaveLength(1002);
        expect(result.find(item => item.planSlug)).toMatchObject({
            id: 'plan:minted-plan', proposalId: 'plan:minted-plan', planSlug: 'minted-plan', goal: 'plan',
            lifecycleStatus: 'Active', onchain: { proposalId: 'plan-account' }
        });
    });

    it('excludes missing, changed, and account-colliding plans with a reason', async () => {
        const logs = [];
        const fetchJson = apiFetch({
            proposals: [{ id: '7', proposalId: 'ordinary', onchain: { proposalId: 'same-account' } }],
            plans: ['missing', 'changed', 'duplicate'].map(slug => ({ slug, proposalAccount: slug === 'duplicate' ? 'same-account' : `account-${slug}`, proposalRowIds: ['7'] })),
            details: {
                missing: { proposalRowIds: ['7'], members: [{ proposalRowId: '7', missing: true }] },
                changed: { proposalRowIds: ['7'], members: [{ proposalRowId: '7', changed: true }] },
                duplicate: { proposalRowIds: ['7'], members: [{ proposalRowId: '7', changed: false }] }
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
        const failingFetch = apiFetch({ plans: [{ slug: 'unavailable', proposalAccount: 'account', proposalRowIds: ['1'] }] });
        await expect(discoverProposalInputs({ apiBase: 'http://api', cities: [null], fetchJson: failingFetch }))
            .rejects.toThrow(/named plan unavailable detail request failed/);

        const collisionFetch = apiFetch({
            proposals: [{ id: '2', proposalId: 'plan:conflict' }],
            plans: [{ slug: 'conflict', proposalAccount: 'plan-account', proposalRowIds: ['1'] }],
            details: { conflict: { proposalRowIds: ['1'], members: [{ proposalRowId: '1', changed: false }] } }
        });
        await expect(discoverProposalInputs({ apiBase: 'http://api', cities: [null], fetchJson: collisionFetch }))
            .rejects.toThrow(/proposal identifier collision with named plan conflict/);
    });

    it('applies decoded terminal chain states and refuses missing or wrongly owned accounts', () => {
        const proposals = [
            { planSlug: 'active', onchain: { proposalId: 'account-a' }, lifecycleStatus: 'Active' },
            { planSlug: 'executed', onchain: { proposalId: 'account-b' }, lifecycleStatus: 'Active' },
            { planSlug: 'expired', onchain: { proposalId: 'account-c' }, lifecycleStatus: 'Active' }
        ];
        proposals.forEach(plan => { plan.planHash = 'committed-hash'; });
        const infos = [0, 1, 3].map((status, index) => ({ owner: new PublicKey(PROPOSAL_PROGRAM_ID),
            data: { status, imageUri: `ugt-plan:${proposals[index].planSlug}@committed-hash` } }));
        expect(applyPlanStatuses(proposals, infos, { decodeState: data => data }).map(plan => plan.lifecycleStatus))
            .toEqual(['Active', 'Executed', 'Expired']);
        expect(() => applyPlanStatuses([proposals[0]], [{ owner: new PublicKey(PROPOSAL_PROGRAM_ID),
            data: { status: 0, imageUri: 'ugt-plan:different@hash' } }], { decodeState: data => data }))
            .toThrow(/does not commit to its current content/);
        expect(() => applyPlanStatuses([proposals[0]], [null], { decodeState: data => data })).toThrow(/account-a is missing/);
        expect(() => applyPlanStatuses([proposals[0]], [{ owner: PublicKey.default, data: { status: 0 } }], { decodeState: data => data }))
            .toThrow(/not owned by the proposal program/);
    });

    it('loads the same named plan once when it appears in more than one city result', async () => {
        const plan = { slug: 'same-plan', proposalAccount: 'same-account', proposalRowIds: ['8'] };
        const fetchJson = apiFetch({
            plans: [plan],
            details: { 'same-plan': { proposalRowIds: ['8'], members: [{ proposalRowId: '8', changed: false }] } }
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
