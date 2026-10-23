// Rebuilds the reported large-parcel Block from its small source polygon using the same Turf and
// blockRingOutline implementation as the editor. The source coordinates are public; its parcel
// identifiers and other cadastral properties have been replaced with a neutral test identifier.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const footprint = require('../../../frontend/js/footprint-geometry.js');
const urbanRules = require('../../../frontend/js/urban-rule-variation.js');
const sourcePath = new URL('../fixtures/large-block-source.json', import.meta.url);
const sourceFeature = JSON.parse(readFileSync(fileURLToPath(sourcePath), 'utf8'));

let ringGenerator;

function loadRingGenerator() {
    if (ringGenerator) return ringGenerator;

    // building-blocks.js is a classic browser script; isolate it so fixture generation does not
    // replace the test runner's browser globals.
    const noop = () => {};
    const element = {
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, value: '', checked: false, disabled: false,
        addEventListener: noop, removeEventListener: noop, setAttribute: noop,
        appendChild: noop, remove: noop, querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 })
    };
    const documentStub = {
        getElementById: () => element, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => ({ ...element }), addEventListener: noop
    };
    const windowStub = {
        document: documentStub, addEventListener: noop, removeEventListener: noop,
        confirm: () => true, UrbanRuleVariation: urbanRules
    };
    const leafletStub = {
        geoJSON: () => ({ addTo() { return this; }, on: noop, bindTooltip() { return this; } }),
        polygon: () => ({ addTo() { return this; }, on: noop }), polyline: () => ({ addTo() { return this; } }),
        marker: () => ({ addTo() { return this; } }), layerGroup: () => ({ addTo() { return this; }, clearLayers: noop }),
        featureGroup: () => ({ addTo() { return this; } }), divIcon: () => ({})
    };
    const source = readFileSync(new URL('../../../frontend/js/building-blocks.js', import.meta.url), 'utf8');
    const context = {
        ...footprint, turf, document: documentStub, window: windowStub, L: leafletStub,
        highlightBlock: noop, UrbanRuleVariation: urbanRules, console,
        setTimeout: noop, clearTimeout: noop
    };
    runInNewContext(`${source}\nglobalThis.__largeBlockRingOutline = blockRingOutline;`, context);
    ringGenerator = context.__largeBlockRingOutline;
    return ringGenerator;
}

const clone = value => JSON.parse(JSON.stringify(value));
const closeRing = ring => {
    const coordinates = ring.slice();
    const first = coordinates[0], last = coordinates[coordinates.length - 1];
    if (!last || first[0] !== last[0] || first[1] !== last[1]) coordinates.push(first);
    return coordinates;
};

/**
 * Build the real large Block feature and a design-shaped publication candidate.
 * Defaults match the editor: 2 m setback, 15 m width, no simplification/chamfer/gaps,
 * and an exact 17.5 m block rule. The seed is fixed so the fixture is reproducible.
 */
export function generateLargeBlockFixture() {
    const previousTurf = globalThis.turf;
    globalThis.turf = turf;
    try {
        const generator = loadRingGenerator();
        const union = footprint.robustUnion([sourceFeature]);
        const parcel = footprint.toSingleLargestPolygon(footprint.sanitizePolygonFeature(union) || union);
        const ring = generator(parcel, parcel, { setback: 2, width: 15, simplifyM: 0 });
        if (!ring?.outer?.geometry || !ring?.inner?.geometry) throw new Error('The source parcel did not produce a courtyard Block outline.');

        const feature = {
            type: 'Feature',
            properties: {
                type: 'proposedBuilding', width: ring.widthAchieved, setback: 2, chamfer: 0,
                simplify: 0, block: 'QA Large Block', minSideLength: ring.minSideLength,
                height: 17.5, numGaps: 0, gapWidth: 5
            },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    closeRing(ring.outer.geometry.coordinates[0]),
                    closeRing(ring.inner.geometry.coordinates[0]).reverse()
                ]
            }
        };
        const rule = {
            typology: 'block', kind: 'exact', maxHeightM: 17.5, minHeightM: 17.5,
            minDepthM: 0, floorHeightM: 3.5, minPlotAreaM2: 50, minPieceAreaM2: 25
        };
        const massing = urbanRules.massingWithRule(feature, rule, 2157717150, { turf });
        const design = {
            schema: 'design/v1', goal: 'buildings', title: 'QA Large Block', description: null,
            author: null, city: null, site: null, toleranceM: null,
            geometry: { buildings: [clone(massing)], blockMassing: clone(massing) },
            origin: null, authoredAt: '2026-10-23T00:00:00.000Z',
            buildingProposal: {
                blockName: 'QA Large Block',
                typologyType: 'block',
                parameters: { mode: 'parametric', typology: 'block', width: 15, height: 17.5, setback: 2, chamfer: 0, simplify: 0, gaps: [], wings: [], seed: 2157717150, rule }
            }
        };
        return { source: clone(sourceFeature), parcel, ring, feature, massing, design };
    } finally {
        if (previousTurf === undefined) delete globalThis.turf;
        else globalThis.turf = previousTurf;
    }
}
