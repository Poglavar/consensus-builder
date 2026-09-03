import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const transactionModule = require('../../frontend/js/proposals/apply/transaction.js');
const { ParcelMutation } = transactionModule;

describe('proposal mutation coordinator contract', () => {
    it('exposes one serializer and no legacy transaction or snapshot adapters', () => {
        expect(Object.keys(transactionModule)).toEqual(['ParcelMutation']);
        expect(Object.keys(ParcelMutation)).toEqual(['run']);
        expect(transactionModule.enqueue).toBeUndefined();
        expect(transactionModule.MutationTransaction).toBeUndefined();
        expect(transactionModule.snapshotRecordMap).toBeUndefined();
        expect(transactionModule.restoreRecordMap).toBeUndefined();
    });

    it('serializes independent root mutations', async () => {
        const events = [];
        let releaseFirst;
        const gate = new Promise(resolve => { releaseFirst = resolve; });
        const dependencies = {
            runtime: {}, proposalStore: null, agentStore: null, storage: null, fabric: null
        };

        const first = ParcelMutation.run({ proposalId: 'first' }, async () => {
            events.push('first:start');
            await gate;
            events.push('first:end');
            return true;
        }, dependencies);
        const second = ParcelMutation.run({ proposalId: 'second' }, async () => {
            events.push('second:start');
            return true;
        }, dependencies);

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['first:start']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('returns false without publishing or running after-commit work', async () => {
        let notified = false;
        const runtime = { parks: [] };
        const result = await ParcelMutation.run({ proposalId: 'refused' }, context => {
            context.collections.parks.push({ id: 'draft-only' });
            context.afterCommit(() => { notified = true; });
            return false;
        }, {
            runtime, proposalStore: null, agentStore: null, storage: null, fabric: null
        });

        expect(result).toBe(false);
        expect(runtime.parks).toEqual([]);
        expect(notified).toBe(false);
    });
});
