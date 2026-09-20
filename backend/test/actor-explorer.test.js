// Headless tests for the data model that lets human, algorithmic and LLM activity share one UI.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { backendBase, buildActorProfiles, eventDetail, filterEvents, runCostTotal } = require('../../frontend/js/actor-explorer.js');

const events = [
    { id: 'human-pledge', actor: { id: 'person-1', name: 'Dana', kind: 'human', controller: 'human' }, action: { type: 'pledge' }, entity: { type: 'proposal', id: 'p1' }, transaction: 'human-tx', recordedAt: '2026-09-20T10:00:00Z' },
    { id: 'algo-donation', actor: { id: 'algorithm-1', name: 'Block matcher', kind: 'agent', controller: 'algorithm' }, action: { type: 'donate' }, entity: { type: 'proposal', id: 'p1' }, recordedAt: '2026-09-20T10:01:00Z' },
    { id: 'llm-create', actor: { id: 'llm-1', name: 'Densifier', kind: 'agent', controller: 'llm', wallet: 'wallet-1' }, action: { type: 'create' }, entity: { type: 'proposal', id: 'p2' }, runId: 'run-1', model: 'model-x', batchId: 'batch-1', modelCostUsd: 0.0054, rationale: 'The parcel is underused.', transaction: 'mint-tx', recordedAt: '2026-09-20T10:02:00Z' },
    { id: 'llm-stake', actor: { id: 'llm-1', name: 'Densifier', kind: 'agent', controller: 'llm', wallet: 'wallet-1' }, action: { type: 'stake' }, entity: { type: 'proposal', id: 'p2' }, runId: 'run-1', model: 'model-x', batchId: 'batch-1', modelCostUsd: 0.0054, transaction: 'stake-tx', recordedAt: '2026-09-20T10:03:00Z' }
];

describe('actor explorer view model', () => {
    it('profiles humans, algorithms and LLMs with the same activity representation', () => {
        const profiles = buildActorProfiles(events);
        expect(profiles.map(profile => profile.actor.controller).sort()).toEqual(['algorithm', 'human', 'llm']);
        const llm = profiles.find(profile => profile.actor.controller === 'llm');
        expect(llm).toMatchObject({ activityCount: 2, proposalIds: ['p2'], transactionCount: 2, modelCostUsd: 0.0054 });
    });

    it('filters across shared fields without hiding the non-LLM actor types', () => {
        expect(filterEvents(events, { controller: 'human' }).map(event => event.id)).toEqual(['human-pledge']);
        expect(filterEvents(events, { query: 'mint-tx' }).map(event => event.id)).toEqual(['llm-create']);
        expect(filterEvents(events, { query: 'p1' }).map(event => event.id).sort()).toEqual(['algo-donation', 'human-pledge']);
    });

    it('exposes rationale, cost/run and transaction provenance in event details', () => {
        expect(eventDetail(events[2])).toMatchObject({ action: 'Created', rationale: 'The parcel is underused.', runId: 'run-1', modelCostUsd: 0.0054, transaction: 'mint-tx' });
        expect(runCostTotal({ costs: [{ usd: 0.0054 }, { usd: '0.001' }] })).toBeCloseTo(0.0064);
    });

    it('uses the public API host when the standalone explorer has no app runtime', () => {
        expect(backendBase()).toBe('https://api.urbangametheory.xyz');
    });
});
