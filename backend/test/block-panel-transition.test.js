import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

it('opening block details dismisses the parcel panel before showing the block actions', () => {
    const transitions = [];
    const panel = {
        classList: { add: name => transitions.push(`block:${name}`) },
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    const context = vm.createContext({
        window: {
            addEventListener() {},
            hideParcelInfoPanel: () => transitions.push('parcel:hidden'),
        },
        document: {
            getElementById: id => id === 'block-info-panel' ? panel : null,
            querySelectorAll: () => [],
        },
        console,
        setTimeout: () => 1,
        clearTimeout() {},
    });
    vm.runInContext(readFileSync(new URL('../../frontend/js/parcel-blocks.js', import.meta.url), 'utf8'), context);
    context.window.blockStorage.blocks.set('test block', { parcelIds: [], parcels: [] });

    context.showBlockInfo('missing block', true);
    expect(transitions).toEqual([]);
    context.showBlockInfo('test block', true);
    expect(transitions).toEqual(['parcel:hidden', 'block:visible']);
});

it('selecting a block from Layers closes sheets before opening block details', () => {
    const transitions = [];
    const items = [];
    const context = vm.createContext({
        window: { addEventListener() {}, MapShell: { closeSheets: () => transitions.push('sheets:closed') } },
        document: {
            getElementById: id => id === 'blocks-content' ? { innerHTML: '', appendChild: item => items.push(item) } : null,
            createElement: () => ({ dataset: {} })
        },
        console, setTimeout, clearTimeout
    });
    vm.runInContext(readFileSync(new URL('../../frontend/js/parcel-blocks.js', import.meta.url), 'utf8'), context);
    context.window.blockStorage.blocks.set('test block', { parcels: [] });
    context.highlightAndCenterBlock = name => transitions.push(`block:${name}`);
    context.updateBlocksList();
    items[0].onclick();
    expect(transitions).toEqual(['sheets:closed', 'block:test block']);
});

it('opening block details closes a docked design panel, but not one the click stack hosts', () => {
    const run = hosted => {
        const transitions = [];
        const panel = { classList: { add: name => transitions.push(`block:${name}`) }, querySelector: () => null, querySelectorAll: () => [] };
        const designPanel = { classList: { contains: name => name === 'visible' || (hosted && name === 'is-hosted') } };
        const context = vm.createContext({
            window: {
                addEventListener() {},
                hideParcelInfoPanel: () => transitions.push('parcel:hidden'),
                hideProposalDetailsPanel: clear => transitions.push(`design:hidden:${clear}`),
            },
            document: {
                getElementById: id => (id === 'block-info-panel' ? panel : id === 'proposal-details-panel' ? designPanel : null),
                querySelectorAll: () => [],
            },
            console, setTimeout: () => 1, clearTimeout() {},
        });
        vm.runInContext(readFileSync(new URL('../../frontend/js/parcel-blocks.js', import.meta.url), 'utf8'), context);
        context.window.blockStorage.blocks.set('test block', { parcelIds: [], parcels: [] });
        context.showBlockInfo('test block', true);
        return transitions;
    };
    expect(run(false)).toEqual(['parcel:hidden', 'design:hidden:true', 'block:visible']);
    expect(run(true)).toEqual(['parcel:hidden', 'block:visible']);
});
