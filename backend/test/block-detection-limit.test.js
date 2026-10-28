// A missing corridor must not let Detect block walk across a city or apply a truncated block.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const topology = require('../../frontend/js/parcels/block-topology.js');

function functionsFrom(file, names) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script' });
    return names.map(name => {
        const node = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id?.name === name);
        if (!node) throw new Error(`Missing function ${name}`);
        return source.slice(node.start, node.end);
    }).join('\n');
}

const detection = functionsFrom('../../frontend/js/parcel-blocks.js', [
    'formatBlockText', 'tBlock', 'failBlockDetection', 'failBlockParcelLimit',
    'floodfillBlock', 'selectCurrentBlockIntoMultiSelection'
]);
const busyHelper = functionsFrom('../../frontend/js/ui-helpers.js', ['runWithButtonBusyState']);

function harness(count, fetchRoads = async () => {}) {
    const parcels = Array.from({ length: count }, (_, i) => ({ id: `P${i}` }));
    const byId = new Map(parcels.map(parcel => [parcel.id, parcel]));
    const classes = new Set();
    const attrs = new Map();
    const button = {
        innerHTML: 'Detect block', disabled: false,
        classList: { contains: key => classes.has(key), add: key => classes.add(key), remove: key => classes.delete(key) },
        getAttribute: key => attrs.get(key) ?? null,
        setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
        set textContent(value) { this.innerHTML = value; }
    };
    const bounds = { pad() { return bounds; } };
    const ensureBounds = vi.fn();
    const alert = vi.fn();
    const reveal = vi.fn();
    const findNeighbors = vi.fn(parcel => {
        const i = Number(parcel.id.slice(1));
        return [parcels[i - 1], parcels[i + 1]].filter(Boolean);
    });
    const context = {
        console,
        window: { __parcelBlockTopology: topology, fetchCuratedRoadParcels: fetchRoads,
            CadastralParcelRepository: { ensureBounds }, showStyledAlert: alert },
        document: { querySelector: selector => selector === '.multi-select-detect-btn' ? button : null },
        map: { getBounds: () => bounds },
        multiParcelSelection: { isActive: true, selectedParcels: new Set(['previous']),
            clearSelection() { this.selectedParcels.clear(); }, updateUI() {}, addParcelHighlight() {} },
        blockSearchBoundsOverride: null, BLOCK_SEARCH_MAX_EXPANSIONS: 3, BLOCK_SEARCH_EXPANSION_PAD: 0.6,
        liveBlockServices: () => ({}), parcelIdFromLayer: parcel => parcel?.id,
        liveBlockLayerForId: id => byId.get(id), isCorridorParcel: () => false,
        getVisibleNonCorridorParcels: () => parcels, liveBlockNeighborGraph: () => ({}),
        findNeighbors, isParcelFullyVisible: () => true, revealBlockParcels: reveal, updateStatus() {}
    };
    vm.createContext(context);
    vm.runInContext(`${busyHelper}\n${detection}`, context);
    return { detect: () => context.selectCurrentBlockIntoMultiSelection(parcels[0], { replaceSelection: true }),
        selection: context.multiParcelSelection.selectedParcels, ensureBounds, alert, reveal, findNeighbors, button };
}

describe('Detect block parcel limit', () => {
    it('allows a complete block of exactly 100 parcels', async () => {
        const h = harness(100);
        await h.detect();
        expect(h.selection.size).toBe(100);
        expect(h.selection.has('previous')).toBe(false);
        expect(h.findNeighbors).toHaveBeenCalledTimes(100);
        expect(h.alert).not.toHaveBeenCalled();
        expect(h.reveal).toHaveBeenCalledOnce();
    });

    it('aborts at the 101st parcel, explains the limit and preserves selection without widening', async () => {
        const h = harness(2000);
        await h.detect();
        expect([...h.selection]).toEqual(['previous']);
        expect(h.findNeighbors).toHaveBeenCalledTimes(100);
        expect(h.ensureBounds).not.toHaveBeenCalled();
        expect(h.reveal).not.toHaveBeenCalled();
        expect(h.alert).toHaveBeenCalledExactlyOnceWith(
            'Block detection stopped: the connected area exceeds the 100-parcel limit. Select a smaller group of parcels manually.',
            { title: 'Detect block' });
        expect(h.button.disabled).toBe(false);
        expect(h.button.classList.contains('cb-busy')).toBe(false);
    });

    it('bounds a wide queue before inspecting a 101st parcel', () => {
        const inside = vi.fn(() => true);
        const neighbors = vi.fn(() => Array.from({ length: 1000 }, (_, i) => `N${i}`));
        const result = topology.growBlock({ seedId: 'seed', neighborsOf: neighbors, isInside: inside });
        expect(result).toMatchObject({ isValid: false, invalidReason: 'parcel_limit_exceeded', invalidId: 'N99' });
        expect(inside).toHaveBeenCalledTimes(100);
        expect(neighbors).toHaveBeenCalledOnce();
    });

    it('does not count repeated neighbours as new parcels', () => {
        const result = topology.growBlock({ seedId: 'seed', isInside: () => true,
            neighborsOf: id => id === 'seed' ? Array(1000).fill('other') : ['seed'] });
        expect(result.isValid).toBe(true);
        expect(result.ids).toEqual(['seed', 'other']);
    });

    it('keeps the actual Detect button spinning and disabled until its work settles', async () => {
        let resolve;
        const roads = new Promise(done => { resolve = done; });
        const h = harness(2, () => roads);
        const work = h.detect();
        expect(h.button.disabled).toBe(true);
        expect(h.button.classList.contains('cb-busy')).toBe(true);
        expect(h.button.getAttribute('aria-busy')).toBe('true');
        expect(h.findNeighbors).not.toHaveBeenCalled();
        resolve();
        await work;
        expect(h.button.disabled).toBe(false);
        expect(h.button.classList.contains('cb-busy')).toBe(false);
        expect(h.button.getAttribute('aria-busy')).toBe(null);
        expect(h.button.innerHTML).toBe('Detect block');
    });
});
