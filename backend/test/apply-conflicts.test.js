import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { unapplyConflictsSequentially } = require('../../frontend/js/proposals/apply/conflicts.js');

describe('unapplyConflictsSequentially', () => {
    it('waits for each conflict before starting the next one', async () => {
        const events = [];
        const manager = {
            async unapplyWholeFamily(id) {
                events.push(`start:${id}`);
                await Promise.resolve();
                events.push(`done:${id}`);
                return true;
            }
        };

        expect(await unapplyConflictsSequentially(manager, [{ proposalId: 'a' }, { proposalId: 'b' }])).toBe(true);
        expect(events).toEqual(['start:a', 'done:a', 'start:b', 'done:b']);
    });

    it('stops and reports failure when a conflict cannot be removed', async () => {
        const calls = [];
        const manager = {
            async unapplyProposal(id) {
                calls.push(id);
                return id !== 'b';
            }
        };
        const ok = await unapplyConflictsSequentially(manager, [
            { proposalId: 'a' }, { proposalId: 'b' }, { proposalId: 'c' }
        ]);
        expect(ok).toBe(false);
        expect(calls).toEqual(['a', 'b']);
    });
});
