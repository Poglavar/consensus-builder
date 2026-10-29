import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../frontend/js/plan-dialog.js', import.meta.url), 'utf8');
const sync = source.slice(source.indexOf('    async function syncSharedPlanOnMap('), source.indexOf('    async function details(', source.indexOf('    async function syncSharedPlanOnMap(')));
function setup() {
    const finish = vi.fn(async () => {}), cancel = vi.fn();
    const win = {
        SharedPlanMotion: { prepare: vi.fn(() => ({ finish, cancel })) },
        DesignSync: { apiBase: () => '', parcelSourceIdOf: () => 'ground' },
        __siteBinding: { siteOf: () => ({}) },
        fetch: vi.fn(async () => ({ ok: true, json: async () => ({ binding: {} }) })),
        handleSharedDesignRoute: vi.fn(async cids => ({ failed: [], blocked: false, localIds: new Map(cids.map(cid => [cid, `id-${cid}`])) })),
        PlanWorkspace: { save: vi.fn() }, PlanComposition: { localRecords: () => [] },
        ClickStack: { showPlan: vi.fn(async () => {}) }, i18n: { t: () => 'Updated' }
    };
    const context = vm.createContext({ win, Map, Set });
    vm.runInContext(`${sync}\nthis.run = syncSharedPlanOnMap`, context);
    return { win, finish, cancel, run: context.run };
}
const member = cid => ({ cid, content: { city: 'test' } });
const row = cids => ({ designs: cids.map(member), content: { designCids: cids } });

describe('shared plan map synchronization', () => {
    it('binds and applies only changed members and finishes motion with aligned ids', async () => {
        const f = setup(), previous = { ...row(['old', 'keep']), memberIds: ['old-id', 'keep-id'] }, next = row(['new', 'keep']);
        const lastChange = { members: [{ beforeCid: 'old', afterCid: 'new' }] };
        await f.run(next, previous, { lastChange });
        expect(f.win.fetch).toHaveBeenCalledTimes(1);
        expect(f.win.SharedPlanMotion.prepare).toHaveBeenCalledWith(expect.objectContaining({ previous, next, change: lastChange, changedBeforeIds: ['old-id'] }));
        expect(f.win.handleSharedDesignRoute).toHaveBeenCalledWith(['new'], expect.objectContaining({ replaceAppliedIds: ['old-id'], retainedProposalIds: ['keep-id'], sharedPlanSessionRemote: true }));
        expect(next.memberIds).toEqual(['id-new', 'keep-id']);
        expect(f.finish).toHaveBeenCalledWith({ next, memberIds: next.memberIds });
    });
    it('saves metadata-only revisions without binding or rematerializing', async () => {
        const f = setup(), previous = { ...row(['keep']), memberIds: ['keep-id'] }, next = row(['keep']);
        await f.run(next, previous);
        expect(f.win.fetch).not.toHaveBeenCalled(); expect(f.win.handleSharedDesignRoute).not.toHaveBeenCalled();
        expect(f.win.PlanWorkspace.save).toHaveBeenCalledWith(next); expect(next.memberIds).toEqual(['keep-id']);
    });
    it('cancels motion and leaves the plan unsaved when application fails', async () => {
        const f = setup(), previous = { ...row(['old']), memberIds: ['old-id'] }, next = row(['new']);
        f.win.handleSharedDesignRoute.mockResolvedValue({ failed: [], blocked: true });
        await expect(f.run(next, previous)).rejects.toThrow('could not be shown');
        expect(f.cancel).toHaveBeenCalledOnce(); expect(f.finish).not.toHaveBeenCalled(); expect(f.win.PlanWorkspace.save).not.toHaveBeenCalled();
    });
});
