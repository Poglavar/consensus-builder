// Detect block knows which parcels are roads before it judges its seed. The curated road
// classification arrives in the background after a parcel load (road-parcels.js); the seed's
// corridor check used to run before detection awaited it, so the answer for a road seed depended
// on which finished first: refused when the classification had landed, a block grown from the road
// when it had not (the e2e fixture world's flaky Detect block under load).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../../frontend/js/parcel-blocks.js', import.meta.url), 'utf8');

function functionSource(name) {
    const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
    const node = ast.program.body.find(statement => statement.type === 'FunctionDeclaration' && statement.id?.name === name);
    if (!node) throw new Error(`missing function ${name}`);
    return source.slice(node.start, node.end);
}

function harness({ seedIsRoadAfterFetch }) {
    const roads = new Set();
    const calls = { failures: [], floods: 0 };
    const seed = { id: 'seed' };
    const neighbour = { id: 'neighbour' };
    const bounds = { pad() { return bounds; } };
    const context = {
        console,
        window: {
            fetchCuratedRoadParcels: async () => { if (seedIsRoadAfterFetch) roads.add('seed'); return seedIsRoadAfterFetch ? 1 : 0; },
            CadastralParcelRepository: { ensureBounds: async () => {} }
        },
        document: { querySelector: () => null },
        map: { getBounds: () => bounds },
        multiParcelSelection: { isActive: true, selectedParcels: new Set(), lastSelectedParcelId: null, updateUI() {}, addParcelHighlight() {} },
        currentParcel: null,
        selectedParcelId: null,
        blockSearchBoundsOverride: null,
        BLOCK_SEARCH_MAX_EXPANSIONS: 3,
        BLOCK_SEARCH_EXPANSION_PAD: 0.6,
        tBlock: (_key, _params, fallback) => fallback,
        failBlockDetection: message => { calls.failures.push(message); return false; },
        liveBlockServices: () => ({}),
        parcelIdFromLayer: layer => layer?.id || null,
        liveBlockLayerForId: id => (id === 'seed' ? seed : null),
        isCorridorParcel: id => roads.has(String(id)),
        getVisibleNonCorridorParcels: () => [seed, neighbour],
        liveBlockNeighborGraph: () => new Map(),
        floodfillBlock: (_start, parcels) => { calls.floods += 1; parcels.push(seed, neighbour); return { isValid: true }; },
        revealBlockParcels() {},
        updateStatus() {}
    };
    vm.createContext(context);
    vm.runInContext(`${functionSource('selectCurrentBlockIntoMultiSelection')}\nthis.detect = selectCurrentBlockIntoMultiSelection;`, context);
    return { detect: () => context.detect(seed), calls, selection: context.multiParcelSelection.selectedParcels };
}

describe('Detect block and the road classification', () => {
    it('refuses a seed the curated classification marks as a road, even when the mark lands during detection', async () => {
        const { detect, calls, selection } = harness({ seedIsRoadAfterFetch: true });
        await detect();
        expect(calls.failures).toEqual(['This is a road or track parcel. A block is the land BETWEEN corridors — start from a parcel inside one.']);
        expect(calls.floods).toBe(0);
        expect(selection.size).toBe(0);
    });

    it('grows the block from an ordinary seed', async () => {
        const { detect, calls, selection } = harness({ seedIsRoadAfterFetch: false });
        expect(await detect()).toBe(true);
        expect(calls.failures).toEqual([]);
        expect([...selection].sort()).toEqual(['neighbour', 'seed']);
    });
});
