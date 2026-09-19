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
});
