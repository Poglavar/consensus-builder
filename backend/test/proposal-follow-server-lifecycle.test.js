// A local copy of a published proposal follows the lifecycle the server reports (server-sync.js
// followServerLifecycle): a copy the server reports Cancelled takes that lifecycle and leaves the map.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const status = require('../../frontend/js/proposals/status.js');
const displayState = require('../../frontend/js/proposals/display-state.js');
const evidenceModel = require('../../frontend/js/proposals/lifecycle-evidence.js');
const source = readFileSync(new URL('../../frontend/js/proposals/server-sync.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('const SERVER_TERMINAL_LIFECYCLES'), source.indexOf('function isServerProposalDownloaded('));
const evidenceBody = source.slice(source.indexOf('function serverLifecycleEvidenceFor('), source.indexOf('function getServerSyncGroundService('));
const serverLifecycleEvidenceFor = new Function('serverSyncLifecycleOf', 'serverSyncLifecycleEvidence',
    `${evidenceBody}; return serverLifecycleEvidenceFor;`)(status.getLifecycleStatus, evidenceModel);

function harness(local) {
    const proposalStorage = {
        setProposalLifecycleStatus: vi.fn((_key, lifecycle) => { local.lifecycleStatus = lifecycle; return true; }),
        save: vi.fn()
    };
    const ProposalManager = { unapplyProposal: vi.fn(async () => { local.applied = false; return true; }) };
    const updateProposalList = vi.fn();
    const api = new Function('serverSyncLifecycleOf', 'serverLifecycleEvidenceFor', 'isApplied', 'window', 'proposalStorage', 'ProposalManager',
        'findLocalCopyOfServerProposal', 'updateProposalList', 'console',
        `${body} return { followServerLifecycle, followServerLifecycles };`)(
        status.getLifecycleStatus, serverLifecycleEvidenceFor, status.isApplied, { __proposalDisplayState: displayState }, proposalStorage,
        ProposalManager, summary => (String(summary.serverProposalId) === String(local.serverProposalId) ? local : null),
        updateProposalList, { info() {}, error() {} });
    return { ...api, proposalStorage, ProposalManager, updateProposalList };
}

describe('local copies follow the server lifecycle', () => {
    it('takes Cancelled from the server and unapplies a copy standing on the map', async () => {
        const local = { proposalId: 'c2-uh980k1g32gls', serverProposalId: '781', lifecycleStatus: 'Active', applied: true };
        const { followServerLifecycle, proposalStorage, ProposalManager } = harness(local);
        expect(await followServerLifecycle(local, 'Cancelled')).toBe(true);
        expect(proposalStorage.setProposalLifecycleStatus).toHaveBeenCalledWith('c2-uh980k1g32gls', 'Cancelled');
        expect(ProposalManager.unapplyProposal).toHaveBeenCalledWith('c2-uh980k1g32gls');
        expect(local).toMatchObject({ lifecycleStatus: 'Cancelled', applied: false });
    });

    it('takes Expired without unapplying, and lets Active never reopen a terminal state', async () => {
        const expiring = { proposalId: 'p-1', serverProposalId: '1', lifecycleStatus: 'Active', applied: true };
        const first = harness(expiring);
        expect(await first.followServerLifecycle(expiring, 'Expired')).toBe(true);
        expect(expiring.lifecycleStatus).toBe('Expired');
        expect(first.ProposalManager.unapplyProposal).not.toHaveBeenCalled();

        const executedHere = { proposalId: 'p-2', serverProposalId: '2', lifecycleStatus: 'Executed', applied: true };
        const second = harness(executedHere);
        expect(await second.followServerLifecycle(executedHere, 'Active')).toBe(false);
        expect(executedHere.lifecycleStatus).toBe('Executed');
        expect(second.proposalStorage.setProposalLifecycleStatus).not.toHaveBeenCalled();
    });

    it('follows every summary that has a local copy and refreshes the list once something changed', async () => {
        const local = { proposalId: 'c2-uh980k1g32gls', serverProposalId: '781', lifecycleStatus: 'Active', applied: true };
        const { followServerLifecycles, updateProposalList } = harness(local);
        const changed = await followServerLifecycles([
            { serverProposalId: '781', lifecycleStatus: 'Cancelled' },
            { serverProposalId: '999', lifecycleStatus: 'Cancelled' }
        ]);
        expect(changed).toBe(1);
        expect(local).toMatchObject({ lifecycleStatus: 'Cancelled', applied: false });
        expect(updateProposalList).toHaveBeenCalledOnce();
    });

    it('copies fresh server evidence and removes stale local evidence when summaries omit it', async () => {
        const local = {
            proposalId: 'p-3', serverProposalId: '3', lifecycleStatus: 'Executed',
            lifecycleEvidence: { protocol: 'proposal-lifecycle-evidence/1', state: 'observed', status: 'Executed', source: 'chain-state-read', observedAt: '2026-10-20T10:00:00.000Z' }
        };
        const { followServerLifecycle, proposalStorage } = harness(local);
        const serverEvidence = {
            protocol: 'proposal-lifecycle-evidence/1', state: 'unknown',
            claimedStatus: 'Executed', reason: 'no-matching-observation'
        };
        expect(await followServerLifecycle(local, 'Executed', serverEvidence)).toBe(true);
        expect(local.lifecycleEvidence).toEqual(serverEvidence);
        expect(proposalStorage.save).toHaveBeenCalledOnce();

        expect(await followServerLifecycle(local, 'Executed')).toBe(true);
        expect(local).not.toHaveProperty('lifecycleEvidence');
        expect(proposalStorage.save).toHaveBeenCalledTimes(2);
    });
});
