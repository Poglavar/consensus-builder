import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { prepare, TYPES, locationOf } = require('../../frontend/js/world/activity-model.js');
const event = (id, type = 'create', occurredAt = '2026-10-01T12:00:00Z', extra = {}) => ({ id, source: 'live', ok: true, action: { type, proposalId: 'proposal-42' }, occurredAt, ...extra });
describe('world recent activity', () => {
    it('shows only successful, linkable, dated public milestones', () => {
        const rows = [event('good'), event('fail', 'resolve', undefined, { ok: false }), event('sim', 'create', undefined, { source: 'simulation' }), event('noise', 'run_status'), event('bad-date', 'execute', 'garbage'), event('no-proposal', 'accept', undefined, { action: { type: 'accept' } })];
        expect(prepare(rows).map(e => e.id)).toEqual(['good']);
    });
    it('orders newest first, removes repeated IDs and caps the list', () => {
        const old = event('old'); const fresh = event('new', 'resolve', '2026-10-02T12:00:00Z');
        expect(prepare([old, fresh, fresh], 1).map(e => e.id)).toEqual(['new']);
        expect(prepare(Array.from({ length: 40 }, (_, i) => event(String(i))), 100)).toHaveLength(30);
        expect(prepare(null)).toEqual([]);
    });
    it('preserves the proposal and city scope without injected URL parameters', () => {
        const row = event('x', 'execute', undefined, { action: { type: 'execute', proposalId: 'abc&world=1' }, cityId: 'new_york', proposalName: '<script>title</script>' });
        const prepared = prepare([row])[0]; const url = new URL(prepared.href, 'https://example.com');
        expect(url.searchParams.get('focusProposal')).toBe('abc&world=1');
        expect(url.searchParams.get('city')).toBe('new_york');
        expect(url.searchParams.has('world')).toBe(false);
        expect(prepared.subject).toBe('<script>title</script>');
    });
    it('labels known cities precisely and distinguishes approximate countries and nearby cities', () => {
        const city = id => id === 'zagreb' ? { name: 'Zagreb', lat: 45.8, lon: 16 } : null;
        const coverage = { nameAt: () => ({ kind: 'country', name: 'Croatia', cc: 'HR' }) };
        expect(locationOf({ cityId: 'zagreb', location: { lat: 45.8, lon: 16 } }, { city, coverage })).toEqual({ kind: 'city', name: 'Zagreb' });
        expect(locationOf({ cityId: 'zagreb', location: { lat: 44, lon: 16 } }, { city, coverage })).toEqual({ kind: 'country', name: 'Croatia', cc: 'HR' });
        expect(locationOf({ cityId: 'explore', location: { lat: 45.8, lon: 16 } }, { city, coverage: { nameAt: () => ({ kind: 'city', name: 'Zagreb' }) } })).toMatchObject({ kind: 'near', name: 'Zagreb' });
        expect(locationOf({ cityId: 'explore', location: null }, { city, coverage })).toEqual({ kind: 'unknown', name: '' });
        expect(prepare([event('bad', 'create', undefined, { location: { lat: null, lon: 16 } })])[0].location).toBeNull();
    });
    it('links every supported milestone including execution and market resolution', () => {
        for (const type of TYPES) expect(prepare([event(type, type)])[0]).toMatchObject({ type, proposalId: 'proposal-42' });
        expect(prepare([event('entity', 'claim', undefined, { action: { type: 'claim' }, entity: { type: 'proposal', id: 'entity-1' } })])[0].href).toContain('entity-1');
    });
});
