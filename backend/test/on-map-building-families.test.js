import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const rowHouse = readFileSync(new URL('../../frontend/js/row-house.js', import.meta.url), 'utf8');
const parcelBased = readFileSync(new URL('../../frontend/js/parcel-based.js', import.meta.url), 'utf8');

function editorOpenOptions(source, owner, id) {
    const start = Math.max(source.indexOf('window.OnMapEditor.open({'), source.indexOf('window.OnMapEditor?.open({'));
    expect(start).toBeGreaterThanOrEqual(0);
    const options = source.slice(start, source.indexOf('});', start));
    expect(options).toContain(`owner: '${owner}'`);
    expect(options).toContain(`id: '${id}'`);
    expect(options).toContain("modes: ['2d', 'model']");
    expect(options).toContain('content,');
    expect(options).toContain('footer,');
    expect(options).toContain('onCancel:');
}

function loadOpenApi(source, entryName, editorOpen) {
    const polygon = {
        type: 'Feature',
        properties: { id: 'parcel-1' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] }
    };
    const window = {
        OnMapEditor: { open: editorOpen },
        BuildingDensityStats: { cardMarkup: () => '' },
        resolveDesignParcelFeature: id => id === 'parcel-1' ? polygon : null
    };
    const footer = { classList: { classes: new Set(['cb-dialog__footer']), remove(name) { this.classes.delete(name); } } };
    const document = {
        createElement: () => ({ querySelector: selector => selector === '#rowhouse-controls' || selector === '#parcelbased-controls' ? footer : ({}) }),
        getElementById: () => null,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {}
    };
    const CbFormat = { formatNumber: value => String(value), formatLength: value => `${value} m` };
    runInNewContext(source, { window, document, CbFormat, console: { log() {}, warn() {}, error() {} }, Math, setTimeout, clearTimeout });
    return { open: window[entryName], footer };
}

describe('floating building-family editors', () => {
    it('uses a shared map session and leaves the main map lifecycle to the helper', () => {
        editorOpenOptions(rowHouse, 'row-house', 'rowhouse');
        editorOpenOptions(parcelBased, 'parcel-based', 'parcelbased');

        for (const source of [rowHouse, parcelBased]) {
            expect(source).toMatch(/\w+Map = \w+Modal\.map;/);
            expect(source).toMatch(/editorSession\?\.close\(\);/);
            expect(source).not.toMatch(/\bL\.map\s*\(/);
            expect(source).not.toMatch(/\w+Map\.remove\s*\(/);
            expect(source).not.toMatch(/init\w+3D|dispose\w+3D|update\w+3DScene/);
        }
    });

    it('publishes the example build-out independently from permitted massing and exclusions', () => {
        expect(rowHouse).toContain("draftPreview: { kind: 'buildings', features: rowBuildOut }");
        expect(rowHouse).toContain("boundary: rowHouseBlock?.site || cachedSuperparcel");
        expect(rowHouse).toContain("envelopes: rowRuleKind === 'exact' ? [] : rowUnits");
        expect(rowHouse).toContain("excluded: rowExcluded.filter(entry => entry?.feature?.geometry).map(entry => entry.feature)");

        expect(parcelBased).toContain("draftPreview: { kind: 'buildings', features: houses }");
        expect(parcelBased).toContain('boundary: parcelBasedBoundary');
        expect(parcelBased).toContain("envelopes: currentRuleKind === 'exact' ? [] : envelopes");
        expect(parcelBased).toContain(".filter(entry => entry?.feature?.geometry).map(entry => entry.feature)");
        expect(parcelBased).toContain('updateBuildingMetrics(envelopes, houses)');
    });

    it('uses an authored site as the editor boundary while retaining per-parcel inputs', () => {
        expect(rowHouse).toContain('initialFeature = null, site = null');
        expect(rowHouse).toContain('site: authoredSite');
        expect(rowHouse).toContain('function rowHouseGeneratorSite(block)');
        expect(rowHouse.match(/let superparcel = rowHouseGeneratorSite\(block\) \|\| robustUnionLocal\(parcelFeatures\);/g)).toHaveLength(2);
        expect(rowHouse).not.toContain('placementBaseSite');
        expect(rowHouse).toContain('fitFeature(block.site?.geometry ? block.site : featureCollection');

        expect(parcelBased).toContain('initialParameters = null, site = null');
        expect(parcelBased).toContain('parcelBasedSiteFeature(features, block.site)');
        expect(parcelBased).toContain('site: site?.geometry ? {');
        expect(parcelBased).toContain('parcels: liveParcels');
    });

    it('keeps each family’s editing controls and close/save semantics', () => {
        for (const id of [
            'rowhouse-ruletype-select', 'rowhouse-minheight-slider', 'rowhouse-minplot-slider',
            'rowhouse-length-slider', 'rowhouse-width-slider', 'rowhouse-height-slider',
            'rowhouse-chamfer-slider', 'rowhouse-rotate-counterclockwise',
            'rowhouse-rotate-clockwise', 'rowhouse-geojson-upload', 'btn-rowhouse-regenerate'
        ]) expect(rowHouse).toContain(id);

        for (const id of [
            'parcelbased-ruletype-select', 'parcelbased-maxfloors-slider',
            'parcelbased-mindistance-slider', 'parcelbased-minfloors-slider',
            'parcelbased-minfootprint-slider', 'parcelbased-minplot-slider',
            'btn-parcelbased-regenerate'
        ]) expect(parcelBased).toContain(id);

        expect(rowHouse).toContain('window.discardProposalDraftDesignSession?.()');
        expect(rowHouse).toContain('saveRowHouseDesignForProposal');
        expect(parcelBased).toContain('window.discardProposalDraftDesignSession?.()');
        expect(parcelBased).toContain('saveParcelBasedDesignForProposal');

        expect(rowHouse).toContain("const rotationTools = container.querySelector('.single-building-rotation-buttons')");
        expect(rowHouse).toContain('tools: rotationTools');
        expect(rowHouse).toContain("setAttribute('role', 'toolbar')");
        // The header's × is the only cancel: no footer Cancel repeats it.
        expect(rowHouse).toContain('onCancel: requestCloseRowHouseModal');
        expect(rowHouse).not.toContain('btn-rowhouse-cancel');
        expect(parcelBased).toContain('onCancel: requestCloseParcelBasedModal');
        expect(parcelBased).not.toContain('btn-parcelbased-cancel');
    });

    it('saves a row as its houses beside the full bar, and a block massing, on their own site, never as a free placement', () => {
        // Both autosave and Done save the per-plot houses the editor drew beside the whole terrace.
        expect(rowHouse.split('generatedRowHouseFeature, rowUnits, currentRowRule(), rowVariationSeed, { turf })').length - 1).toBe(2);
        expect(rowHouse).toContain('placement: { free: false, site: cloneRowHouseFeature(rowHouseSiteBoundary()) }');
        expect(rowHouse).not.toContain('free: true');
        expect(rowHouse).toContain("manualMode: rowHouseManualMode");
        expect(rowHouse).toContain('if (rowHouseBlock?.syntheticSite || !fitsParcelUnion)');

        const blockEditor = readFileSync(new URL('../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
        const saveStart = blockEditor.indexOf('async function saveBlockifyDesignForProposal()');
        const saveEnd = blockEditor.indexOf('// DEPRECATED: createProposalWithBuilding', saveStart);
        expect(saveStart).toBeGreaterThanOrEqual(0);
        expect(saveEnd).toBeGreaterThan(saveStart);

        const feature = {
            type: 'Feature',
            properties: { typology: 'block', edited: true },
            geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 2], [3, 4], [1, 2]]] }
        };
        let savedContext = null;
        const sandbox = {
            window: { UrbanRuleVariation: { ruleDesignGeometry: (value, pieces) => ({ buildings: JSON.parse(JSON.stringify(pieces)), ruleMassing: JSON.parse(JSON.stringify(value)) }) } },
            generatedBuildingFeature: feature,
            generatedBuildingFeatures: null,
            blockMassingPieces: [{ ...feature, properties: { ...feature.properties, parcelId: 'plot-1' } }],
            setBlockifyInfo() {},
            blockifyMode: 'parametric',
            blockifyVariationSeed: 7,
            currentBuildingWidth: 16,
            currentBuildingHeight: 12,
            currentSetback: 0,
            currentChamferM: 0,
            currentSimplifyM: 0,
            currentProposedHeightFloors: 4,
            currentAdditionalFloors: 0,
            currentFloorHeightM: 3,
            gapPositions: [],
            wingPositions: [],
            currentGapWidth: 5,
            currentWingLength: 10,
            manualOuterRing: null,
            blockExcludedParcels: [],
            blockVariationSeed: 7,
            blockifyGenerationSite: feature,
            blockifySurroundings: null,
            turf: {},
            multiParcelSelection: { selectedParcels: new Set(), updateUI() {}, clearSelection() {} },
            document: { getElementById: () => null },
            confirmBlockSizeIfOversized: async () => true,
            getActiveBlockifyBlock: () => ({ syntheticSite: true, parcels: [{}], site: feature }),
            blockifyDesignBoundary: () => feature,
            blockifyClone: value => JSON.parse(JSON.stringify(value)),
            currentBlockRule: () => ({ kind: 'exact' }),
            getBlockifyDisplayName: () => 'Test block',
            setPendingBuildingProposalContext: value => { savedContext = value; },
            closeBlockifyModal() {},
            translateBuildingText: (_key, fallback) => fallback,
            console
        };
        const saveFunction = blockEditor.slice(saveStart, saveEnd);
        runInNewContext(`${saveFunction}\nthis.save = saveBlockifyDesignForProposal;`, sandbox);

        return sandbox.save().then(() => {
            expect(savedContext.buildings).toHaveLength(1);
            expect(savedContext.buildings[0].geometry).toEqual(feature.geometry);
            expect(savedContext.buildings[0].properties.parcelId).toBe('plot-1');
            expect(savedContext.ruleMassing.geometry).toEqual(feature.geometry);
            expect(savedContext.placement.site.geometry).toEqual(feature.geometry);
            expect(savedContext.placement.free).toBe(false);
        });
    });

    it.each([
        ['row house', rowHouse, 'openRowHouseForParcels'],
        ['detached-house', parcelBased, 'openParcelBasedForParcels']
    ])('%s API reports invalid selections and a refused shared-editor open as false', (_, source, entryName) => {
        const editorOpen = vi.fn(() => null);
        const { open, footer } = loadOpenApi(source, entryName, editorOpen);

        expect(open({ parcelIds: [] })).toBe(false);
        expect(open({ parcelIds: ['unresolved'] })).toBe(false);
        expect(open({ parcelIds: ['parcel-1'] })).toBe(false);
        expect(editorOpen).toHaveBeenCalledTimes(1);
        expect(footer.classList.classes.has('cb-dialog__footer')).toBe(false);
    });
});
