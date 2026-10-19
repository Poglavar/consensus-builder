// Verify retention checkpoints stop on exhaustion or read errors without repeating completed work.
import { describe, expect, it, vi } from 'vitest';
import { runRetentionCli } from '../scripts/floor-plan-retention.mjs';

const result = (values = {}) => ({ apply: true, htmlSources: 0, htmlBlobs: 0, htmlBytes: 0,
    envelopeSources: 0, envelopeBlobs: 0, envelopeBytes: 0, protectedEnvelopeSources: 2,
    sourceReadErrors: 0, retainedPendingPlans: 3, retainedPendingEnvelopes: 2,
    filesDeleted: 0, bytesDeleted: 0, deferred: 0, ...values });
const harness = compact => {
    const client = { connect: vi.fn(), end: vi.fn() };
    return { client, options: { clientFactory: () => client, compact, output: vi.fn(), log: vi.fn() } };
};

describe('retention CLI', () => {
    it('keeps the default audit read-only and runs it once', async () => {
        const compact = vi.fn().mockResolvedValue(result({ apply: false, htmlBlobs: 12 }));
        const { client, options } = harness(compact);
        expect(await runRetentionCli([], options)).toBe(0);
        expect(compact).toHaveBeenCalledExactlyOnceWith(client, { apply: false, limit: 50000, log: options.log });
        expect(options.output).toHaveBeenCalledWith(expect.objectContaining({ apply: false, htmlBlobs: 12 }));
        expect(client.end).toHaveBeenCalledOnce();
    });

    it('requires apply for repeated batches', async () => {
        const compact = vi.fn(), { client, options } = harness(compact);
        await expect(runRetentionCli(['--until-complete'], options)).rejects.toThrow('requires --apply');
        expect(client.connect).not.toHaveBeenCalled();
        expect(compact).not.toHaveBeenCalled();
    });

    it('commits bounded batches until exhausted and sums work, not retained inventory counts', async () => {
        const compact = vi.fn().mockResolvedValueOnce(result({ htmlSources: 3, htmlBlobs: 2, htmlBytes: 100,
            filesDeleted: 2, bytesDeleted: 100 })).mockResolvedValueOnce(result({ htmlSources: 1, htmlBlobs: 1,
            htmlBytes: 50, filesDeleted: 1, bytesDeleted: 50 })).mockResolvedValueOnce(result());
        const { client, options } = harness(compact);
        expect(await runRetentionCli(['--apply', '--until-complete', '--limit', '2'], options)).toBe(0);
        expect(compact).toHaveBeenCalledTimes(3);
        expect(compact.mock.calls.every(([db, config]) => db === client && config.apply && config.limit === 2)).toBe(true);
        expect(options.output).toHaveBeenCalledWith(expect.objectContaining({ batches: 3, htmlSources: 4,
            htmlBlobs: 3, htmlBytes: 150, filesDeleted: 3, bytesDeleted: 150, retainedPendingPlans: 3 }));
        expect(options.log).toHaveBeenNthCalledWith(1, expect.objectContaining({ batch: 1, filesDeleted: 2, bytesDeleted: 100 }));
        expect(options.log).toHaveBeenNthCalledWith(2, expect.objectContaining({ batch: 2, filesDeleted: 3, bytesDeleted: 150 }));
    });

    it('retries a pruning-only batch before declaring exhaustion', async () => {
        const compact = vi.fn().mockResolvedValueOnce(result({ filesDeleted: 1, bytesDeleted: 30 }))
            .mockResolvedValueOnce(result());
        const { options } = harness(compact);
        expect(await runRetentionCli(['--apply', '--until-complete'], options)).toBe(0);
        expect(compact).toHaveBeenCalledTimes(2);
        expect(options.output).toHaveBeenCalledWith(expect.objectContaining({ filesDeleted: 1, bytesDeleted: 30 }));
    });

    it('reports partial work and stops after a source read error', async () => {
        const compact = vi.fn().mockResolvedValueOnce(result({ htmlBlobs: 1, filesDeleted: 1, bytesDeleted: 30 }))
            .mockResolvedValueOnce(result({ sourceReadErrors: 1 }));
        const { client, options } = harness(compact);
        expect(await runRetentionCli(['--apply', '--until-complete'], options)).toBe(2);
        expect(compact).toHaveBeenCalledTimes(2);
        expect(options.output).toHaveBeenCalledWith(expect.objectContaining({ sourceReadErrors: 1, filesDeleted: 1, bytesDeleted: 30 }));
        expect(client.end).toHaveBeenCalledOnce();
    });
});
