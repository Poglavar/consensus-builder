import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { evaluate, wait } = require('../../frontend/js/three-scene-readiness.js');

const readyState = overrides => ({
    active: true,
    transitioning: false,
    requireExisting: true,
    existingVisible: true,
    fetching: false,
    outcome: 'loaded',
    existingBuilt: true,
    existingDataCurrent: true,
    existingBuildFailures: 0,
    existingBuildings: 4,
    building: false,
    incomplete: false,
    dirty: false,
    pendingModels: 0,
    frameCurrent: true,
    ...overrides
});

afterEach(() => vi.useRealTimers());

describe('3D scene readiness', () => {
    it.each([
        ['loaded source data', { outcome: 'loaded', existingBuildings: 4 }],
        ['a successful empty source', { outcome: 'empty', existingBuildings: 0 }]
    ])('accepts %s only after the scene and frame are complete', (_label, overrides) => {
        expect(evaluate(readyState(overrides))).toMatchObject({ ready: true, failed: false });
    });

    it.each(['failed', 'partial', 'unsupported'])('treats terminal %s source data as a failed readiness result', outcome => {
        const result = evaluate(readyState({ outcome }));
        expect(result.ready).toBe(false);
        expect(result.failed).toBe(true);
        expect(result.reasons).toContain(`existing-${outcome}`);
    });

    it.each([
        ['delayed mesh build', { existingBuilt: false }, 'existing-not-built'],
        ['missing render frame', { frameCurrent: false }, 'frame-pending'],
        ['stale source revision', { existingDataCurrent: false }, 'existing-not-built']
    ])('blocks a capture for %s', (_label, overrides, reason) => {
        const result = evaluate(readyState(overrides));
        expect(result.ready).toBe(false);
        expect(result.reasons).toContain(reason);
    });

    it('blocks when existing buildings are hidden by default, but permits an explicit opt out', () => {
        expect(evaluate(readyState({ existingVisible: false })).reasons).toContain('existing-hidden');
        expect(evaluate(readyState({ existingVisible: false, requireExisting: false }))).toMatchObject({ ready: true });
    });

    it('waits for pending building models even when source and frame are ready', () => {
        expect(evaluate(readyState({ pendingModels: 1 })).reasons).toContain('models-loading');
    });

    it('polls until readiness transitions to complete', async () => {
        vi.useFakeTimers();
        let state = evaluate(readyState({ frameCurrent: false }));
        const pending = wait(() => state, { timeoutMs: 1000 });
        vi.advanceTimersByTime(50);
        state = evaluate(readyState());
        await vi.advanceTimersByTimeAsync(50);
        await expect(pending).resolves.toMatchObject({ ready: true });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects on timeout and cleans up its polling timer', async () => {
        vi.useFakeTimers();
        const pending = wait(() => evaluate(readyState({ frameCurrent: false })), { timeoutMs: 100 });
        const rejection = expect(pending).rejects.toMatchObject({ code: 'scene-ready-timeout' });
        await vi.advanceTimersByTimeAsync(100);
        await rejection;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects on abort and removes its timer and abort listener', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        const pending = wait(() => evaluate(readyState({ frameCurrent: false })), { signal: controller.signal });
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await rejection;
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects terminal source failure immediately and cleans up without polling', async () => {
        vi.useFakeTimers();
        const pending = wait(() => evaluate(readyState({ outcome: 'failed' })));
        await expect(pending).rejects.toMatchObject({ code: 'scene-load-failed' });
        expect(vi.getTimerCount()).toBe(0);
    });
});
