import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { filter, LIMIT, relabelControls, status } = require('../../frontend/js/ui/activity-feed-model.js');

const events = [
    { id: 'human-old', actor: { kind: 'human' }, occurredAt: '2026-10-01T10:00:00Z' },
    { id: 'agent-new', actor: { kind: 'agent' }, occurredAt: '2026-10-03T10:00:00Z' },
    { id: 'system-mid', actor: { kind: 'system' }, occurredAt: '2026-10-02T10:00:00Z' },
    { id: 'human-new', actor: { kind: 'human' }, occurredAt: '2026-10-04T10:00:00Z' }
];

describe('inline activity feed model', () => {
    it('shows newest first and filters people and agents by the shared actor kind', () => {
        expect(filter(events).map(event => event.id)).toEqual(['human-new', 'agent-new', 'system-mid', 'human-old']);
        expect(filter(events, 'people').map(event => event.id)).toEqual(['human-new', 'human-old']);
        expect(filter(events, 'agents').map(event => event.id)).toEqual(['agent-new']);
    });

    it('caps the feed at twelve rows even when the caller requests more', () => {
        const many = Array.from({ length: 20 }, (_, index) => ({
            id: String(index), actor: { kind: 'agent' }, occurredAt: new Date(index * 1000).toISOString()
        }));
        expect(LIMIT).toBe(12);
        expect(filter(many, 'all', 99)).toHaveLength(12);
        expect(filter(many, 'all', 99)[0].id).toBe('19');
    });

    it('keeps a source failure visible when the active filter has no matching events', () => {
        const available = [{ id: 'agent', actor: { kind: 'agent' } }];
        expect(status({ events: available, visible: [], failures: [{ source: 'live', error: 'HTTP 503' }] })).toBe('partial');
        expect(status({ events: [], visible: [], failures: [{ source: 'live', error: 'HTTP 503' }] })).toBe('error');
    });

    it('shows loading first, then empty or ready only when all sources succeeded', () => {
        expect(status({ loading: true, failures: [{ source: 'live' }] })).toBe('loading');
        expect(status({ events: [], visible: [], failures: [] })).toBe('empty');
        expect(status({ events: [events[0]], visible: [events[0]], failures: [] })).toBe('ready');
    });

    it('relabels the mounted controls when the language changes', () => {
        const attributes = {};
        const controls = { setAttribute: (name, value) => { attributes[name] = value; } };
        const buttons = new Map(['all', 'people', 'agents'].map(name => [name, { textContent: '' }]));
        const refresh = { textContent: '' };
        let language = 'en';
        const translate = (key, fallback) => language === 'en' ? fallback : ({
            'activityFeed.filters': 'Filtrar actividad', 'activityFeed.all': 'Todo',
            'activityFeed.people': 'Personas', 'activityFeed.agents': 'Agentes',
            'activityFeed.refresh': 'Actualizar'
        }[key] || fallback);

        relabelControls({ controls, buttons, refresh }, translate);
        expect(buttons.get('all').textContent).toBe('All');
        language = 'es';
        relabelControls({ controls, buttons, refresh }, translate);

        expect(attributes['aria-label']).toBe('Filtrar actividad');
        expect([...buttons.values()].map(button => button.textContent)).toEqual(['Todo', 'Personas', 'Agentes']);
        expect(refresh.textContent).toBe('Actualizar');
    });
});
