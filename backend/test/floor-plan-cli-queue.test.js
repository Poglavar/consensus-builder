// Headless regression checks for empty-queue suppression and parallel task selection.
import { describe, expect, it, vi } from 'vitest';
import { createCliTaskPicker } from '../floor-plans/cli-queue.js';

function fixture() {
    const stages = { images: { stage: 'images', processor: 'images' }, plans: { stage: 'plans', processor: 'plans' },
        buildings: { stage: 'buildings', processor: 'buildings' } };
    const claimed = new Set(), finished = new Set(), rows = { images: [], plans: [], buildings: [] };
    const db = { query: vi.fn(async (_sql, [name]) => ({ rows: rows[name] })) };
    const picker = createCliTaskPicker({ stages, order: ['images', 'plans', 'images', 'buildings'], claimed, finished });
    return { picker, db, rows, claimed, finished };
}

describe('CLI queue picker', () => {
    it('probes empty queues once and skips them on later selections', async () => {
        const { picker, db, rows } = fixture();
        rows.buildings = Array.from({ length: 8 }, (_, i) => ({ id: 'task-' + i }));
        for (let i = 0; i < 8; i++) expect((await picker.pick(db)).task.id).toBe('task-' + i);
        const calls = name => db.query.mock.calls.filter(([, params]) => params[0] === name).length;
        expect(calls('images')).toBe(1); expect(calls('plans')).toBe(1);
        expect(picker.emptyStages.sort()).toEqual(['images', 'plans']);
    });

    it('shares concurrent probes and gives four workers different tasks', async () => {
        const { picker, db, rows, claimed } = fixture();
        rows.buildings = Array.from({ length: 4 }, (_, i) => ({ id: 'task-' + i }));
        const picked = await Promise.all(Array.from({ length: 4 }, () => picker.pick(db)));
        expect(new Set(picked.map(job => job.task.id)).size).toBe(4);
        expect(claimed.size).toBe(4);
        for (const name of ['images', 'plans', 'buildings'])
            expect(db.query.mock.calls.filter(([, params]) => params[0] === name)).toHaveLength(1);
    });

    it('discovers newly unlocked plans after a discovery refresh', async () => {
        const { picker, db, rows } = fixture();
        expect(await picker.pick(db)).toBeNull();
        rows.plans = [{ id: 'new-plan' }];
        const count = db.query.mock.calls.length;
        expect(await picker.pick(db)).toBeNull(); expect(db.query).toHaveBeenCalledTimes(count);
        picker.refresh();
        expect(await picker.pick(db)).toEqual({ name: 'plans', task: rows.plans[0] });
    });

    it('does not treat busy or already finished rows as an empty stage', async () => {
        const { picker, rows, claimed, finished } = fixture();
        rows.buildings = [{ id: 'busy' }, { id: 'finished' }]; claimed.add('busy'); finished.add('finished');
        expect(await picker.pick({ query: async (_sql, [name]) => ({ rows: rows[name] }) })).toBeNull();
        expect(picker.emptyStages).not.toContain('buildings');
        claimed.delete('busy');
        expect((await picker.pick({ query: async (_sql, [name]) => ({ rows: rows[name] }) })).task.id).toBe('busy');
    });

    it('propagates query errors and retries the stage instead of parking it', async () => {
        const { picker, db, rows } = fixture();
        db.query.mockRejectedValueOnce(new Error('database unavailable'));
        await expect(picker.pick(db)).rejects.toThrow('database unavailable');
        expect(picker.emptyStages).not.toContain('images');
        rows.images = [{ id: 'image' }];
        expect((await picker.pick(db)).task.id).toBe('image');
    });
});
