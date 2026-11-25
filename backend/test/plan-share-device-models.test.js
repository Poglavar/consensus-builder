// Share plan asks about device-only models when the person publishes, never when the box opens:
// a published plan just shows its link, and Cancel at the question publishes nothing.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/plan-dialog.js', import.meta.url), 'utf8');
const share = source.slice(source.indexOf('    async function share('), source.indexOf('    // The construction windows of a plan'));

function element() {
    return { children: [], textContent: '', append(...items) { this.children.push(...items); }, remove: vi.fn(), setAttribute() {} };
}

function setup({ published = null, settle = async () => false, nameNeeded = null } = {}) {
    const exact = { cid: 'plan-1', content: { title: 'Plan', designCids: ['design-1'] }, designs: [{ cid: 'design-1' }] };
    const records = [{ proposalId: 'p-1', modelUrl: 'device-model:sha256-ab', cid: 'design-1' }];
    const buttons = [];
    const win = {
        PlanWorkspace: {
            resolve: vi.fn(async () => exact), save: vi.fn(), publication: vi.fn(async () => published),
            publish: vi.fn(async row => ({ link: `link:${row.cid}` }))
        },
        PlanComposition: { localRecords: () => [] },
        SharedPlanSession: {
            currentMembers: () => records.map(record => ({ ...record })),
            composeCurrentPlan: (plan, members) => ({ cid: `plan-${members[0].cid}`, content: plan.content, designs: members })
        },
        proposalStorage: { getAllProposals: () => records, getProposal: id => records.find(record => record.proposalId === id) },
        DesignSync: {
            apiBase: () => '', publishedCid: () => null, copyLink: vi.fn(async () => true),
            settleDeviceModels: vi.fn(async members => {
                const uploaded = await settle(members);
                if (uploaded) records[0] = { ...records[0], modelUrl: '/uploads/models/a.glb', cid: 'design-2' };
                return uploaded;
            })
        },
        DesignRecord: { cidOf: member => member.cid },
        ShareDialog: { render: ({ link }) => ({ link }) },
        guestPolicyBlocks: vi.fn(() => nameNeeded)
    };
    const context = vm.createContext({
        win, closeContexts() {}, memberList: () => element(), t: key => key,
        node: (_tag, _cls, text = '') => Object.assign(element(), { textContent: text }),
        button: (label, onClick) => { const item = Object.assign(element(), { label, click: onClick }); buttons.push(item); return item; },
        openDialog: (_title, body) => body
    });
    vm.runInContext(`${share}\nthis.share = share;`, context);
    return { win, share: context.share, button: label => buttons.find(item => item.label === label) };
}

describe('Share plan and device-only models', () => {
    it('opens without asking, and asks when the person publishes', async () => {
        const f = setup({ settle: async () => false });
        await f.share({ cid: 'plan-1' });
        expect(f.win.DesignSync.settleDeviceModels).not.toHaveBeenCalled();
        await f.button('publishAndCopy').click();
        expect(f.win.DesignSync.settleDeviceModels).toHaveBeenCalledWith([expect.objectContaining({ proposalId: 'p-1' })]);
        expect(f.win.PlanWorkspace.publish).toHaveBeenCalledWith(expect.objectContaining({ cid: 'plan-1' }));
    });

    it('publishes the plan revision that names the uploaded models', async () => {
        const f = setup({ settle: async () => true });
        const body = await f.share({ cid: 'plan-1' });
        await f.button('publishAndCopy').click();
        expect(f.win.PlanWorkspace.publish).toHaveBeenCalledWith(expect.objectContaining({ cid: 'plan-design-2' }));
        expect(f.win.PlanWorkspace.save).toHaveBeenCalledWith(expect.objectContaining({ cid: 'plan-design-2' }));
        expect(body.children.at(-1)).toEqual({ link: 'link:plan-design-2' });
    });

    it('publishes nothing when the person cancels at the question', async () => {
        const f = setup({ settle: async () => { throw Object.assign(new Error('Nothing was published.'), { cancelled: true }); } });
        const body = await f.share({ cid: 'plan-1' });
        await f.button('publishAndCopy').click();
        expect(f.win.PlanWorkspace.publish).not.toHaveBeenCalled();
        expect(body.children.find(item => item.textContent === 'Nothing was published.')).toBeTruthy();
    });

    it('asks a guest for a name before asking about models, so no model goes public for nothing', async () => {
        const f = setup({ nameNeeded: 'Choose a profile name to publish.' });
        const body = await f.share({ cid: 'plan-1' });
        await f.button('publishAndCopy').click();
        expect(f.win.DesignSync.settleDeviceModels).not.toHaveBeenCalled();
        expect(f.win.PlanWorkspace.publish).not.toHaveBeenCalled();
        expect(body.children.find(item => item.textContent === 'Choose a profile name to publish.')).toBeTruthy();
    });

    it('shows a published plan\'s link without asking about models', async () => {
        const f = setup({ published: { link: 'link:plan-1' } });
        const body = await f.share({ cid: 'plan-1' });
        expect(f.win.DesignSync.settleDeviceModels).not.toHaveBeenCalled();
        expect(body.children.at(-1)).toEqual({ link: 'link:plan-1' });
    });
});
