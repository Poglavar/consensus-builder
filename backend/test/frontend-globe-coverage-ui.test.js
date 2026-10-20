// Exercise the globe's actual country- and region-painting function and coverage-label contract
// without WebGL or a browser. AST extraction keeps paintEarth and its palette coupled to the running
// frontend.
import { describe, expect, it, vi } from 'vitest';
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
            { cc: 'D', tier: 'source', coverage: 'unknown', rings: [ring] },
            { cc: 'E', tier: 'source', coverage: 'mostly', rings: [ring] }
        ], regions: [] }, 64, 32);

        expect(h.paintedLand).toEqual([
            h.context.coverageColors.partial,
            h.context.coverageColors.full,
            h.context.coverageColors.none,
            h.context.coverageColors.unknown,
            h.context.coverageColors.mostly
        ]);
        // Every level has its own colour; `mostly` is a lighter green than `full`.
        expect(new Set(WorldCoverage.COVERAGE_LEVELS.map(level => h.context.coverageColors[level])).size).toBe(WorldCoverage.COVERAGE_LEVELS.length);
        const lightness = hex => [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
        expect(lightness(h.context.coverageColors.mostly)).toBeGreaterThan(lightness(h.context.coverageColors.full));
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
        for (const lang of LANGS) for (const level of WorldCoverage.COVERAGE_LEVELS) {
            expect(lookup(dictionaries[lang], `world.coverage.${level}.short`), `${lang} ${level} badge`)
                .toEqual(expect.any(String));
            expect(lookup(dictionaries[lang], `world.coverage.${level}.text`), `${lang} ${level} description`)
                .toEqual(expect.any(String));
            expect(lookup(dictionaries[lang], `world.regionCoverage.${level}.short`), `${lang} ${level} region badge`)
                .toEqual(expect.any(String));
            expect(lookup(dictionaries[lang], `world.regionCoverage.${level}.text`), `${lang} ${level} region description`)
                .toEqual(expect.any(String));
        }
        for (const lang of LANGS) for (const key of ['full', 'mostly']) {
            expect(lookup(dictionaries[lang], `world.legend.${key}`), `${lang} legend ${key}`).toEqual(expect.any(String));
        }
        // The region texts must not reuse the country wording.
        expect(lookup(dictionaries.en, 'world.regionCoverage.full.short')).not.toBe(lookup(dictionaries.en, 'world.coverage.full.short'));
    });
});

describe('globe destination wiring', () => {
    it('picks an exact point on the globe background and only snaps to a drawn city marker', () => {
        const pointAt = vi.fn((lat, lon) => ({ kind: 'point', lat, lon }));
        const cityPlace = vi.fn(city => ({ kind: 'live-city', cityId: city.id, lat: city.lat, lon: city.lon }));
        const select = vi.fn(), deselect = vi.fn();
        const visibleMarkers = [];
        const context = { visibleMarkers, select, deselect, coverage: { pointAt, cityPlace },
            renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }) } },
            screenOf: () => ({ x: 200, y: 200 }),
            camera: { position: { toArray: () => [0, 0, 2] } },
            THREE: { Vector3: class { unproject() { return this; } sub() { return this; } toArray() { return [0, 0, -1]; } } },
            GM: { raySphere: () => [0, 0, 1], vectorToLatLon: () => ({ lat: 50.52023, lon: -84.79045 }) } };
        vm.runInNewContext(`${extractFunction('pickAt')}; this.pickAt = pickAt;`, context);
        context.pickAt(200, 200);
        expect(select).toHaveBeenLastCalledWith({ kind: 'point', lat: 50.52023, lon: -84.79045 });
        expect(cityPlace).not.toHaveBeenCalled();
        visibleMarkers.push({ entry: { live: true, vec: [], city: { id: 'toronto', lat: 43.65, lon: -79.38 } } });
        context.pickAt(200, 200);
        expect(select).toHaveBeenLastCalledWith({ kind: 'live-city', cityId: 'toronto', lat: 43.65, lon: -79.38 });
        expect(pointAt).toHaveBeenCalledTimes(1);
    });

    it('keeps the chosen city search result instead of replacing it with a geographic-area lookup', async () => {
        const select = vi.fn(), fly = vi.fn(async () => {});
        const context = { searchInput: { value: '', setAttribute() {}, blur() {} }, results: {}, deselect: vi.fn(),
            select, fly, searchHits: [], activeIndex: 0 };
        vm.runInNewContext(`${extractFunction('choose')}; this.choose = choose;`, context);
        const place = { kind: 'live-city', cityId: 'toronto', name: 'Toronto', lat: 43.65, lon: -79.38 };
        context.choose(place);
        await Promise.resolve();
        expect(select).toHaveBeenCalledExactlyOnceWith(place);
        expect(fly).toHaveBeenCalledWith({ lat: 43.65, lon: -79.38, altitudeKm: 8500 }, { hop: 0.6 });
    });
});
