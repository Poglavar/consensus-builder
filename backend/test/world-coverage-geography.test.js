// Uncoded Natural Earth polygons remain searchable geography without inheriting a nearby country's
// parcel-coverage status. This exercises the real compiler output and its browser-side lookup model.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { buildCoverage } from '../../scripts/build-world-coverage.mjs';

const require = createRequire(import.meta.url);
const WorldCoverage = require('../../frontend/js/world/world-coverage.js');
const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const readJson = relative => JSON.parse(readFileSync(path.join(REPO, relative), 'utf8'));
const globeSource = readFileSync(path.join(REPO, 'frontend/js/world/globe.js'), 'utf8');
const globeAst = parse(globeSource, { sourceType: 'script' });

const isIso2 = code => /^[A-Z]{2}$/.test(code || '');
const round2 = number => Math.round(number * 100) / 100;
const sourceFeatures = readJson('world-parcels/countries.geojson').features;
const nonIsoFeatures = sourceFeatures.filter(feature =>
    !isIso2(feature.properties.ISO_A2) && !isIso2(feature.properties.ISO_A2_EH));

function buildCurrentCoverage() {
    return buildCoverage({
        registry: readJson('world-parcels/registry.json'),
        countryReviews: readJson('world-parcels/country-coverage-reviews.json').reviews,
        countries: { type: 'FeatureCollection', features: sourceFeatures },
        cityConfigSource: readFileSync(path.join(REPO, 'frontend/js/city-config.js'), 'utf8')
    });
}

function extractGlobeDeclaration(type, name) {
    const matches = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (type === 'function' && node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node);
        if (type === 'const' && node.type === 'VariableDeclaration' && node.kind === 'const'
            && node.declarations.some(declaration => declaration.id?.name === name)) matches.push(node);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(globeAst);
    if (matches.length !== 1) throw new Error(`Expected one ${type} ${name} declaration, found ${matches.length}`);
    return globeSource.slice(matches[0].start, matches[0].end);
}

function globePaintHarness() {
    const paintedLand = [];
    const paintedMask = [];
    let canvasNumber = 0;
    const document = {
        createElement(tag) {
            if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`);
            const label = ['color', 'land', 'mask'][canvasNumber++];
            let fillStyle = null;
            const ctx = {
                set fillStyle(value) { fillStyle = value; },
                get fillStyle() { return fillStyle; },
                beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, save() {}, restore() {},
                fill(rule) {
                    if (rule !== 'evenodd') return;
                    if (label === 'land') paintedLand.push({ rings: this.rings, fillStyle });
                    if (label === 'mask') paintedMask.push({ rings: this.rings, fillStyle });
                },
                fillRect() {}, stroke() {}, drawImage() {},
                createPattern() { return {}; },
                createLinearGradient() { return { addColorStop() {} }; }
            };
            return { width: 0, height: 0, getContext: () => ctx };
        }
    };
    const context = { document };
    vm.createContext(context);
    vm.runInContext([
        extractGlobeDeclaration('const', 'COVERAGE_COLORS'),
        'function project() { return [0, 0]; }',
        'function traceRings(ctx, rings) { ctx.rings = rings; }',
        'function noiseTile() { return {}; }',
        extractGlobeDeclaration('function', 'paintEarth'),
        'this.paintEarth = paintEarth; this.coverageColors = COVERAGE_COLORS;'
    ].join('\n'), context);
    return { context, paintedLand, paintedMask };
}

describe('uncoded land in world coverage', () => {
    const data = buildCurrentCoverage();
    const coverage = WorldCoverage.create(data);

    it('retains every non-ISO source outline with a stable Natural Earth id', () => {
        const expectedIds = nonIsoFeatures.map(feature => `ne:${feature.properties.NE_ID}`).sort();
        expect(expectedIds).toEqual(['ne:1159320531', 'ne:1159321259']);
        expect(data.territories.map(territory => territory.id).sort()).toEqual(expectedIds);

        for (const feature of nonIsoFeatures) {
            const territory = data.territories.find(item => item.id === `ne:${feature.properties.NE_ID}`);
            expect(territory).toMatchObject({
                name: feature.properties.NAME,
                tier: 'unknown',
                coverage: 'unknown',
                note: ''
            });
            expect(territory.center).toEqual([round2(feature.properties.LABEL_Y), round2(feature.properties.LABEL_X)]);
            expect(territory.rings.length).toBeGreaterThan(0);
        }
    });

    it.each([
        ['Somaliland', 'ne:1159321259', 9.443889, 46.731595],
        ['N. Cyprus', 'ne:1159320531', 35.216071, 33.692434]
    ])('looks up, names, and searches %s without assigning a country code', (name, id, lat, lon) => {
        // Remove city overlays here so these coordinates characterize the polygon hit itself.
        const polygonOnly = WorldCoverage.create({ ...data, cities: [], liveCities: [] });
        const place = polygonOnly.tierAt(lat, lon);
        expect(place).toMatchObject({ kind: 'territory', name, cc: null, tier: 'unknown', coverage: 'unknown', placeKey: `territory:${id}` });
        expect(polygonOnly.nameAt(lat, lon, 7)).toMatchObject({ kind: 'territory', name, cc: null });
        expect(coverage.searchPlaces(name).some(result => result.kind === 'territory' && result.placeKey === `territory:${id}` && result.cc === null)).toBe(true);
    });

    it('leaves open water in the Gulf of Aden as ocean', () => {
        expect(coverage.tierAt(11.5, 48.5)).toMatchObject({ kind: 'ocean', tier: 'unknown', cc: null });
    });

    it.each([
        ['Berbera', 10.4356, 45.0117],
        ['El Afweyn', 9.928, 47.2172]
    ])('keeps the %s registry city scoped to Somalia independently of territory coverage', (name, lat, lon) => {
        expect(coverage.tierAt(lat, lon)).toMatchObject({ kind: 'city', name, cc: 'SO', tier: 'none' });
        expect(data.cities.find(city => city.name === name)).toMatchObject({ cc: 'SO', tier: 'none' });
    });

    it('does not inherit full coverage from a touching ISO country', () => {
        const square = coords => ({ type: 'Polygon', coordinates: [coords] });
        const makeFeature = (properties, polygon) => ({ type: 'Feature', properties, geometry: polygon });
        const result = buildCoverage({
            registry: {
                updatedAt: '2026-10-08',
                sources: [{ sourceId: 'aa-parcels', countryCode: 'AA', verificationStatus: 'verified_nonempty_sample' }],
                countryProbes: [],
                countryCoverage: [],
                cities: [],
                subnationalCoverage: []
            },
            countryReviews: [{
                countryCode: 'AA', coverage: 'full', checkedAt: '2026-10-08', sourceIds: ['aa-parcels'],
                exclusions: [], note: 'Reviewed national scope',
                evidence: [{ title: 'Scope evidence', url: 'https://scope.invalid/source' }]
            }],
            countries: { type: 'FeatureCollection', features: [
                makeFeature({ ISO_A2: 'AA', NAME: 'Test A', LABEL_Y: 0.5, LABEL_X: 0.5 },
                    square([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]])),
                makeFeature({ ISO_A2: '-99', ISO_A2_EH: '-99', NAME: 'Uncoded neighbor', NE_ID: 9, LABEL_Y: 0.5, LABEL_X: 1.5 },
                    square([[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]))
            ] },
            cityConfigSource: 'const CITY_CONFIGS = {};'
        });
        expect(result.countries.find(country => country.cc === 'AA')).toMatchObject({ coverage: 'full', tier: 'source' });
        expect(result.territories.find(territory => territory.id === 'ne:9')).toMatchObject({
            name: 'Uncoded neighbor', coverage: 'unknown', tier: 'unknown'
        });
    });

    it('paints territory land with unknown coverage and cuts it out of the ocean mask', () => {
        const h = globePaintHarness();
        const countryRings = [[-20, -10, -10, -10, -10, 0, -20, 0]];
        const territoryRings = [[10, -10, 20, -10, 20, 0, 10, 0]];
        h.context.paintEarth({
            countries: [{ cc: 'AA', coverage: 'full', rings: countryRings }],
            territories: [{ id: 'ne:9', name: 'Uncoded neighbor', coverage: 'unknown', rings: territoryRings }]
        }, 64, 32);

        expect(h.paintedLand).toEqual([
            { rings: countryRings, fillStyle: h.context.coverageColors.full },
            { rings: territoryRings, fillStyle: h.context.coverageColors.unknown }
        ]);
        expect(h.paintedMask).toEqual([
            { rings: countryRings, fillStyle: '#000' },
            { rings: territoryRings, fillStyle: '#000' }
        ]);
    });
});
