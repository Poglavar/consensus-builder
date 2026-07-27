import { describe, expect, it } from 'vitest';
import { parseArgs, sanitizeProposalJson } from '../scripts/remove-server-applied.js';

describe('remove-server-applied migration', () => {
    it('is dry-run by default and parses the destructive flag explicitly', () => {
        expect(parseArgs([])).toMatchObject({ apply: false, dropApplied: false });
        expect(parseArgs(['--apply', '--drop-applied', '--proposals=1,p-x']))
            .toMatchObject({ apply: true, dropApplied: true, proposals: ['1', 'p-x'] });
    });

    it('strips local flags while preserving proposal definitions', () => {
        expect(sanitizeProposalJson({
            applied: true,
            appliedAt: 'now',
            lifecycleStatus: 'Executed',
            structureProposal: { applied: false, status: 'unapplied', kind: 'park' }
        })).toEqual({ lifecycleStatus: 'Executed', structureProposal: { kind: 'park' } });
    });
});
