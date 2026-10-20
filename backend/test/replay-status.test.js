// Non-modal replay progress for a shared-plan link (frontend/js/proposals/replay-status.js), the
// user-takeover check that keeps the link from moving a map the user is already using, and the
// waiting line a user's own mutation shows while the boot replay is still running.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ReplayStatus = require('../../frontend/js/proposals/replay-status.js');
const { ProposalManager } = require('../../frontend/js/proposal-manager.js');

const interpolate = (fallback, params = {}) => fallback.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? ''));
const tShare = (_key, fallback, params) => interpolate(fallback, params);

const saved = new Map();
function installGlobal(name, value) {
    if (!saved.has(name)) saved.set(name, { existed: Object.prototype.hasOwnProperty.call(globalThis, name), value: globalThis[name] });
    globalThis[name] = value;
}
afterEach(() => {
    for (const [name, prior] of saved) {
        if (prior.existed) globalThis[name] = prior.value;
        else delete globalThis[name];
    }
    saved.clear();
});

function fakeTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
        fire(type, event) { listeners.get(type)?.(event); }
    };
}

describe('replay status line', () => {
    it('counts members while they replay and says "rebuilding" for the other phases', () => {
        expect(ReplayStatus.replayStatusText({ phase: 'proposal-apply', done: 132, total: 163 }, tShare))
            .toBe('Rebuilding the applied composition 132/163…');
        expect(ReplayStatus.replayStatusText({ phase: 'ground-check' }, tShare)).toBe('Rebuilding the applied composition…');
        expect(ReplayStatus.replayStatusText(null, tShare)).toBeNull();
    });

    it('reports each distinct line once', () => {
        const report = vi.fn();
        const onProgress = ReplayStatus.statusReporter(tShare, report);
        onProgress({ phase: 'ground-check' });
        onProgress({ phase: 'rebuild-reset' });
        onProgress({ phase: 'proposal-apply', done: 1, total: 2 });
        onProgress({ phase: 'proposal-apply', done: 1, total: 2 });
        onProgress({ phase: 'proposal-apply', done: 2, total: 2 });
        expect(report.mock.calls.map(call => call[0])).toEqual([
            'Rebuilding the applied composition…',
            'Rebuilding the applied composition 1/2…',
            'Rebuilding the applied composition 2/2…'
        ]);
    });

    it.each(['en', 'es', 'hr', 'sr'])('%s has the status lines and the waiting line', locale => {
        const dict = JSON.parse(readFileSync(new URL(`../../frontend/i18n/${locale}.json`, import.meta.url), 'utf8'));
        const plan = dict.modal.roadWidth.share.plan;
        expect(plan.rebuildingStatus).toBeTruthy();
        expect(plan.rebuildingStatusCount).toContain('{{done}}/{{total}}');
        expect(dict.proposalApplyStatus.waitingForReplay).toBeTruthy();
    });
});

describe('user takeover while the link waits', () => {
    it('real input marks the takeover; synthetic input does not', () => {
        const target = fakeTarget();
        const watch = ReplayStatus.watchUserTakeover(target);
        target.fire('pointerdown', { isTrusted: false });
        expect(watch.tookOver()).toBe(false);
        target.fire('wheel', { isTrusted: true });
        expect(watch.tookOver()).toBe(true);
    });

    it('stops listening once the wait is over, and keeps its answer', () => {
        const target = fakeTarget();
        const watch = ReplayStatus.watchUserTakeover(target);
        expect(Array.from(target.listeners.keys()).sort()).toEqual(['keydown', 'pointerdown', 'touchstart', 'wheel']);
        watch.stop();
        expect(target.listeners.size).toBe(0);
        expect(watch.tookOver()).toBe(false);
    });
});

describe('a user mutation queued behind the boot replay', () => {
    it('says it is waiting for the applied composition, and system mutations stay silent', async () => {
        const updateStatus = vi.fn();
        installGlobal('updateStatus', updateStatus);
        const manager = { ...ProposalManager, _reapplyInFlight: true, _lastApplyFailureByProposalId: new Map() };
        const noStorage = { _mapMutation: false };

        await manager.runParcelMutation('cadastral-ground-arrived', null, async () => true, noStorage);
        expect(updateStatus).not.toHaveBeenCalled();

        await manager.runParcelMutation('apply', 'p1', async () => true, noStorage);
        expect(updateStatus).toHaveBeenCalledWith('Waiting for the applied composition to finish rebuilding…');

        updateStatus.mockClear();
        manager._reapplyInFlight = false;
        await manager.runParcelMutation('apply', 'p1', async () => true, noStorage);
        expect(updateStatus).not.toHaveBeenCalled();
    });
});
