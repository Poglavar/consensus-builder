import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const model = require('../../frontend/js/ui/activity-panel-model.js');

const events = [
    { id: 'old', source: 'live', actor: { kind: 'human', id: 'a', name: 'Mira' }, cityId: 'london', occurredAt: '2026-10-01T10:00:00Z', message: 'older' },
    { id: 'simulation', source: 'simulation', actor: { kind: 'agent', id: 'b', name: 'Bot' }, location: { cityId: 'tbilisi' }, occurredAt: '2026-10-03T10:00:00Z', message: 'newest simulation' },
    { id: 'no-city', source: 'live', actor: { kind: 'system', id: 'c' }, occurredAt: '2026-10-04T10:00:00Z', message: 'newest' },
    { id: 'new', source: 'live', actor: { kind: 'agent', id: 'a', name: 'Mira' }, cityId: 'london', occurredAt: '2026-10-02T10:00:00Z', message: 'newer' }
];

describe('Activity panel model', () => {
    it('creates immutable page-session defaults and preserves ordinary state on open', () => {
        const initial = model.createState();
        expect(initial).toEqual({
            view: 'events',
            filter: { source: 'live', cityScope: 'all', kind: 'all', controller: 'all', action: 'all', status: 'all', actorId: '', agreementCid: '', runId: '', query: '' },
            snapshot: null
        });
        expect(Object.isFrozen(initial)).toBe(true);
        expect(Object.isFrozen(initial.filter)).toBe(true);
        const configured = model.setFilter(model.setView(initial, 'actors'), 'query', 'Mira');
        expect(model.open(configured)).toEqual(configured);
        expect(model.open(configured, { view: 'watched' })).toMatchObject({ view: 'watched', filter: configured.filter });
        expect(model.open(initial, { view: 'actors' }).view).toBe('actors');
        expect(model.open(configured, { filter: { cityScope: 'current', controller: 'llm' } }).filter).toMatchObject({ query: 'Mira', cityScope: 'current', controller: 'llm' });
    });

    it('opens actor/run scopes in actors view and agreement scopes in events view, then restores ordinary state', () => {
        const ordinary = model.setFilter(model.setView(model.createState(), 'actors'), 'query', 'Mira');
        const actorScope = model.open(ordinary, { filter: { actorId: 'actor-9' } });
        expect(actorScope.view).toBe('actors');
        expect(actorScope.filter).toMatchObject({ source: 'combined', cityScope: 'all', actorId: 'actor-9', query: '' });
        expect(actorScope.snapshot).toEqual({ view: 'actors', filter: ordinary.filter });
        expect(model.clearScope(actorScope)).toEqual(ordinary);

        const runScope = model.open(ordinary, { filter: { runId: 'run-9' } });
        expect(runScope.view).toBe('actors');
        expect(runScope.filter.runId).toBe('run-9');
        const conflicting = model.open(ordinary, { filter: { runId: 'run-9', actorId: 'actor-9' } });
        expect(conflicting.filter).toMatchObject({ runId: 'run-9', actorId: '', agreementCid: '' });
        const agreementScope = model.open(ordinary, { filter: { agreementCid: 'bafy-agreement' } });
        expect(agreementScope.view).toBe('events');
        expect(agreementScope.filter).toMatchObject({ source: 'combined', agreementCid: 'bafy-agreement', query: '' });
    });

    it('keeps one ordinary snapshot across scope changes and clearFilters preserves scope', () => {
        const ordinary = model.setFilter(model.createState(), 'kind', 'agent');
        const scoped = model.open(ordinary, { filter: { actorId: 'a1' } });
        const customized = model.setFilter(model.setFilter(scoped, 'query', 'pledge'), 'kind', 'human');
        const cleared = model.clearFilters(customized);
        expect(cleared.filter).toMatchObject({ source: 'combined', actorId: 'a1', cityScope: 'all', kind: 'all', query: '' });
        expect(cleared.snapshot).toEqual(scoped.snapshot);
        expect(model.clearScope(cleared)).toEqual(ordinary);
    });

    it('filters newest first without truncation and applies source, kind, text, activity, and city predicates', () => {
        const many = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, source: 'live', actor: { kind: 'agent' }, occurredAt: new Date(i * 1000).toISOString() }));
        expect(model.filter(many, { source: 'live' })).toHaveLength(20);
        expect(model.filter(events).map(event => event.id)).toEqual(['no-city', 'new', 'old']);
        expect(model.filter(events, { source: 'simulation', kind: 'agent' }).map(event => event.id)).toEqual(['simulation']);
        expect(model.filter(events, { source: 'combined', kind: 'all', query: 'MIRA' }).map(event => event.id)).toEqual(['new', 'old']);
        expect(model.filter(events, { source: 'combined' }, { matchesActivity: (_event, filters) => filters.actorId === 'a' ? _event.actor.id === 'a' : true }).map(event => event.id)).toHaveLength(4);
        expect(model.filter(events, { source: 'combined', actorId: 'a' }, { matchesActivity: (event, filters) => !filters.actorId || event.actor.id === filters.actorId }).map(event => event.id)).toEqual(['new', 'old']);
        expect(model.filter(events, { source: 'combined', cityScope: 'current' }, { currentCity: 'London', normalizeCity: city => String(city).toLowerCase() }).map(event => event.id)).toEqual(['new', 'old']);
        expect(model.filter(events, { source: 'combined' }).map(event => event.id)).toEqual(['no-city', 'simulation', 'new', 'old']);
        // The shared matcher owns query semantics when present; do not narrow its result a second time.
        expect(model.filter(events, { source: 'live', query: 'a term the local matcher cannot find' }, { matchesActivity: () => true }).map(event => event.id)).toHaveLength(4);
    });

    it('counts active filters independently of defaults', () => {
        expect(model.activeFilterCount(model.createState().filter)).toBe(0);
        const filter = { ...model.createState().filter, source: 'combined', kind: 'agent', controller: 'algorithm', action: 'stake', status: 'failed', query: 'roof', actorId: 'a' };
        expect(model.activeFilterCount(filter)).toBe(6);
    });
});
