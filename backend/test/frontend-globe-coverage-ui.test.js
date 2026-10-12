// Exercise the globe's actual country- and region-painting function and coverage-label contract
// without WebGL or a browser. AST extraction keeps paintEarth and its palette coupled to the running
// frontend.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const WorldCoverage = require('../../frontend/js/world/world-coverage.js');
const FRONTEND = new URL('../../frontend/', import.meta.url);
const globeSource = readFileSync(new URL('js/world/globe.js', FRONTEND), 'utf8');
const globeAst = parse(globeSource, { sourceType: 'script' });

function findNode(predicate) {
    const matches = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (predicate(node)) matches.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(globeAst);
    return matches;
}

function extractFunction(name) {
    const matches = findNode(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
    if (matches.length !== 1) throw new Error(`Expected one ${name} declaration, found ${matches.length}`);
    return globeSource.slice(matches[0].start, matches[0].end);
}

function extractConst(name) {
    const matches = findNode(node => node.type === 'VariableDeclaration' && node.kind === 'const'
        && node.declarations.some(declaration => declaration.id?.name === name));
    if (matches.length !== 1) throw new Error(`Expected one const ${name}, found ${matches.length}`);
    return globeSource.slice(matches[0].start, matches[0].end);
}

function paintHarness() {
    const paintedLand = [];
    const landOps = [];
    let canvasNumber = 0;
    const document = {
        createElement(tag) {
            if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`);
            const label = ['color', 'land', 'noise', 'mask'][canvasNumber++] || 'extra';
            let currentFillStyle = null;
            const saved = [];
            const ctx = {
                globalCompositeOperation: 'source-over',
                set fillStyle(value) { currentFillStyle = value; },
                get fillStyle() { return currentFillStyle; },
                beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
                save() { saved.push(this.globalCompositeOperation); },
                restore() { this.globalCompositeOperation = saved.pop(); },
                fill(rule) {
                    if (label !== 'land' || rule !== 'evenodd') return;
                    paintedLand.push(currentFillStyle);
                    landOps.push(this.globalCompositeOperation);
                },
                fillRect() {}, stroke() {}, drawImage() {}, putImageData() {},
                createPattern() { return {}; },
                createLinearGradient() { return { addColorStop() {} }; },
                createImageData(size) { return { data: new Uint8ClampedArray(size * size * 4) }; }
            };
            return { width: 0, height: 0, getContext: () => ctx };
        }
    };
    const context = { document };
    vm.createContext(context);
    vm.runInContext([
        extractConst('COVERAGE_COLORS'), extractConst('TIER_COLORS'),
        extractFunction('project'), extractFunction('traceRings'), extractFunction('noiseTile'),
        extractFunction('paintEarth'),
        'this.paintEarth = paintEarth; this.coverageColors = COVERAGE_COLORS; this.tierColors = TIER_COLORS;'
    ].join('\n'), context);
    return { context, paintedLand, landOps };
}

const LANGS = ['en', 'hr', 'es', 'sr'];
const lookup = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);

describe('globe geographic coverage UI contract', () => {
    it('paints countries from coverage even when app tier contradicts it', () => {
        const h = paintHarness();
        const ring = [-10, -10, 10, -10, 10, 10, -10, 10];
        h.context.paintEarth({ countries: [
            { cc: 'A', tier: 'live', coverage: 'partial', rings: [ring] },
            { cc: 'B', tier: 'source', coverage: 'full', rings: [ring] },
            { cc: 'C', tier: 'live', coverage: 'none', rings: [ring] },
            { cc: 'D', tier: 'source', coverage: 'unknown', rings: [ring] }
        ], regions: [] }, 64, 32);

        expect(h.paintedLand).toEqual([
            h.context.coverageColors.partial,
            h.context.coverageColors.full,
            h.context.coverageColors.none,
            h.context.coverageColors.unknown
        ]);
        expect(h.context.coverageColors.partial).not.toBe(h.context.tierColors.live);
        expect(h.context.coverageColors.full).not.toBe(h.context.tierColors.source);
    });

    it('paints regions over their country with their own coverage, clipped to the land already drawn', () => {
        const h = paintHarness();
        const country = [-10, -10, 10, -10, 10, 10, -10, 10];
        const england = [-10, -10, 0, -10, 0, 10, -10, 10];
        h.context.paintEarth({
            countries: [{ cc: 'GB', tier: 'source', coverage: 'partial', rings: [country] }],
            regions: [
                { id: 'GB-ENG', cc: 'GB', tier: 'source', coverage: 'full', rings: [england] },
                { id: 'GB-NIR', cc: 'GB', tier: 'unknown', coverage: 'unknown', rings: [] }
            ]
        }, 64, 32);
        // Country first, then the region on top; an outline-less region paints nothing.
        expect(h.paintedLand).toEqual([h.context.coverageColors.partial, h.context.coverageColors.full]);
        expect(h.landOps).toEqual(['source-over', 'source-atop']);
    });

    it('uses geographic coverage keys for countries and app tiers for cities', () => {
        expect(WorldCoverage.statusKey({ kind: 'country', tier: 'live', coverage: 'partial' }))
            .toBe('world.coverage.partial');
        expect(WorldCoverage.statusKey({ kind: 'country', tier: 'source', coverage: 'full' }))
            .toBe('world.coverage.full');
        expect(WorldCoverage.statusKey({ kind: 'live-city', tier: 'live' })).toBe('world.tier.live');
        expect(WorldCoverage.statusKey({ kind: 'region', tier: 'source', coverage: 'full' })).toBe('world.regionCoverage.full');
    });

    it('provides every coverage badge and description in all four locales', () => {
        const dictionaries = Object.fromEntries(LANGS.map(lang => [
            lang, JSON.parse(readFileSync(new URL(`i18n/${lang}.json`, FRONTEND), 'utf8'))
        ]));
        for (const lang of LANGS) for (const level of ['full', 'partial', 'none', 'unknown']) {
            expect(lookup(dictionaries[lang], `world.coverage.${level}.short`), `${lang} ${level} badge`)
                .toEqual(expect.any(String));
            expect(lookup(dictionaries[lang], `world.coverage.${level}.text`), `${lang} ${level} description`)
                .toEqual(expect.any(String));
            expect(lookup(dictionaries[lang], `world.regionCoverage.${level}.short`), `${lang} ${level} region badge`)
                .toEqual(expect.any(String));
            expect(lookup(dictionaries[lang], `world.regionCoverage.${level}.text`), `${lang} ${level} region description`)
                .toEqual(expect.any(String));
        }
        for (const lang of LANGS) expect(lookup(dictionaries[lang], 'world.legend.full'), `${lang} legend`).toEqual(expect.any(String));
        // The region texts must not reuse the country wording.
        expect(lookup(dictionaries.en, 'world.regionCoverage.full.short')).not.toBe(lookup(dictionaries.en, 'world.coverage.full.short'));
    });
});
