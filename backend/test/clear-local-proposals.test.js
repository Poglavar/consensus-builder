import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../../frontend/js/proposals/storage.js', import.meta.url),
    'utf8'
);
const start = source.indexOf('async function clearLocalProposalData(');
const end = source.indexOf('\nfunction initialiseProposalStorage(', start);
const body = start >= 0 && end > start ? source.slice(start, end) : '';

// Runs clearLocalProposalData on a window whose collaborators are stubs; `order` records which
// store was cleared when.
async function runClear({ cleared = { ok: true } } = {}) {
    const order = [];
    const window = { AgreementStore: { clear: vi.fn(() => { order.push('agreements'); return 1; }) } };
    const updateStatus = vi.fn();
    const context = vm.createContext({
        window,
        console: { error: vi.fn(), warn() {}, log() {} },
        proposalStorage: { getAllProposals: () => [{ proposalId: 'p-1' }] },
        ProposalManager: { clearAllProposals: vi.fn(async () => { order.push('proposals'); return cleared; }) },
        clearProposalHighlights: vi.fn(),
        proposalLayer: null,
        map: { removeLayer: vi.fn() },
        document: { getElementById: () => null, querySelector: () => null },
        closeProposalList: vi.fn(),
        updateStatus,
        updateShowProposalsButton: vi.fn(),
        getProposalI18nHelper: () => (_key, fallback) => fallback
    });
    vm.runInContext(`${body}\nthis.clearLocalProposalData = clearLocalProposalData;`, context);
    await context.clearLocalProposalData();
    return { order, window, updateStatus };
}

describe('clear local proposals', () => {
    it('uses the awaited mutation coordinator path instead of wiping records directly', () => {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);

        expect(body).toContain('await ProposalManager.clearAllProposals()');
        expect(body).not.toContain('proposalStorage.clear()');
    });

    it('clears the agreements once the proposals they name are gone, and keeps them when the proposals stay', async () => {
        const done = await runClear();
        expect(done.window.AgreementStore.clear).toHaveBeenCalledTimes(1);
        expect(done.order).toEqual(['proposals', 'agreements']);
        expect(done.updateStatus).toHaveBeenCalledWith('Cleared 1 proposal from local storage');

        const refused = await runClear({ cleared: { ok: false } });
        expect(refused.order).toEqual(['proposals']);
        expect(refused.window.AgreementStore.clear).not.toHaveBeenCalled();
        expect(refused.updateStatus).toHaveBeenCalledWith('Error clearing proposal data. Please try again.');
    });
});
