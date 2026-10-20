import { describe, expect, it } from 'vitest';
import {
    LIFECYCLE_STATUSES,
    canonicalizeLifecycleStatus,
    effectiveLifecycleStatus,
    resolveIncomingLifecycleStatus
} from '../proposals/lifecycle.js';

describe('proposal lifecycle contract', () => {
    it('canonicalizes every supported lifecycle case-insensitively', () => {
        expect(LIFECYCLE_STATUSES).toEqual(['Active', 'Executed', 'Cancelled', 'Expired', 'draft']);
        expect(['ACTIVE', 'executed', 'Cancelled', 'EXPIRED', 'Draft'].map(canonicalizeLifecycleStatus))
            .toEqual(LIFECYCLE_STATUSES);
    });

    it('rejects unknown explicit lifecycle values but accepts legacy application words', () => {
        expect(resolveIncomingLifecycleStatus({ lifecycleStatus: 'pending' })).toMatchObject({ ok: false });
        expect(resolveIncomingLifecycleStatus({ lifecycleStatus: 'applied' })).toMatchObject({ ok: false });
        expect(resolveIncomingLifecycleStatus({ status: 'Applied' })).toEqual({ ok: true, value: 'Active' });
        expect(resolveIncomingLifecycleStatus({})).toEqual({ ok: true, value: 'Active' });
    });

    it('projects stale active rows as expired without changing terminal states', () => {
        const now = new Date('2026-07-16T00:00:00Z');
        const past = '2026-07-15T00:00:00Z';
        expect(effectiveLifecycleStatus('Active', past, now)).toBe('Expired');
        expect(effectiveLifecycleStatus('Executed', past, now)).toBe('Executed');
        expect(effectiveLifecycleStatus('draft', past, now)).toBe('draft');
    });

    it.each([undefined, null, '', 'pending', 'Applied', 'Unknown'])(
        'does not infer an active or expired lifecycle from %s', value => {
            expect(effectiveLifecycleStatus(value, null)).toBe('Unknown');
            expect(effectiveLifecycleStatus(value, '2020-01-01T00:00:00Z')).toBe('Unknown');
        });

    it('keeps the read-only Unknown result out of authored creation', () => {
        expect(resolveIncomingLifecycleStatus({ lifecycleStatus: 'Unknown' })).toMatchObject({ ok: false });
        expect(effectiveLifecycleStatus(' Active ', '2099-01-01T00:00:00Z')).toBe('Active');
    });
});
