// Preserve a clicked road stretch through inspector handoff, but clear it when selection ends.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function declaration(path, name, indent = '') {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf(`\n${indent}function `, start + 1);
    if (start < 0 || end < 0) throw new Error(`Missing function: ${name}`);
    return source.slice(start, end);
}

function harness() {
    const items = [
        { id: 'proposed:road-a', role: 'proposed', proposalId: 'road-a' },
        { id: 'proposed:road-b', role: 'proposed', proposalId: 'road-b' },
        { id: 'existing:building', role: 'existing' }
    ];
    let selectedId = null;
    const root = {
        corridorLastClickedSegment: { proposalKey: 'road-a', segmentId: 'stretch-1' },
        ProposalSelection: { clear: vi.fn() },
        refreshSelectedCorridorSegmentHighlight: vi.fn()
    };
    const context = vm.createContext({
        root, window: root, ready: true, focusedRecord: null, actionsOpen: false, restoreId: null,
        currentProposalDetailsContext: null,
        document: { getElementById: () => null, body: { classList: { remove() {} } } },
        teardownProposalDetailsEscapeHandler() {}, renderInspector() {}, renderFocus() {},
        sceneItems: () => items,
        selected: () => items.find(item => item.id === selectedId),
        store: { select: id => { selectedId = id; } }
    });
    vm.runInContext(declaration('../../frontend/js/proposals/details-panel.js', 'hideProposalDetailsPanel')
        + '\n' + declaration('../../frontend/js/planning/views.js', 'select', '    '), context);
    root.hideProposalDetailsPanel = context.hideProposalDetailsPanel;
    return { root, select: context.select };
}

describe('corridor segment selection through the shared inspector', () => {
    it('retains the clicked stretch while inspecting the same road', () => {
        const { root, select } = harness();
        select('proposed:road-a');
        expect(root.corridorLastClickedSegment).toEqual({ proposalKey: 'road-a', segmentId: 'stretch-1' });
        expect(root.ProposalSelection.clear).not.toHaveBeenCalled();
    });

    it.each(['proposed:road-b', 'existing:building', null])('clears the clicked stretch on selection %s', next => {
        const { root, select } = harness();
        select('proposed:road-a');
        select(next);
        expect(root.corridorLastClickedSegment).toBeNull();
        expect(root.refreshSelectedCorridorSegmentHighlight).toHaveBeenCalled();
    });
});
