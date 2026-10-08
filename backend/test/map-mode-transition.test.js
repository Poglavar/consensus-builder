// Executes deferred mode transitions: only current intent may attach a view.
import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { createController } = createRequire(import.meta.url)('../../frontend/js/map-mode-transition.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
    const deps = {
        loadModel: vi.fn(async () => true), loadPhoto: vi.fn(async () => true),
        enterModel: vi.fn(async () => true), enterPhoto: vi.fn(async () => true),
        leaveModel: vi.fn(), leavePhoto: vi.fn(), onChange: vi.fn(), onError: vi.fn(), ...overrides
    };
    return { deps, controller: createController(deps) };
}
it('cancels cold model entry before the library arrives', async () => {
    const wait = deferred();
    const { deps, controller } = fixture({ loadModel: () => wait.promise });
    const entering = controller.request('model');
    expect(controller.getState()).toEqual({ desired: 'model', pending: true });
    await controller.request('2d'); wait.resolve(true);
    expect(await entering).toBe(false);
    expect(deps.enterModel).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ desired: '2d', pending: false });
});
it('cancels photo during scene construction and library loading', async () => {
    for (const waitAt of ['enterModel', 'loadPhoto']) {
        const wait = deferred();
        const { deps, controller } = fixture({ [waitAt]: () => wait.promise });
        const entering = controller.request('photo');
        await Promise.resolve(); await Promise.resolve();
        await controller.request('2d'); wait.resolve(true);
        expect(await entering).toBe(false);
        expect(deps.enterPhoto).not.toHaveBeenCalled();
        expect(deps.leavePhoto).toHaveBeenLastCalledWith({ destination: '2d' });
    }
});
it('aborts the ticket held by in-progress photo activation', async () => {
    const wait = deferred();
    const { deps, controller } = fixture({ enterPhoto: vi.fn(() => wait.promise) });
    const entering = controller.request('photo');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const ticket = deps.enterPhoto.mock.calls[0][0].modeRequest;
    expect(ticket.isCurrent()).toBe(true);
    await controller.request('model');
    expect(ticket.signal.aborted).toBe(true); expect(ticket.isCurrent()).toBe(false);
    wait.resolve(true); expect(await entering).toBe(false);
    expect(controller.getState()).toEqual({ desired: 'model', pending: false });
});
it('shares repeated entry and only loads photo dependencies for photo', async () => {
    const wait = deferred();
    const { deps, controller } = fixture({ loadModel: () => wait.promise });
    const first = controller.request('model'); expect(controller.request('model')).toBe(first);
    wait.resolve(true); expect(await first).toBe(true);
    expect(deps.enterModel).toHaveBeenCalledTimes(1); expect(deps.loadPhoto).not.toHaveBeenCalled();
    await controller.request('photo', { focusProposalIds: ['p1'] });
    expect(deps.loadPhoto).toHaveBeenCalledTimes(1);
    expect(deps.enterPhoto.mock.calls[0][0].focusProposalIds).toEqual(['p1']);
});
it('restores 2D after dependency failure and permits retry', async () => {
    const { deps, controller } = fixture(); deps.loadModel.mockResolvedValueOnce(false);
    expect(await controller.request('model')).toBe(false);
    expect(controller.getState()).toEqual({ desired: '2d', pending: false });
    expect(await controller.request('model')).toBe(true);
});
