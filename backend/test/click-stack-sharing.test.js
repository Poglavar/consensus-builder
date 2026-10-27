// Design Share acts on one selected design; saved plan actions use their exact member revisions.
import { testI18n } from './helpers/i18n.js';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDocument } from './helpers/fake-dom.js';

const require = createRequire(import.meta.url);
const Memberships = require('../../frontend/js/design-memberships.js');
const source = readFileSync(new URL('../../frontend/js/proposals/sharing-routes.js', import.meta.url), 'utf8');
const design = id => ({ proposalId: id, title: id, cid: `cid-${id}` });

function fixture(planRows = []) {
    const a = design('garden'), b = design('square'), other = design('other');
    const designs = [a, b, other];
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
        i18n: testI18n()
    };
    return { win, a, b, other };
}
const plan = (cid, title, ids) => ({ cid, title, content: { title, designCids: ids.map(id => `cid-${id}`), view: {} } });

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
        await vi.waitFor(() => expect(f.win.shareAppliedProposals).toHaveBeenCalledWith({
            plan: { cid: 'plan-exact', content }, members: [f.a]
        }));
    });
});

describe('design Share action', () => {
    function route() {
        const proposal = design('garden');
        const win = { CbDialog: { choice: vi.fn() }, ensureOptionalTool: vi.fn(), showStyledAlert: vi.fn() };
        const context = { window: win, document: makeDocument(), currentProposalDetailsContext: proposal,
            getProposalI18nHelper: () => (_key, fallback) => fallback };
        vm.createContext(context); vm.runInContext(source, context);
        context.shareSingleProposal = vi.fn();
        return { proposal, win, context };
    }
    it('shares exactly the selected design without opening a scope chooser', async () => {
        const f = route();
        await f.context.shareProposalFromDetails();
        expect(f.context.shareSingleProposal).toHaveBeenCalledWith(f.proposal);
        expect(f.win.CbDialog.choice).not.toHaveBeenCalled();
    });
});
