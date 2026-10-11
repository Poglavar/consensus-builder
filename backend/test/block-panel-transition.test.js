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
