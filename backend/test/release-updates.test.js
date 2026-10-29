import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readRelease, createChecker } = require('../../frontend/js/release-updates.js');
const release = (number = 12) => ({ version: 1, component: 'urbangametheory-frontend',
    buildId: `deploy-${number}`, buildNumber: String(number), generatedAt: '2026-10-27T12:00:00Z' });

describe('release checks', () => {
    it('reads the deployed manifest rather than hand-maintained release notes', () => {
        expect(readRelease(release())).toEqual({ buildId: 'deploy-12', buildNumber: 12, generatedAt: '2026-10-27T12:00:00Z' });
    });
    it.each([
        null, {}, { ...release(), component: 'another-app' }, { ...release(), version: 2 },
        { ...release(), buildId: '__BUILD_ID__' }, { ...release(), buildNumber: null },
        { ...release(1), buildNumber: true }, { ...release(), generatedAt: 1 },
        { ...release(), buildNumber: 1.5 }, { ...release(), generatedAt: 'unknown' }
    ])('rejects missing, development and invalid manifests: %j', value => {
        expect(() => readRelease(value)).toThrow();
    });
    it('compares against the running build without changing that identity', async () => {
        const running = release(), request = vi.fn().mockResolvedValueOnce(release()).mockResolvedValueOnce(release(13));
        const checker = createChecker({ running, request, now: () => 123 });
        expect(await checker.check()).toMatchObject({ status: 'current', available: false, checkedAt: 123 });
        expect(await checker.check()).toMatchObject({ status: 'available', available: true, latest: { buildNumber: 13 } });
        expect(running.buildNumber).toBe('12');
    });
    it('coalesces automatic and manual requests and allows retries after failure', async () => {
        let reject;
        const request = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(release(13));
        const checker = createChecker({ running: release(), request });
        const first = checker.check(), second = checker.check();
        expect(first).toBe(second);
        await Promise.resolve(); expect(request).toHaveBeenCalledTimes(1);
        expect(checker.snapshot().status).toBe('checking');
        reject(new Error('offline')); await first;
        expect(checker.snapshot()).toMatchObject({ status: 'error', available: false });
        expect(await checker.check()).toMatchObject({ status: 'available', available: true });
    });
    it('preserves a known update when the next response fails or goes backwards', async () => {
        const request = vi.fn().mockResolvedValueOnce(release(14)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(release(12));
        const checker = createChecker({ running: release(), request });
        await checker.check(); await checker.check();
        expect(checker.snapshot()).toMatchObject({ status: 'error', available: true, latest: { buildNumber: 14 } });
        await checker.check();
        expect(checker.snapshot()).toMatchObject({ status: 'error', available: true, latest: { buildNumber: 14 } });
    });
    it('never reports an older cached release as current', async () => {
        const checker = createChecker({ running: release(), request: () => release(11) });
        expect(await checker.check()).toMatchObject({ status: 'error', available: false });
    });
    it('does not poll a local development build', async () => {
        const request = vi.fn(), checker = createChecker({ running: { buildId: 'dev', buildNumber: 0 }, request });
        expect(await checker.check()).toMatchObject({ status: 'development' });
        expect(request).not.toHaveBeenCalled();
    });
});

describe('resume after an update reload', () => {
    const { resumeRecord, readResume, RESUME_MAX_AGE_MS } = require('../../frontend/js/release-updates.js');
    const selectedInstance = (stack, kind) => {
        const section = stack.sections.find(item => item.kind === kind);
        return section ? section.instances[section.selectedIndex] : null;
    };
    const section = (kind, ids, selectedIndex = 0) => ({ kind, instances: ids.map(id => ({ id })), selectedIndex });
    const stack = { selectedKind: 'designs', expanded: 'designs', sections: [
        section('plans', ['plan-1']), section('designs', ['d-1', 'd-2'], 1), section('formed', ['p#1']), section('parcels', ['HR-1'])] };
    const at = { now: 1_000, pathname: '/plans/abc' };

    it('records the selected instance of every point-located section, never plans', () => {
        const record = resumeRecord({ mode: '2d', pathname: at.pathname, stack, selectedInstance, point: { lat: 45.8, lng: 15.98 }, now: at.now });
        expect(record).toMatchObject({ version: 1, mode: '2d', point: [45.8, 15.98], selectedKind: 'designs', expanded: 'designs',
            selected: { designs: 'd-2', formed: 'p#1', parcels: 'HR-1' } });
        expect(readResume(JSON.stringify(record), at)).toEqual({ mode: '2d', point: [45.8, 15.98],
            selected: { designs: 'd-2', formed: 'p#1', parcels: 'HR-1' }, selectedKind: 'designs', expanded: 'designs' });
    });
    it('records nothing open for a closed stack or one showing a plan, agreement or multi-selection', () => {
        expect(resumeRecord({ mode: 'model', pathname: '/', stack: null, selectedInstance, point: null, now: 1 }).selected).toEqual({});
        expect(resumeRecord({ mode: '2d', pathname: '/', stack: { ...stack, selectedKind: 'plans', expanded: 'plans' },
            selectedInstance, point: { lat: 1, lng: 1 }, now: 1 })).toMatchObject({ selected: {}, selectedKind: null, expanded: null });
    });
    it('ignores a record from another page, an old session, a malformed one or an unknown kind', () => {
        const record = resumeRecord({ mode: 'model', pathname: at.pathname, stack, selectedInstance, point: null, now: at.now });
        const raw = JSON.stringify(record);
        expect(readResume(raw, { ...at, pathname: '/' })).toBeNull();
        expect(readResume(raw, { ...at, now: at.now + RESUME_MAX_AGE_MS + 1 })).toBeNull();
        expect(readResume('{', at)).toBeNull();
        expect(readResume(null, at)).toBeNull();
        expect(readResume(JSON.stringify({ ...record, selected: { plans: 'x', designs: 7 } }), at).selected).toEqual({});
        // A 2D selection has nothing to stand on without its point.
        expect(readResume(JSON.stringify({ ...record, mode: '2d' }), at)).toBeNull();
    });
});
