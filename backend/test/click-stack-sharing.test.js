// Sharing from a design requires an explicit scope; a plan supplies only its exact member revisions.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const { prepare } = require('../../frontend/js/proposals/share-selection.js');
const Memberships = require('../../frontend/js/design-memberships.js');
const source = readFileSync(new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url), 'utf8');
const design = id => ({ proposalId: id, title: id, cid: `cid-${id}` });

function fixture(planRows = []) {
    const a = design('garden'), b = design('square'), other = design('other');
    const designs = [a, b, other];
    const dictionaries = {};
    const win = {
        fetch: vi.fn(async () => Response.json({ plans: planRows, hasMore: false, nextOffset: null })),
        console: { warn: vi.fn() }, resolveBackendBaseUrl: () => 'https://api.example.test',
        location: new URL('https://app.example.test/'),
        DesignSync: { publishedCid: record => record.cid || null,
            localCopyOf: cid => designs.find(record => record.cid === cid),
            fetchDesigns: vi.fn(), importDesign: vi.fn(), applyDesign: vi.fn() },
        AgreementStore: { list: () => [] },
        NamedPlans: { current: null, fetchPlan: vi.fn(async cid => planRows.find(row => row.cid === cid)), link: cid => `/plans/${cid}` },
        CbDialog: { choice: vi.fn() },
        proposalStorage: { getAllProposals: () => designs }, isApplied: record => record !== b,
        ClickStack: { close: vi.fn() }, ThreeClickStack: { close: vi.fn() },
        shareAppliedProposals: vi.fn(async () => 'ready'),
        showStyledAlert: vi.fn(), BusyControl: { track: vi.fn((_button, run) => run()) },
        ClickStackRelations: { renderGroup: (_group, doc) => doc.createElement('div') },
        i18n: {
            registerTranslations(language, values) { dictionaries[language] = { ...dictionaries[language], ...values }; },
            t: key => dictionaries.en?.[key] || key
        }
    };
    return { win, a, b, other };
}
const plan = (cid, title, ids) => ({ cid, title, content: { title, designCids: ids.map(id => `cid-${id}`), view: {} } });

describe('sharing selection', () => {
    const a = design('garden'), b = design('square'), other = design('other');
    it('selects the applied composition when no plan scope was supplied', () => {
        const result = prepare([a, other]);
        expect([...result.selected]).toEqual(['garden', 'other']);
    });
    it('includes an unapplied member but excludes unrelated applied designs', () => {
        const result = prepare([a, other], { members: [a, b] });
        expect([...result.proposals.keys()]).toEqual(['garden', 'other', 'square']);
        expect([...result.selected]).toEqual(['garden', 'square']);
    });
    it('preserves both exclusions and opt-ins across tabs, without selecting newly applied outsiders', () => {
        const result = prepare([a, other, design('new')], { members: [a, b],
            overrides: new Map([['garden', false], ['other', true], ['deleted', true]]) });
        expect([...result.selected]).toEqual(['square', 'other']);
    });
    it('keeps an explicit empty selection empty and uses the supplied exact revision', () => {
        const exact = { ...a, title: 'Exact saved revision' };
        expect(prepare([a], { members: [] }).selected.size).toBe(0);
        expect(prepare([a], { members: [exact] }).proposals.get(a.proposalId)).toBe(exact);
    });
});

describe('plan sharing entry points', () => {
    it('passes only the inspected plan members to the sharing panel without importing or applying them', async () => {
        const f = fixture();
        const content = { title: 'Garden plan', designCids: [f.a.cid, f.b.cid] };
        const session = { details: vi.fn(async () => ({ content, members: [{ proposal: f.a }, { proposal: f.b }] })) };
        await Memberships.sharePlan({ cid: 'plan-exact' }, f.win, session);
        expect(f.win.shareAppliedProposals).toHaveBeenCalledWith({ plan: { cid: 'plan-exact', content }, members: [f.a, f.b] });
        expect(f.win.ClickStack.close).toHaveBeenCalled();
        expect(f.win.ThreeClickStack.close).toHaveBeenCalled();
        expect(f.win.DesignSync.importDesign).not.toHaveBeenCalled();
        expect(f.win.DesignSync.applyDesign).not.toHaveBeenCalled();
    });
    it('mounts a primary Share plan button that opens the same sharing panel', async () => {
        const f = fixture(), doc = makeDocument(), host = doc.createElement('section'); doc.body.appendChild(host);
        const content = { title: 'Garden plan', designCids: [f.a.cid] };
        const session = { groups: { plans: { nextOffset: null, error: false, loading: false } },
            details: vi.fn(async () => ({ content, members: [{ proposal: f.a }], features: [] })) };
        Memberships.mountSection(host, 'plans', { cid: 'plan-exact', id: 'plan-exact', label: content.title, draft: true }, session, f.win);
        const button = host.querySelector('.click-stack__share-plan');
        expect(button.classList.contains('btn-primary')).toBe(true);
        expect(button.textContent).toBe('Share plan');
        button.click();
        await vi.waitFor(() => expect(f.win.shareAppliedProposals).toHaveBeenCalledWith({ plan: null, members: [f.a] }));
    });
    it('offers a choice when the design belongs to several plans and shares the chosen revision', async () => {
        const rows = [plan('plan-one', 'One', ['garden']), plan('plan-two', 'Two', ['garden', 'square'])];
        const f = fixture(rows);
        f.win.CbDialog.choice.mockResolvedValue('plan-two');
        await Memberships.shareFromDesign(f.a, f.win);
        expect(f.win.CbDialog.choice.mock.calls[0][1].map(choice => choice.label)).toEqual(['One', 'Two', 'common.cancel']);
        expect(f.win.shareAppliedProposals).toHaveBeenCalledWith({ plan: { cid: 'plan-two', content: rows[1].content }, members: [f.a, f.b] });
    });
    it('does not open sharing when the plan chooser is cancelled', async () => {
        const f = fixture([plan('plan-one', 'One', ['garden']), plan('plan-two', 'Two', ['garden'])]);
        f.win.CbDialog.choice.mockResolvedValue(null);
        await Memberships.shareFromDesign(f.a, f.win);
        expect(f.win.shareAppliedProposals).not.toHaveBeenCalled();
    });
    it('offers the applied composition and the selected design when no named plan exists', async () => {
        const f = fixture();
        await Memberships.shareFromDesign(f.a, f.win);
        const options = f.win.shareAppliedProposals.mock.calls[0][0];
        expect([...prepare([], options).selected]).toEqual(['garden', 'other']);
        expect(options.members).not.toContain(f.b);
    });
    it('does not silently share the whole map when plan lookup fails', async () => {
        const f = fixture();
        f.win.fetch.mockResolvedValue(new Response('', { status: 503 }));
        await expect(Memberships.shareFromDesign(f.a, f.win)).rejects.toThrow('Could not load this list.');
        expect(f.win.shareAppliedProposals).not.toHaveBeenCalled();
    });
});

describe('design Share scope warning', () => {
    function route(choice) {
        const proposal = design('garden');
        const win = { CbDialog: { choice: vi.fn(async () => choice) }, ensureOptionalTool: vi.fn(),
            DesignMemberships: { shareFromDesign: vi.fn() }, showStyledAlert: vi.fn() };
        const context = { window: win, document: makeDocument(), currentProposalDetailsContext: proposal,
            getProposalI18nHelper: () => (_key, fallback) => fallback };
        vm.createContext(context); vm.runInContext(source, context);
        context.shareSingleProposal = vi.fn();
        return { proposal, win, context };
    }
    it.each([null, 'cancel'])('publishes nothing when the warning is dismissed: %s', async choice => {
        const f = route(choice);
        await f.context.shareProposalFromDetails();
        expect(f.win.CbDialog.choice.mock.calls[0][0]).toContain('publishes only this design');
        expect(f.context.shareSingleProposal).not.toHaveBeenCalled();
        expect(f.win.DesignMemberships.shareFromDesign).not.toHaveBeenCalled();
    });
    it('publishes only the selected design after the person chooses that scope', async () => {
        const f = route('design');
        await f.context.shareProposalFromDetails();
        expect(f.context.shareSingleProposal).toHaveBeenCalledWith(f.proposal);
        expect(f.win.DesignMemberships.shareFromDesign).not.toHaveBeenCalled();
    });
    it('opens plan sharing without publishing when the whole-plan option is chosen', async () => {
        const f = route('plan');
        await f.context.shareProposalFromDetails();
        expect(f.context.shareSingleProposal).not.toHaveBeenCalled();
        expect(f.win.ensureOptionalTool).toHaveBeenCalledWith('designMemberships');
        expect(f.win.DesignMemberships.shareFromDesign).toHaveBeenCalledWith(f.proposal, f.win);
    });
});
