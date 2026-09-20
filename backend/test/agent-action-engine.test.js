import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const engineApi = require('../../frontend/js/agent-action-engine.js');

describe('unified agent action engine', () => {
    it('runs algorithmic and LLM actors through the same handler and activity schema', async () => {
        const activities = [];
        const handler = vi.fn((_actor, action) => ({ ok: true, message: `did ${action.type}` }));
        const engine = engineApi.createEngine({
            decisionProviders: {
                algorithm: () => ({ type: 'donate', proposalId: 'p1', amount: 2 }),
                llm: async () => ({ type: 'pledge', proposalId: 'p2', amount: 5 })
            },
            actionHandlers: { '*': handler },
            onActivity: event => activities.push(event)
        });

        await engine.run({ id: 'a1', name: 'Alex', controller: 'algorithm' });
        await engine.run({ id: 'a2', name: 'Mira', controller: 'llm' }, { source: 'live' });

        expect(handler).toHaveBeenCalledTimes(2);
        expect(activities[0]).toMatchObject({ source: 'simulation', actor: { kind: 'agent', controller: 'algorithm' }, action: { type: 'donate' }, entity: { type: 'proposal', id: 'p1' } });
        expect(activities[1]).toMatchObject({ source: 'live', actor: { kind: 'agent', controller: 'llm' }, action: { type: 'pledge' }, entity: { type: 'proposal', id: 'p2' } });
    });

    it('normalizes humans without exposing a different action shape', () => {
        expect(engineApi.normalizeActor({ id: 'u1', name: 'Dana', userControlled: true })).toMatchObject({
            id: 'u1', name: 'Dana', kind: 'human', controller: 'human'
        });
        expect(engineApi.matchesActivity({ source: 'live', actor: { kind: 'human' } }, 'human')).toBe(true);
    });

    it('does not label HTTP failures as successful activity', () => {
        const event = engineApi.createActivityEvent({
            actor: { id: 'a1', name: 'Alex', controller: 'llm' },
            action: { type: 'publish', proposalId: 'p1' },
            outcome: { status: 400 }
        });
        expect(event).toMatchObject({ ok: false, message: 'Alex published proposal p1 through x402.' });
    });

    it('runs human, algorithmic and LLM controllers through the same handler contract', async () => {
        const handled = [];
        const engine = engineApi.createEngine({
            decisionProviders: {
                human: (_actor, context) => context.action,
                algorithm: (_actor, context) => context.action,
                llm: (_actor, context) => context.action
            },
            actionHandlers: { '*': (actor, action) => { handled.push([actor.id, action.type]); return { ok: true }; } }
        });
        for (const controller of ['human', 'algorithm', 'llm']) {
            const result = await engine.run({ id: controller, controller }, { action: { type: 'pledge', proposalId: 'p1' } });
            expect(result.activity).toMatchObject({ actor: { controller }, action: { type: 'pledge' }, entity: { id: 'p1' } });
        }
        expect(handled).toEqual([['human', 'pledge'], ['algorithm', 'pledge'], ['llm', 'pledge']]);
    });

    it('combines source, controller, action, result and search filters', () => {
        const event = engineApi.createActivityEvent({
            actor: { id: 'wallet-1', name: 'Densifier', controller: 'llm', wallet: 'wallet-1' },
            action: { type: 'stake', proposalId: 'proposal-42' }, outcome: { ok: true, transaction: 'tx-1' }, source: 'live'
        });
        expect(engineApi.matchesActivity(event, { source: 'live', actor: 'llm', action: 'stake', status: 'success', query: 'proposal-42' })).toBe(true);
        expect(engineApi.matchesActivity(event, { source: 'simulation' })).toBe(false);
        expect(engineApi.matchesActivity(event, { actor: 'algorithm' })).toBe(false);
        expect(engineApi.matchesActivity(event, { status: 'failed' })).toBe(false);
        expect(engineApi.matchesActivity(event, 'llm')).toBe(true);
    });
});
