import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const lifecycle = require('../../frontend/js/proposals/lifecycle.js');
const lifecycleSource = readFileSync(new URL('../../frontend/js/proposals/lifecycle.js', import.meta.url), 'utf8');

describe('proposal expiry transition', () => {
    const originalStorage = globalThis.proposalStorage;

    beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-07-16T12:00:00.000Z')));
    afterEach(() => {
        vi.useRealTimers();
        if (originalStorage === undefined) delete globalThis.proposalStorage;
        else globalThis.proposalStorage = originalStorage;
    });

    it.each([undefined, 'Unknown', 'pending', 'draft', 'Cancelled', 'Executed'])(
        'does not expire a %s record merely because its deadline passed', lifecycleStatus => {
            const proposal = { lifecycleStatus, applied: true, expiresAt: '2020-01-01T00:00:00Z' };
            const before = { ...proposal };
            expect(lifecycle.isProposalExpired(proposal)).toBe(false);
            lifecycle.checkAndUpdateProposalExpiry(proposal);
            expect(proposal).toEqual(before);
        });

    it('never starts an unknown countdown and stops an active one if lifecycle becomes unknown', () => {
        const proposal = { lifecycleStatus: 'Unknown' };
        const element = {
            getAttribute: name => name === 'data-proposal-id' ? 'p-timer' : '2099-01-01T00:00:00Z',
            querySelector: () => ({ textContent: '' }),
            classList: { toggle: vi.fn() }, remove: vi.fn()
        };
        const context = { getLifecycleStatus: require('../../frontend/js/proposals/status.js').getLifecycleStatus,
            ProposalKind: require('../../frontend/js/proposals/proposal-kind.js'),
            document: { querySelector: () => element }, proposalStorage: { getProposal: () => proposal },
            setInterval: vi.fn(() => 1), clearInterval: vi.fn(), expiryCountdownInterval: null,
            formatRemainingTime: () => 'later' };
        runInNewContext(lifecycleSource, context);
        context.initializeExpiryCountdown();
        expect(context.setInterval).not.toHaveBeenCalled();
        proposal.lifecycleStatus = 'Active';
        context.initializeExpiryCountdown();
        expect(context.setInterval).toHaveBeenCalledOnce();
        proposal.lifecycleStatus = 'Unknown';
        context.setInterval.mock.calls[0][0]();
        expect(context.clearInterval).toHaveBeenCalledWith(1);
        expect(element.remove).toHaveBeenCalledOnce();
        expect(proposal.lifecycleStatus).toBe('Unknown');
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
