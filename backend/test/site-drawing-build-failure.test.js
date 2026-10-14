// Exercise SiteTool's real build function in an isolated VM: structure creation must release the
// site lock before handing off, restore the drawing only on failure, and ignore duplicate clicks.
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';

const source = fs.readFileSync(new URL('../../frontend/js/site-drawing.js', import.meta.url), 'utf8');
const ast = parse(source, { sourceType: 'script' });
let declaration = null;
(function find(node) {
    if (!node || typeof node !== 'object' || declaration) return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'build') {
        declaration = node;
        return;
    }
    for (const [key, value] of Object.entries(node)) {
        if (['loc', 'start', 'end'].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(find);
        else find(value);
    }
})(ast);
if (!declaration) throw new Error('SiteTool build function not found');
const buildSource = source.slice(declaration.start, declaration.end);

function harness() {
    const state = {
        phase: 'editing',
        site: { type: 'Polygon', coordinates: [[[1, 2], [2, 2], [1, 2]]] },
        ring: [[1, 2], [2, 2], [1, 2]],
        selectionIds: ['parcel-1'],
        ground: null,
        structureBuildPending: false
    };
    const lock = { held: true };
    const calls = [];
    let resolveFactory;
    let rejectFactory;
    const factoryPromise = new Promise((resolve, reject) => {
        resolveFactory = resolve;
        rejectFactory = reject;
    });
    const factory = vi.fn(() => {
        calls.push(`factory:lock=${lock.held}`);
        return factoryPromise;
    });
    const teardown = vi.fn(() => {
        calls.push('teardown');
        lock.held = false;
        state.phase = 'idle';
        state.site = null;
    });
    const start = vi.fn(options => {
        calls.push('restore');
        state.phase = 'editing';
        state.site = { type: 'Polygon', coordinates: [options.ring] };
        lock.held = true;
        return true;
    });
    const reportFailure = vi.fn();
    const site = { site: { type: 'Polygon' }, binding: null, selectionIds: ['parcel-1'] };
    const context = vm.createContext({
        STRUCTURES: ['park', 'square', 'lake'],
        state,
        win: {
            instantCreateStructureFromSite: factory,
            reportProposalDesignSaveFailure: reportFailure,
            __mapEditLock: { isHeld: () => lock.held }
        },
        disabledTools: () => ({}),
        siteContext: () => site,
        log: () => {},
        draftApi: () => ({ siteAreaM2: () => 100 }),
        teardown,
        isActive: () => state.phase !== 'idle',
        start,
        notify: vi.fn()
    });
    vm.runInContext(`${buildSource}\nthis.runBuild = build;`, context);
    return { context, state, lock, calls, factory, teardown, start, reportFailure, resolveFactory, rejectFactory };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('SiteTool structure build lifecycle', () => {
    it.each(['null result', 'rejection'])('releases the lock before factory handoff and restores the site after a %s', async failure => {
        const test = harness();
        test.context.runBuild('park');
        expect(test.calls.slice(0, 2)).toEqual(['teardown', 'factory:lock=false']);
        expect(test.state.phase).toBe('idle');

        if (failure === 'null result') test.resolveFactory(null);
        else test.rejectFactory(new Error('factory failed'));
        await settle();

        expect(test.start).toHaveBeenCalledOnce();
        expect(test.state.phase).toBe('editing');
        expect(test.lock.held).toBe(true);
        if (failure === 'rejection') expect(test.reportFailure).toHaveBeenCalledWith(expect.any(Error));
    });

    it('does not restore the site after success and ignores a duplicate click while pending', async () => {
        const test = harness();
        test.context.runBuild('square');
        test.context.runBuild('square');

        expect(test.factory).toHaveBeenCalledOnce();
        expect(test.teardown).toHaveBeenCalledOnce();
        test.resolveFactory('proposal-1');
        await settle();

        expect(test.start).not.toHaveBeenCalled();
        expect(test.state.phase).toBe('idle');
        expect(test.state.structureBuildPending).toBe(false);
    });

    it('does not restore the old site if another editor claimed the map during handoff', async () => {
        const test = harness();
        test.context.runBuild('lake');
        test.lock.held = true;
        test.resolveFactory(null);
        await settle();

        expect(test.start).not.toHaveBeenCalled();
        expect(test.state.phase).toBe('idle');
    });
});
