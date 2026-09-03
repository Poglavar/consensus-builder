import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
    new URL('../../frontend/js/proposals/storage.js', import.meta.url),
    'utf8'
);

describe('clear local proposals', () => {
    it('uses the awaited mutation coordinator path instead of wiping records directly', () => {
        const start = source.indexOf('async function clearLocalProposalData(');
        const end = source.indexOf('\nfunction initialiseProposalStorage(', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const body = source.slice(start, end);

        expect(body).toContain('await ProposalManager.clearAllProposals()');
        expect(body).not.toContain('proposalStorage.clear()');
    });
});
