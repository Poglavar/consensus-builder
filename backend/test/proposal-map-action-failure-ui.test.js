import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/proposals/execution.js', import.meta.url)), 'utf8');
const start = source.indexOf('function proposalApplyFailureReason(');
const end = source.indexOf('function openAcceptOwnershipTransferDialog(', start);
if (start < 0 || end < 0) throw new Error('Could not locate the proposal map action functions');
const applySource = source.slice(start, end);

function loadApply({ result = false, reason = null, throws = null, supports = true, existingError = null, visibleProposalId = 'lake-1' } = {}) {
    const button = { innerHTML: 'Apply', disabled: false };
    const appended = [];
    const footer = { appendChild: node => appended.push(node) };
    const panelError = existingError ? {
        dataset: { proposalMapActionError: 'lake-1' },
        textContent: existingError,
        remove: vi.fn()
    } : null;
    const detailsContent = { dataset: { proposalId: visibleProposalId } };
    const document = {
        getElementById: vi.fn(id => id === 'proposal-details-content' ? detailsContent : id === 'proposal-details-footer' ? footer : button),
        querySelectorAll: vi.fn(() => panelError ? [panelError] : []),
        createElement: () => ({ dataset: {}, setAttribute(name, value) { this[name] = value; } })
    };
    const messages = vi.fn();
    const info = reason ? { message: reason, code: 'outside-site' } : null;
    const ProposalManager = {
        applyProposal: vi.fn(async () => {
            if (throws) throw throws;
            return result;
        }),
        getLastApplyFailureInfo: vi.fn(() => info),
        getLastApplyFailure: vi.fn(() => reason)
    };
    const context = {
        console: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        performance: { now: () => 10 },
        setTimeout: callback => { callback(); return 1; },
        window: { __proposalMapActionFailures: existingError ? { 'lake-1': existingError } : Object.create(null) },
        document,
        ProposalManager,
        proposalStorage: { getProposal: () => ({ proposalId: 'lake-1', goal: 'park' }) },
        computeProposalCategoryFlags: () => ({ supportsMapToggle: supports, isRoadProposal: false }),
        resolveProposalActionTypeKey: () => 'park',
        APPLY_DISABLED_TYPE_KEYS: new Set(),
        getProposalI18nHelper: () => (key, fallback, params = {}) => String(fallback)
            .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) => params[name] ?? match),
        showEphemeralMessage: messages,
        clearProposalPreviewLayers: vi.fn(),
        ProposalMapAction: { renderButton: vi.fn((node, id, applied) => { node.innerHTML = applied ? 'Remove' : 'Apply'; }) },
        scheduleCorridorStripRefresh: vi.fn(),
        CSS: { escape: value => value }
    };
    const apply = runInNewContext(`${applySource}\napplyProposalToMap;`, context);
    return { apply, context, button, panelError, messages, ProposalManager, appended };
}

afterEach(() => vi.restoreAllMocks());

describe('proposal map action failure feedback', () => {
    it('shows and retains the manager reason when application returns false', async () => {
        const { apply, context, messages, appended } = loadApply({ reason: 'The proposal geometry extends beyond its site.' });

        await expect(apply('lake-1')).resolves.toBe(false);

        expect(messages).toHaveBeenCalledWith('Could not apply this proposal: The proposal geometry extends beyond its site.', 8000, 'error');
        expect(context.window.__proposalMapActionFailures['lake-1']).toContain('extends beyond its site');
        expect(appended[0].textContent).toContain('extends beyond its site');
        expect(appended[0].dataset.proposalMapActionError).toBe('lake-1');
    });

    it('retains and toasts a failure without appending it to a different visible proposal', async () => {
        const { apply, context, messages, appended } = loadApply({
            reason: 'The proposal geometry extends beyond its site.', visibleProposalId: 'another-proposal'
        });
        await expect(apply('lake-1')).resolves.toBe(false);
        expect(context.window.__proposalMapActionFailures['lake-1']).toContain('extends beyond its site');
        expect(messages).toHaveBeenCalledWith('Could not apply this proposal: The proposal geometry extends beyond its site.', 8000, 'error');
        expect(appended).toHaveLength(0);
    });

    it('surfaces an exception message and restores the action button', async () => {
        const { apply, button, messages } = loadApply({ throws: new Error('geometry replay failed') });

        await expect(apply('lake-1')).resolves.toBe(false);

        expect(messages).toHaveBeenCalledWith('Could not apply this proposal: geometry replay failed', 8000, 'error');
        expect(button).toMatchObject({ innerHTML: 'Apply', disabled: false });
    });

    it('uses a clear fallback if a failed apply has no diagnostic', async () => {
        const { apply, messages } = loadApply();

        await expect(apply('lake-1')).resolves.toBe(false);

        expect(messages).toHaveBeenCalledWith('Could not apply this proposal. Please try again.', 8000, 'error');
    });

    it('explains unsupported map application instead of failing silently', async () => {
        const { apply, messages, ProposalManager } = loadApply({ supports: false });

        await expect(apply('lake-1')).resolves.toBe(false);

        expect(messages).toHaveBeenCalledWith('This proposal type does not support map application.', 8000, 'error');
        expect(ProposalManager.applyProposal).not.toHaveBeenCalled();
    });

    it('clears stale error state and the panel notice after a successful retry', async () => {
        const { apply, context, panelError, messages } = loadApply({
            result: true,
            existingError: 'old failure'
        });

        await expect(apply('lake-1')).resolves.toBe(true);

        expect(context.window.__proposalMapActionFailures).not.toHaveProperty('lake-1');
        expect(panelError.remove).toHaveBeenCalledOnce();
        expect(messages).not.toHaveBeenCalled();
    });
});
