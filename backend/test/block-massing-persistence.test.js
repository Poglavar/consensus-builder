// The rule editors autosave while open and commit again on Done. Exercise those real snapshots plus
// the shared massing stamp so a preview can never lose its rule or seed at either boundary. A Block
// saves its per-parcel pieces (each with its own seed, so every view realizes the street the editor
// drew) beside the complete authored massing; a Row saves its complete massing.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import UrbanRuleVariation from '../../frontend/js/urban-rule-variation.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');

function functionSources(path) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const ast = parse(source, { sourceType: 'script', plugins: ['optionalChaining', 'nullishCoalescingOperator'] });
    const functions = new Map();
    (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, source.slice(node.start, node.end));
        Object.keys(node).forEach(key => {
            if (['loc', 'start', 'end'].includes(key)) return;
            const value = node[key];
            if (Array.isArray(value)) value.forEach(walk); else walk(value);
        });
    })(ast);
    return functions;
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function rect(west, south, east, north, properties = {}) {
    return {
        type: 'Feature',
        properties: { ...properties },
        geometry: {
            type: 'Polygon',
            coordinates: [
                [[west, south], [east, south], [east, north], [west, north], [west, south]],
                [[west + (east - west) * 0.35, south + (north - south) * 0.35],
                    [west + (east - west) * 0.35, south + (north - south) * 0.65],
                    [west + (east - west) * 0.65, south + (north - south) * 0.65],
                    [west + (east - west) * 0.65, south + (north - south) * 0.35],
                    [west + (east - west) * 0.35, south + (north - south) * 0.35]]
            ]
        }
    };
}

function rule(typology = 'block', kind = 'range') {
    return UrbanRuleVariation.normalizeBlockRule({
        typology, kind, maxHeightM: 17.5, minHeightM: 7, minDepthM: 8, floorHeightM: 3.5
    });
}

function runFunction(source, name, bindings) {
    const context = vm.createContext(bindings);
    vm.runInContext(`${source}\nthis.__run = ${name};`, context);
    return context.__run();
}

const blockSite = () => rect(15.999, 44.999, 16.001, 45.001, { id: 'free-site' });
const blockPieces = (feature, seed = 731) => UrbanRuleVariation.splitMassingByParcels(
    feature, [{ feature: blockSite(), parcelId: '__placement-site__' }], rule('block', 'range'), seed, { turf }).pieces;

function blockBindings({ mode = 'manual', feature, generatedFeatures = [], pieces = [] }, window, document) {
    const site = blockSite();
    const block = { parcels: [{ id: '__placement-site__', feature: site }], syntheticSite: true };
    return {
        window, document, blockifyMode: mode, generatedBuildingFeature: feature,
        generatedBuildingFeatures: generatedFeatures, blockMassingPieces: pieces, blockExcludedParcels: [],
        getActiveBlockifyBlock: () => block,
        blockifyFeatureForParcel: parcel => parcel.feature, blockifyParcelId: parcel => parcel.id,
        blockifyClone: clone, getBlockifyDisplayName: () => 'test block',
        currentBlockRule: () => rule('block', 'range'), blockVariationSeed: 731,
        blockMinHeightM: 7, blockMinDepthM: 8, blockMinPlotAreaM2: 0,
        DEFAULT_BUILDING_HEIGHT: 17.5, currentBuildingHeight: 17.5, currentBuildingWidth: 20,
        currentSetback: 0, currentChamferM: 0, currentSimplifyM: 0,
        gapPositions: [], wingPositions: [], manualOuterRing: null, currentGapWidth: 5, currentWingLength: 10,
        blockifySurroundings: null,
        blockifyPlacementTransform: { translationMeters: [0, 0], rotationDegrees: 0 },
        blockifyGenerationSite: site, blockifyDesignBoundary: () => site,
        existingRule: {}, currentProposedHeightFloors: 1, currentAdditionalFloors: 0,
        currentFloorHeightM: 3, turf
    };
}

function blockAutosave({ mode = 'manual', feature, generatedFeatures = [], pieces = [] }) {
    const saved = [];
    const document = { getElementById: id => id === 'algorithm-select' ? { value: 'test' } : null };
    const window = {
        UrbanRuleVariation,
        getActiveProposalDesignDraft: () => ({ adapterKey: 'buildings' }),
        syncActiveProposalDraftFromEditor: (...args) => saved.push(clone(args))
    };
    const bindings = blockBindings({ mode, feature, generatedFeatures, pieces }, window, document);
    const source = functionSources('../../frontend/js/building-blocks.js').get('autosaveBlockifyDraft');
    runFunction(source, 'autosaveBlockifyDraft', bindings);
    return saved[0]?.[1] || null;
}

// Done, as the editor runs it: the context handed to proposal creation.
async function blockDone({ mode = 'manual', feature, generatedFeatures = [], pieces = [] }) {
    const contexts = [];
    const infos = [];
    const document = { getElementById: id => id === 'algorithm-select' ? { value: 'test' } : null };
    const window = { UrbanRuleVariation };
    const bindings = {
        ...blockBindings({ mode, feature, generatedFeatures, pieces }, window, document),
        confirmBlockSizeIfOversized: async () => true,
        setBlockifyInfo: (key, fallback) => infos.push(key || fallback),
        setPendingBuildingProposalContext: context => contexts.push(clone(context)),
        closeBlockifyModal: () => {}, updateStatus: () => {}, translateBuildingText: (_key, fallback) => fallback
    };
    const source = functionSources('../../frontend/js/building-blocks.js').get('saveBlockifyDesignForProposal');
    const context = vm.createContext(bindings);
    vm.runInContext(`${source}\nthis.__run = saveBlockifyDesignForProposal;`, context);
    await context.__run();
    return { context: contexts[0] || null, infos };
}

function rowAutosave(feature) {
    const saved = [];
    const site = rect(15.999, 44.999, 16.001, 45.001, { id: 'free-site' });
    const block = { parcels: [{ id: '__placement-site__', feature: site }], syntheticSite: true, site, generatorSite: site };
    const window = {
        UrbanRuleVariation,
        getActiveProposalDesignDraft: () => ({ adapterKey: 'row' }),
        syncActiveProposalDraftFromEditor: (...args) => saved.push(clone(args))
    };
    const bindings = {
        window, generatedRowHouseFeature: feature, getActiveRowHouseBlock: () => block,
        cloneRowHouseFeature: clone, getRowHouseDisplayName: () => 'test row',
        currentRowRule: () => rule('row', 'range'), rowVariationSeed: 991,
        currentBuildingLength: 40, currentBuildingWidth: 10, currentBuildingHeight: 17.5,
        currentChamfer: 0, currentOffsetX: 0, currentOffsetY: 0, currentRotation: 0,
        rowHouseManualMode: true, rowHouseBlock: block, cachedSuperparcel: site,
        rowHouseSurroundings: null, turf
    };
    // The autosave records the Row's site through rowHouseSiteBoundary, so it runs with it.
    const functions = functionSources('../../frontend/js/row-house.js');
    const source = `${functions.get('rowHouseSiteBoundary')}\n${functions.get('autosaveRowHouseDraft')}`;
    runFunction(source, 'autosaveRowHouseDraft', bindings);
    return saved[0]?.[1] || null;
}

describe('block and row massing persistence', () => {
    it('stamps a cloned complete massing feature with the current rule, seed, and only its current minimum', () => {
        const source = rect(16, 45, 16.001, 45.001, {
            label: 'authored outline', massing: false, height: 2, variationSeed: 3,
            urbanRule: { typology: 'row', kind: 'exact' }, minFootprint: { type: 'Polygon', coordinates: [] }
        });
        const input = clone(source);
        const stamped = UrbanRuleVariation.massingWithRule(input, rule('block', 'range'), 731, { turf });
        expect(stamped).not.toBe(input);
        expect(stamped.geometry).toEqual(input.geometry); // preserve courtyard and entire authored ring
        expect(stamped.properties).toMatchObject({ label: 'authored outline', massing: true, height: 17.5, variationSeed: 731 });
        expect(stamped.properties.urbanRule).toEqual(rule('block', 'range'));
        expect(stamped.properties.minFootprint).toBeTruthy();
        expect(input).toEqual(source);

        const exact = UrbanRuleVariation.massingWithRule(source, rule('row', 'exact'), 992, { turf });
        expect(exact.geometry).toEqual(source.geometry);
        expect(exact.properties).toMatchObject({ massing: true, height: 17.5, variationSeed: 992 });
        expect(exact.properties.urbanRule).toEqual(rule('row', 'exact'));
        expect(exact.properties).not.toHaveProperty('minFootprint');
    });

    it('autosaves a block as its per-parcel pieces beside the complete massing, a row as its complete massing, and both render salted build-outs', () => {
        const source = rect(16, 45, 16.001, 45.001, { label: 'whole authored footprint' });
        const pieces = blockPieces(source);
        expect(pieces.length).toBeGreaterThan(0);
        const blockDraft = blockAutosave({ feature: source, pieces });
        expect(blockDraft.buildings).toEqual(pieces);
        expect(blockDraft.buildingFeature).toEqual(pieces[0]);
        expect(pieces[0].properties).toMatchObject({ massing: true, height: 17.5, variationSeed: UrbanRuleVariation.hashSeed(731, '__placement-site__') });
        const blockMassing = blockDraft.blockMassing;
        expect(blockMassing.geometry).toEqual(source.geometry);
        expect(blockMassing.properties).toMatchObject({ massing: true, height: 17.5, variationSeed: 731 });
        expect(blockMassing.properties.urbanRule).toEqual(rule('block', 'range'));
        expect(blockMassing).not.toEqual(pieces[0]);

        const rowDraft = rowAutosave(source);
        const rowMassing = rowDraft.buildingFeature;
        expect(rowMassing.geometry).toEqual(source.geometry);
        expect(rowMassing.properties).toMatchObject({ massing: true, height: 17.5, variationSeed: 991 });
        expect(rowMassing.properties.urbanRule).toEqual(rule('row', 'range'));
        expect(rowDraft.buildings).toEqual([rowDraft.buildingFeature]);

        for (const massing of [blockMassing, pieces[0], rowMassing]) {
            const heights = new Set(Array.from({ length: 32 }, (_, salt) =>
                UrbanRuleVariation.plannedDrawPlan(massing, 'buildout', { turf }, salt).buildOut.properties.height));
            expect(heights.size).toBeGreaterThan(1);
        }
    });

    it('keeps existing-building autosaves raw and restores their source-aware site', () => {
        const first = rect(16, 45, 16.0002, 45.0002, { source: 'survey', height: 4, manual: true });
        const second = rect(16.0003, 45, 16.0005, 45.0002, { source: 'survey', height: 6, manual: true });
        const saved = blockAutosave({ mode: 'existing', feature: null, generatedFeatures: [first, second] });
        expect(saved.buildings).toEqual([first, second]);
        expect(saved.buildingFeature).toEqual(first);
        expect(saved).not.toHaveProperty('blockMassing');
        expect(saved.buildingFeature.properties).not.toHaveProperty('massing');
        expect(saved.buildingFeature.properties).not.toHaveProperty('urbanRule');
        expect(saved.placement).toMatchObject({ free: false });
        expect(saved.placement.site.geometry.type).toBe('Polygon');
    });

    it('Done saves the same per-parcel pieces and complete massing the editor drew, and refuses a block with no pieces', async () => {
        const source = rect(16, 45, 16.001, 45.001, { label: 'whole authored footprint' });
        const pieces = blockPieces(source);
        const done = await blockDone({ feature: source, pieces });
        expect(done.context.buildings).toEqual(pieces);
        expect(done.context.buildingFeature).toEqual(pieces[0]);
        expect(done.context.blockMassing.geometry).toEqual(source.geometry);
        expect(done.context.blockMassing.properties).toMatchObject({ massing: true, height: 17.5, variationSeed: 731 });
        expect(done.context.parameters).toMatchObject({ mode: 'manual', typology: 'block', seed: 731 });
        // Each piece realizes its own height from its own seed: what Done saves is what 3D draws.
        const realized = pieces.map(piece => UrbanRuleVariation.realizeFeature(piece, { turf }));
        expect(realized.every(house => house.properties.height <= 17.5)).toBe(true);

        const refused = await blockDone({ feature: source, pieces: [] });
        expect(refused.context).toBeNull();
        expect(refused.infos).toEqual(['blockify.modal.messages.generateBeforeFinishing']);
    });

    it('Done in existing-buildings mode saves the raised buildings raw, with no massing', async () => {
        const first = rect(16, 45, 16.0002, 45.0002, { source: 'survey', height: 4, manual: true });
        const done = await blockDone({ mode: 'existing', feature: null, generatedFeatures: [first] });
        expect(done.context.buildings).toEqual([first]);
        expect(done.context).not.toHaveProperty('blockMassing');
        expect(done.context.parameters).toMatchObject({ mode: 'existing', typology: 'block' });
    });
});
