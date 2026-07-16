import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const transactions = require('../../frontend/js/proposals/apply/transaction.js');

describe('proposal mutation transaction', () => {
    it('commits deferred persistence only after a successful operation', async () => {
        const events = [];
        const result = await transactions.enqueue({ kind: 'apply', proposalId: 'p-1' }, async tx => {
            tx.deferRollback('undo', () => events.push('rollback'));
            tx.deferCommit('persist', () => events.push('commit'));
            tx.deferFinally('close', () => events.push('finally'));
            events.push('operation');
            return 'ok';
        });

        expect(result).toBe('ok');
        expect(events).toEqual(['operation', 'commit', 'finally']);
    });

    it('rolls back in reverse order when an operation returns false', async () => {
        const events = [];
        const result = await transactions.enqueue({ kind: 'apply', proposalId: 'p-2' }, async tx => {
            tx.deferRollback('first', () => events.push('first'));
            tx.deferRollback('second', () => events.push('second'));
            tx.deferCommit('never', () => events.push('commit'));
            return false;
        });

        expect(result).toBe(false);
        expect(events).toEqual(['second', 'first']);
    });

    it('rolls back thrown failures and reports compensation failures without hiding the cause', async () => {
        const cause = new Error('render failed');
        let restored = false;

        await expect(transactions.enqueue({ kind: 'unapply', proposalId: 'p-3' }, async tx => {
            tx.deferRollback('restore state', () => { restored = true; });
            tx.deferRollback('broken cleanup', () => { throw new Error('cleanup failed'); });
            throw cause;
        })).rejects.toBe(cause);

        expect(restored).toBe(true);
        expect(cause.rollbackErrors).toHaveLength(1);
        expect(cause.rollbackErrors[0].label).toBe('broken cleanup');
    });

    it('serializes independent root mutations', async () => {
        const events = [];
        let releaseFirst;
        const gate = new Promise(resolve => { releaseFirst = resolve; });

        const first = transactions.enqueue({ proposalId: 'first' }, async () => {
            events.push('first:start');
            await gate;
            events.push('first:end');
            return true;
        });
        const second = transactions.enqueue({ proposalId: 'second' }, async () => {
            events.push('second:start');
            return true;
        });

        await new Promise(resolve => setTimeout(resolve, 0));
        expect(events).toEqual(['first:start']);
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });
});

describe('transaction snapshots', () => {
    it('restores a record map in place and removes records created after the snapshot', () => {
        const original = { proposalId: 'p-1', applied: false, nested: { value: 1 } };
        const records = new Map([['p-1', original]]);
        const snapshot = transactions.snapshotRecordMap(records);

        original.applied = true;
        original.nested.value = 2;
        records.set('p-2', { proposalId: 'p-2', applied: true });

        expect(transactions.restoreRecordMap(records, snapshot)).toBe(true);
        expect(records.get('p-1')).toBe(original);
        expect(original).toEqual({ proposalId: 'p-1', applied: false, nested: { value: 1 } });
        expect(records.has('p-2')).toBe(false);
    });

    it('restores the parcel index and visible layer membership', () => {
        const parent = { id: 'parent' };
        const child = { id: 'child' };
        const extra = { id: 'extra' };
        const layers = [parent];
        const group = {
            getLayers: () => layers.slice(),
            hasLayer: layer => layers.includes(layer),
            addLayer: layer => { if (!layers.includes(layer)) layers.push(layer); },
            removeLayer: layer => {
                const index = layers.indexOf(layer);
                if (index >= 0) layers.splice(index, 1);
            }
        };
        const browserRoot = {
            parcelLayer: group,
            parcelLayerById: new Map([['parent', parent], ['child', child]])
        };
        const snapshot = transactions.snapshotParcelPresentation(browserRoot);

        group.removeLayer(parent);
        group.addLayer(extra);
        browserRoot.parcelLayerById.delete('parent');
        browserRoot.parcelLayerById.set('extra', extra);

        expect(transactions.restoreParcelPresentation(browserRoot, snapshot)).toBe(true);
        expect(layers).toEqual([parent]);
        expect(Array.from(browserRoot.parcelLayerById.entries())).toEqual([
            ['parent', parent],
            ['child', child]
        ]);
    });
});
