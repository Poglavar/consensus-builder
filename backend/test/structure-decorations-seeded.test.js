// Decorations a park, square or lake design does not carry (frontend/js/structures.js) are derived
// from the design: the same one gets the same ponds, paths, trees, stalls and fish on every load,
// and a different design gets its own.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const UrbanRuleVariation = require('../../frontend/js/urban-rule-variation.js');
const parkPlanting = require('../../frontend/js/park-planting.js');
const source = readFileSync(new URL('../../frontend/js/structures.js', import.meta.url), 'utf8');
const declarations = new Map();
(function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, source.slice(node.start, node.end));
    for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach(collect); else collect(value);
    }
})(parse(source, { sourceType: 'script', errorRecovery: true }));

function decorators() {
    const context = vm.createContext({
        turf, console, JSON, Math, Array, Number, Object, String, Infinity,
        DECORATION_VERSION: 2,
        window: { UrbanRuleVariation, __parkPlanting: parkPlanting },
        structuresReportClip: vi.fn()
    });
    const names = ['decorationRandom', 'randomPointsInBbox', 'randomPointsInside', 'featureBbox', 'pointInFeature',
        'createEllipse', 'ensureParkDecorations', 'ensureSquareDecorations', 'autoStatuePoint'];
    names.forEach(name => { if (!declarations.has(name)) throw new Error(`${name} not found in structures.js`); });
    vm.runInContext(`${names.map(name => declarations.get(name)).join('\n')}\n${names.map(name => `this.${name}=${name};`).join('\n')}`, context);
    return context;
}

const box = (id, west, south, d) => ({ type: 'Feature', properties: { proposalId: id },
    geometry: { type: 'Polygon', coordinates: [[[west, south], [west + d, south], [west + d, south + d], [west, south + d], [west, south]]] } });

describe('structure decorations a design does not carry', () => {
    it('gives the same park the same ponds, paths and trees on every build', () => {
        const first = box('design-park-a', 16.01, 45.78, 0.002);
        const second = box('design-park-a', 16.01, 45.78, 0.002);
        decorators().ensureParkDecorations(first);
        decorators().ensureParkDecorations(second);
        expect(first.properties.decorations.ponds.length).toBeGreaterThan(0);
        expect(first.properties.decorations.trees.length).toBeGreaterThan(0);
        expect(second.properties.decorations).toEqual(first.properties.decorations);
    });

    it('gives another park its own layout', () => {
        const a = box('design-park-a', 16.01, 45.78, 0.002);
        const b = box('design-park-b', 16.01, 45.78, 0.002);
        const run = decorators();
        run.ensureParkDecorations(a);
        run.ensureParkDecorations(b);
        expect(b.properties.decorations.ponds).not.toEqual(a.properties.decorations.ponds);
    });

    it('gives the same square the same stalls and fountain on every build', () => {
        const first = box('design-square-a', 16.01, 45.78, 0.001);
        const second = box('design-square-a', 16.01, 45.78, 0.001);
        decorators().ensureSquareDecorations(first);
        decorators().ensureSquareDecorations(second);
        expect(first.properties.decorations.stalls.length).toBeGreaterThan(0);
        expect(second.properties.decorations).toEqual(first.properties.decorations);
    });
});
