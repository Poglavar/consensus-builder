import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lifecycle = require('../../frontend/js/proposals/lifecycle.js');

describe('proposal expiry transition', () => {
    const originalStorage = globalThis.proposalStorage;

    beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-07-16T12:00:00.000Z')));
    afterEach(() => {
        vi.useRealTimers();
        if (originalStorage === undefined) delete globalThis.proposalStorage;
        else globalThis.proposalStorage = originalStorage;
    });

    it('changes lifecycle only and preserves local application visibility', () => {
        const proposal = {
            proposalId: 'p-expired',
            lifecycleStatus: 'Active',
            applied: true,
            roadProposal: { applied: true },
            expiresAt: '2026-07-16T11:59:59.000Z'
        };
        const transitions = [];
        globalThis.proposalStorage = {
            setProposalLifecycleStatus(id, status) {
                transitions.push([id, status]);
                proposal.lifecycleStatus = status;
            },
            save() {}
        };

        lifecycle.checkAndUpdateProposalExpiry(proposal);

        expect(transitions).toEqual([['p-expired', 'Expired']]);
        expect(proposal.lifecycleStatus).toBe('Expired');
        expect(proposal.applied).toBe(true);
        expect(proposal.roadProposal.applied).toBe(true);
    });
});
