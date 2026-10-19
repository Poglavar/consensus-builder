// BusyControl (frontend/js/ui/busy-control.js): a control stays busy exactly while the work its
// click started is pending, across overlapping work, failures and synchronous throws.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BusyControl = require('../../frontend/js/ui/busy-control.js');

function fakeControl() {
    const classes = new Set();
    const attrs = new Map();
    return {
        classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) },
        setAttribute: (name, value) => attrs.set(name, String(value)),
        removeAttribute: name => attrs.delete(name),
        getAttribute: name => (attrs.has(name) ? attrs.get(name) : null)
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const busy = control => [control.classList.contains('cb-busy'), control.getAttribute('aria-busy')];

describe('BusyControl.track', () => {
    it('marks the control busy until the work resolves, and passes its result through', async () => {
        const control = fakeControl();
        const work = deferred();
        const tracked = BusyControl.track(control, work.promise);
        expect(busy(control)).toEqual([true, 'true']);
        work.resolve('globe');
        await expect(tracked).resolves.toBe('globe');
        expect(busy(control)).toEqual([false, null]);
    });

    it('clears after a failure and still rejects', async () => {
        const control = fakeControl();
        const work = deferred();
        const tracked = BusyControl.track(control, work.promise);
        work.reject(new Error('globe failed'));
        await expect(tracked).rejects.toThrow('globe failed');
        expect(busy(control)).toEqual([false, null]);
    });

    it('keeps the control busy until the last overlapping piece of work settles', async () => {
        const control = fakeControl();
        const first = deferred();
        const second = deferred();
        const a = BusyControl.track(control, first.promise);
        const b = BusyControl.track(control, second.promise);
        first.resolve();
        await a;
        expect(BusyControl.isBusy(control)).toBe(true);
        second.resolve();
        await b;
        expect(BusyControl.isBusy(control)).toBe(false);
        expect(busy(control)).toEqual([false, null]);
    });

    it('turns a synchronous throw from a work function into a rejection that clears the control', async () => {
        const control = fakeControl();
        const tracked = BusyControl.track(control, () => { throw new Error('not loaded'); });
        await expect(tracked).rejects.toThrow('not loaded');
        expect(busy(control)).toEqual([false, null]);
    });
});
