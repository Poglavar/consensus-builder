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

it('publishes 2D only after the previous view has restored the map', async () => {
    const events = [];
    const { controller } = fixture({
        leavePhoto: () => events.push('photo-left'),
        leaveModel: () => events.push('map-restored'),
        onChange: state => { if (state.desired === '2d') events.push('frame-editor'); }
    });
    await controller.request('model');
    events.length = 0;
    await controller.request('2d');
    expect(events).toEqual(['photo-left', 'map-restored', 'frame-editor']);
});
it('reports a failed entry once, after the view has been torn back to 2D', async () => {
    const order = [];
    const { deps, controller } = fixture({
        enterModel: vi.fn(async () => { throw new Error('WebGL context lost'); }),
        leaveModel: vi.fn(() => order.push('leave')),
        onError: vi.fn((error, mode) => order.push(`error:${mode}:${error.message}`))
    });
    expect(await controller.request('photo')).toBe(false);
    expect(controller.getState()).toEqual({ desired: '2d', pending: false });
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe('error:photo:WebGL context lost');
    expect(order.indexOf('leave')).toBeLessThan(order.length - 1);
});
it('does not report a superseded entry that fails after the user moved on', async () => {
    const gate = deferred();
    const { deps, controller } = fixture({ enterModel: vi.fn(async () => { await gate.promise; throw new Error('late'); }) });
    const first = controller.request('model');
    await controller.request('2d');
    gate.resolve();
    expect(await first).toBe(false);
    expect(deps.onError).not.toHaveBeenCalled();
});
