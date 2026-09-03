import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
    new URL('../../frontend/js/proposals/layer-render.js', import.meta.url),
    'utf8'
);

function loadOwnParcelPanel(window, document) {
    const start = source.indexOf('function clearProposalOwnParcelInfo(');
    const end = source.indexOf('\nfunction selectAndHighlightProposal(', start);
    expect(start, 'clearProposalOwnParcelInfo not found').toBeGreaterThanOrEqual(0);
    expect(end, 'end of own-parcel helpers not found').toBeGreaterThan(start);
    const body = source.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function(
        'window', 'document', 'console',
        `${body}; return { clearProposalOwnParcelInfo, showOwnParcelInfoForProposal };`
    )(window, document, console);
}

function makeHarness() {
    const panel = {
        visible: true,
        classList: {
            remove: vi.fn(() => { panel.visible = false; })
        }
    };
    const showParcelInfoPanel = vi.fn();
    const features = new Map([
        ['generated-lake', { type: 'Feature', properties: { parcelId: 'generated-lake' } }]
    ]);
    const window = {
        currentlyHighlightedProposalId: 'lake-1',
        ProposalOwnParcel: { ownParcelId: vi.fn(() => 'generated-lake') },
        LiveParcelFabric: {
            producedBy: vi.fn(() => Array.from(features.values())),
            get: vi.fn(id => features.get(String(id)) || null)
        },
        Parcels: { uiParcelPanel: { showParcelInfoPanel } },
        __drillUi: { hideIfNothingSelected: vi.fn() }
    };
    const document = { getElementById: vi.fn(() => panel) };
    return { window, document, panel, features, showParcelInfoPanel };
}

describe('proposal-owned parcel panel lifecycle', () => {
    it('tracks the live feature whose secondary panel it opens', () => {
        const harness = makeHarness();
        const api = loadOwnParcelPanel(harness.window, harness.document);

        api.showOwnParcelInfoForProposal({ proposalId: 'lake-1' });

        expect(harness.showParcelInfoPanel).toHaveBeenCalledWith(harness.features.get('generated-lake'));
        expect(harness.window.__proposalOwnParcelPanelId).toBe('generated-lake');
        expect(harness.window.currentlyHighlightedProposalId).toBe('lake-1');
    });

    it('closes a removed generated parcel without clearing the proposal selection', () => {
        const harness = makeHarness();
        const api = loadOwnParcelPanel(harness.window, harness.document);
        api.showOwnParcelInfoForProposal({ proposalId: 'lake-1' });
        harness.features.clear();

        api.showOwnParcelInfoForProposal({ proposalId: 'lake-1' });

        expect(harness.panel.visible).toBe(false);
        expect(harness.window.__proposalOwnParcelPanelId).toBeNull();
        expect(harness.window.currentlyHighlightedProposalId).toBe('lake-1');
        expect(harness.window.__drillUi.hideIfNothingSelected).toHaveBeenCalledOnce();
    });

    it('does not close a parcel panel that a later direct map selection now owns', () => {
        const harness = makeHarness();
        const api = loadOwnParcelPanel(harness.window, harness.document);
        api.showOwnParcelInfoForProposal({ proposalId: 'lake-1' });
        harness.window.selectedParcelId = 'independent-parcel';
        harness.features.clear();

        api.showOwnParcelInfoForProposal({ proposalId: 'lake-1' });

        expect(harness.panel.visible).toBe(true);
        expect(harness.window.__proposalOwnParcelPanelId).toBeNull();
    });
});
