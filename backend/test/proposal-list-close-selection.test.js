// Proposal browsing is a preview; closing its embedded sheet must preserve the currently selected
// proposal, discard a temporary preview, and never auto-select whichever row was last previewed.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const listUi = read('../../frontend/js/proposals/list-ui.js');
const layerRender = read('../../frontend/js/proposals/layer-render.js');

function extractFunction(source, declaration, endMarker) {
    const start = source.indexOf(declaration);
    expect(start, `${declaration} not found`).toBeGreaterThan(-1);
    const end = source.indexOf(endMarker, start + declaration.length);
    expect(end, `${endMarker} not found after ${declaration}`).toBeGreaterThan(start);
    return source.slice(start, end).trim();
}

function makeEnvironment({ selectedId = 'p-42', previewId = 'p-42', proposalExists = true } = {}) {
    const previewRow = { classList: { remove: vi.fn() } };
    const modal = { querySelectorAll: vi.fn(() => previewId ? [previewRow] : []) };
    const closeSheets = vi.fn();
    const clearProposalPreview = vi.fn();
    const clearProposalHighlights = vi.fn();
    const clearProposalInfoHoverOverlay = vi.fn();
    const selectAndHighlightProposal = vi.fn();
    const window = {
        proposalListBrowseMode: true,
        currentProposalPreviewId: previewId,
        currentlyHighlightedProposalId: selectedId,
        MapShell: { isOpen: vi.fn(() => true), closeSheets }
    };
    const proposalListState = { selectedId: 'stale' };
    const closeProposalList = new Function(
        'document', 'window', 'proposalListState', 'selectAndHighlightProposal',
        'clearProposalHighlights', 'clearProposalInfoHoverOverlay', 'console',
        'currentProposalPreviewId', 'clearProposalPreview', 'getProposalByIdOrHash',
        `${extractFunction(listUi, 'function closeProposalList(options = {})', '\nasync function mountProposalList')}; return closeProposalList;`
    )(
        { querySelector: selector => selector === '.proposal-list-modal' ? modal : null },
        window, proposalListState, selectAndHighlightProposal,
        clearProposalHighlights, clearProposalInfoHoverOverlay,
        { warn: vi.fn() }, previewId, clearProposalPreview,
        id => proposalExists && id === selectedId ? { proposalId: id } : null
    );
    const handleProposalSheetClosed = new Function(
        'closeProposalList',
        `${extractFunction(listUi, 'function handleProposalSheetClosed(event)', '\n\nif (typeof document')}; return handleProposalSheetClosed;`
    )(closeProposalList);

    return {
        closeProposalList, handleProposalSheetClosed, window, proposalListState, modal, previewRow,
        closeSheets, clearProposalPreview, clearProposalHighlights, clearProposalInfoHoverOverlay,
        selectAndHighlightProposal
    };
}

describe('proposal list sheet dismissal', () => {
    it('preserves the current selection while clearing preview styling, without selecting the previewed row', () => {
        const env = makeEnvironment({ selectedId: 'p-42', previewId: 'p-42' });

        env.handleProposalSheetClosed({ detail: { id: 'proposals-sheet' } });

        expect(env.window.proposalListBrowseMode).toBe(false);
        expect(env.proposalListState.selectedId).toBe('p-42');
        expect(env.previewRow.classList.remove).toHaveBeenCalledWith('is-previewing');
        expect(env.selectAndHighlightProposal).not.toHaveBeenCalled();
        expect(env.clearProposalPreview).not.toHaveBeenCalled();
        expect(env.clearProposalHighlights).not.toHaveBeenCalled();
        expect(env.clearProposalInfoHoverOverlay).toHaveBeenCalledOnce();
        expect(env.closeSheets).not.toHaveBeenCalled();
    });

    it('clears an unselected temporary preview and closes the embedded MapShell sheet on a plain close', () => {
        const env = makeEnvironment({ selectedId: null, previewId: 'p-17' });

        env.closeProposalList();

        expect(env.proposalListState.selectedId).toBeNull();
        expect(env.clearProposalPreview).toHaveBeenCalledOnce();
        expect(env.selectAndHighlightProposal).not.toHaveBeenCalled();
        expect(env.closeSheets).toHaveBeenCalledOnce();
    });

    it('does not clear a selected proposal that the map-details path already opened', () => {
        const env = makeEnvironment({ selectedId: 'p-42', previewId: 'p-17' });

        env.closeProposalList({ clearHighlights: false });

        expect(env.proposalListState.selectedId).toBe('p-42');
        expect(env.clearProposalPreview).toHaveBeenCalledOnce();
        expect(env.clearProposalHighlights).not.toHaveBeenCalled();
        expect(layerRender).toContain('closeProposalList({ clearHighlights: false })');
    });

    it('clears a stale selection when its proposal no longer exists', () => {
        const env = makeEnvironment({ selectedId: 'p-42', proposalExists: false });

        env.closeProposalList({ fromSheet: true });

        expect(env.proposalListState.selectedId).toBeNull();
        expect(env.clearProposalHighlights).toHaveBeenCalledOnce();
        expect(env.selectAndHighlightProposal).not.toHaveBeenCalled();
    });

    it('ignores close events from other sheets', () => {
        const env = makeEnvironment();

        env.handleProposalSheetClosed({ detail: { id: 'activity-sheet' } });

        expect(env.window.proposalListBrowseMode).toBe(true);
        expect(env.modal.querySelectorAll).not.toHaveBeenCalled();
    });
});
