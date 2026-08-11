// A block authored on seven parcels applying to four, with nothing saying which three got nothing.
//
// The urban-rule editor leaves parcels out for three documented reasons — smaller than the minimum
// plot size, only a splinter of the block on them, or the massing never reaches them — and the split
// engine reports each one. The editor then dropped the third kind on the floor twice over: it was
// filtered out of the count, and skipped when drawing the excluded parcels. A plot the ring does not
// reach is exactly the one at the EDGE of a block, so an applied block quietly missed its edges and
// the editor showed a full block.
//
// The console said it plainly and only there: "showBlockifyModal ... with 7 parcels" followed by
// "[_applyBuildingProposal] Resolved 4 live parcel(s) from geometry". The apply resolves participants
// from the BUILDING geometry, so a parcel with no massing on it is not a participant — correct, and
// invisible until now.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const variation = require('../../frontend/js/urban-rule-variation.js');
const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const buildingBlocks = read('../../frontend/js/building-blocks.js');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));
const locales = ['en', 'hr', 'sr', 'es'];

// Metres → degrees at Šibenik's latitude, near enough for a fixture.
const M = 1 / 111320;
const rect = (x0, y0, w, h) => turf.polygon([[
    [15.89 + x0 * M, 43.73 + y0 * M],
    [15.89 + (x0 + w) * M, 43.73 + y0 * M],
    [15.89 + (x0 + w) * M, 43.73 + (y0 + h) * M],
    [15.89 + x0 * M, 43.73 + (y0 + h) * M],
    [15.89 + x0 * M, 43.73 + y0 * M]
]]);

describe('what the split engine reports', () => {
    // A block 60 m wide; the massing covers only its left 20 m, so the right-hand plot is untouched.
    const massing = rect(0, 0, 20, 40);
    const parcels = [
        { parcelId: 'ON-THE-RING', feature: rect(0, 0, 20, 40) },
        { parcelId: 'AT-THE-EDGE', feature: rect(40, 0, 20, 40) },
        { parcelId: 'TOO-SMALL', feature: rect(0, 45, 4, 4) }
    ];

    it('names the plot the massing never reaches, rather than dropping it', () => {
        const { pieces, excluded } = variation.splitMassingByParcels(
            massing, parcels, { minPlotAreaM2: 50 }, 1, { turf });
        expect(pieces.map(p => p.properties.parcelId)).toEqual(['ON-THE-RING']);
        const byId = Object.fromEntries(excluded.map(e => [e.parcelId, e.status]));
        expect(byId['AT-THE-EDGE']).toBe('no-massing-here');
        expect(byId['TOO-SMALL']).toBe('below-min-plot');
    });

    it('reports what a too-small plot WOULD carry, so it reads as ineligible and not as a hole', () => {
        // A plot under the minimum that the massing does cover: merge it with a neighbour and this
        // is the building it takes. The shape has to survive the exclusion to be able to say that.
        const overlapped = [{ parcelId: 'SMALL-BUT-COVERED', feature: rect(2, 2, 5, 5) }];
        const { pieces, excluded } = variation.splitMassingByParcels(
            massing, overlapped, { minPlotAreaM2: 50 }, 1, { turf });
        expect(pieces).toHaveLength(0);
        expect(excluded[0].status).toBe('below-min-plot');
        expect(excluded[0].wouldBe, 'the would-be massing was discarded').toBeTruthy();
        expect(turf.area({ type: 'Feature', properties: {}, geometry: excluded[0].wouldBe }))
            .toBeGreaterThan(1);
    });

    it('has nothing to show where the massing never reaches', () => {
        const { excluded } = variation.splitMassingByParcels(
            massing, [{ parcelId: 'AT-THE-EDGE', feature: rect(40, 0, 20, 40) }], { minPlotAreaM2: 0 }, 1, { turf });
        expect(excluded[0].status).toBe('no-massing-here');
        expect(excluded[0].wouldBe).toBeNull();
    });
});

describe('what the editor says about it', () => {
    const report = buildingBlocks.slice(
        buildingBlocks.indexOf('function reportBlockRuleRange()'),
        buildingBlocks.indexOf('function syncBlockMinHeightSlider()')
    );

    it('counts every excluded parcel, including the ones with no massing', () => {
        expect(report).toContain('const excluded = blockExcludedParcels.length;');
        // The old count filtered exactly the kind that lands at a block's edge.
        expect(report).not.toContain("filter(entry => entry.status !== 'no-massing-here')");
    });

    it('actually shows the count — the parameter used to be computed and then ignored', () => {
        ['rangeExactExcluded', 'rangeBetweenExcluded', 'rangeMaxExcluded'].forEach(key => {
            expect(report).toContain(key);
        });
        expect(report).toContain('{{excluded}} parcel(s) left out');
    });

    it('draws every excluded parcel on the editor map', () => {
        // Search for the end FROM the start — updateBlockify3DScene appears earlier in the file too,
        // and indexOf from zero produces an empty slice that matches nothing.
        const start = buildingBlocks.indexOf('blockExcludedParcels.forEach(entry => {');
        expect(start, 'the excluded-parcel drawing loop not found').toBeGreaterThan(-1);
        const draw = buildingBlocks.slice(start, buildingBlocks.indexOf('updateBlockify3DScene(', start));
        expect(draw).toContain('if (!entry || !entry.feature) return;');
        expect(draw).not.toContain("entry.status === 'no-massing-here'");
    });

    it('continues the block outline across a left-out plot, dashed', () => {
        const start = buildingBlocks.indexOf('blockExcludedParcels.forEach(entry => {');
        const draw = buildingBlocks.slice(start, buildingBlocks.indexOf('updateBlockify3DScene(', start));
        expect(draw).toContain('if (!entry.wouldBe) return;');
        expect(draw).toContain("dashArray: '6, 4'");
    });

    it('shows it in 3D as a see-through volume, never as a building', () => {
        expect(buildingBlocks).toContain('function blockIneligibleGhosts()');
        expect(buildingBlocks).toContain('ineligible: true');
        expect(buildingBlocks).toContain('blockBuildOut.concat(blockIneligibleGhosts())');
        // A ghost must not be shaded like an owned building.
        expect(buildingBlocks).toContain('props.ineligible\n            ? [ineligibleMat, ineligibleMat]');
        // ...and it is never saved: only pieces are.
        const save = buildingBlocks.slice(buildingBlocks.indexOf('async function saveBlockifyDesignForProposal()'));
        expect(save).not.toContain('blockIneligibleGhosts');
    });

    it('has a reason to show for each of the three exclusions', () => {
        const reason = buildingBlocks.slice(
            buildingBlocks.indexOf('function blockExclusionReason(status)'),
            buildingBlocks.indexOf('// Draw a draggable handle')
        );
        expect(reason).toContain('excludedBelowMinPlot');
        expect(reason).toContain('excludedNoMassing');
        expect(reason).toContain('excludedSliver');
    });
});

// The editor closes; the plots it left out must still be explicable. They travel on the record so
// the 3D view can draw them, behind a toggle that is off until someone asks.
describe('carried into the applied plan', () => {
    const adapters = read('../../frontend/js/proposal-editor-adapters.js');
    const threeMode = read('../../frontend/js/three-mode.js');
    const mapCss = read('../../frontend/css/map.css');

    it('saves the left-out plots with the design', () => {
        const save = buildingBlocks.slice(buildingBlocks.indexOf('async function saveBlockifyDesignForProposal()'));
        expect(save).toContain('const ineligibleParcels = blockExcludedParcels.map(');
        expect(save).toContain('wouldBe: entry.wouldBe ?');
        expect(save).toContain('ineligibleParcels,');
    });

    it('serializes them onto the proposal record', () => {
        expect(adapters).toContain('ineligibleParcels: clone(context.ineligibleParcels || [])');
    });

    const collect = buildingBlocks.slice(
        buildingBlocks.indexOf('function appliedIneligibleBlockParts('),
        buildingBlocks.indexOf("// One proposal's buildings, in their own sub-layer.")
    );

    it('collects them from applied records, in one place both views read', () => {
        expect(collect).toContain('bp.ineligibleParcels');
        expect(collect).toContain('if (!record || !standing(record)) return;');
        expect(collect).toContain('window.appliedIneligibleBlockParts = appliedIneligibleBlockParts');
    });

    it('marks the PLOT as well as the building it would carry', () => {
        // The plot outline is what stops a left-out parcel reading as empty ground, and it is
        // derivable — parents minus the parcels that got a piece — so a block applied before any of
        // this was recorded still shows its left-out plots.
        expect(collect).toContain("kind: 'plot'");
        expect(collect).toContain("kind: 'massing'");
        expect(collect).toContain('.filter(id => !built.has(id))');
    });

    it('only derives it for rule-driven typologies', () => {
        // A freeform building over one of two selected parcels leaves the other alone on purpose.
        expect(collect).toContain("RULE_TYPOLOGIES = new Set(['block', 'row', 'parcelBased', 'parcelbased'])");
        expect(collect).toContain('RULE_TYPOLOGIES.has(String(bp.typologyType || \'\'))');
    });

    it('draws them on the 2D map — hatched plot, dashed massing — even when the rule built nothing', () => {
        const layer = buildingBlocks.slice(
            buildingBlocks.indexOf("// One proposal's buildings, in their own sub-layer."),
            buildingBlocks.indexOf('function showBlockifyModal()')
        );
        // Drawn with the proposal that owns them, so an apply costs its own parts and no one else's.
        expect(layer).toContain('appliedIneligibleBlockParts(id).forEach(part => {');
        expect(layer).toContain("part.properties.kind === 'plot'");
        expect(layer).toContain("dashArray: '2, 5'");   // the plot
        expect(layer).toContain("dashArray: '6, 4'");   // the building it would carry
        // A rule that built nothing still shows its plots: the parts are drawn before, and
        // independently of, whether this proposal contributed any buildings.
        expect(layer.indexOf('appliedIneligibleBlockParts(id)'))
            .toBeLessThan(layer.indexOf('const list = ensureProposedBuildingsState();'));
    });

    it('restricts the walk to one record when only one proposal is being drawn', () => {
        // Without this, drawing one proposal still costs every applied proposal on the map.
        expect(collect).toContain("if (wanted !== null && String(record.proposalId ?? '') !== wanted) return;");
    });

    it('raises only the massing in 3D, never the plot outline', () => {
        const build = threeMode.slice(
            threeMode.indexOf('function buildIneligibleParcels3D(targetGroup)'),
            threeMode.indexOf('// Cache of parsed glTF scenes')
        );
        expect(build).toContain('window.appliedIneligibleBlockParts()');
        expect(build).toContain("if (feature.properties && feature.properties.kind === 'plot') return;");
        expect(build).toContain('buildingMaterials.massing');
    });

    it('is off in 3D until the toggle is ticked — the 2D map always shows them', () => {
        expect(threeMode).toContain('let showIneligibleParcels = false;');
        expect(threeMode).toContain('if (showIneligibleParcels) buildIneligibleParcels3D(buildingGroup);');
        expect(threeMode).toContain("threeI18n('threeMode.controls.ineligibleParcels', 'Non-buildable plots')");
        // Its own full-width row: sharing one with a dropdown squeezed the label into two lines.
        expect(threeMode).toContain('three-mode-trees-row three-mode-wide-row');
        expect(mapCss).toContain('#three-container .three-mode-wide-toggle {');
    });

    it.each(locales)('%s names the toggle', locale => {
        expect(dictOf(locale).threeMode.controls.ineligibleParcels, `${locale} missing the toggle label`).toBeTruthy();
    });
});

describe('every locale can say it', () => {
    it.each(locales)('%s has the excluded-parcel strings', locale => {
        const messages = dictOf(locale).blockify.modal.messages;
        ['rangeExactExcluded', 'rangeBetweenExcluded', 'rangeMaxExcluded', 'excludedNoMassing']
            .forEach(key => expect(messages[key], `${locale} missing ${key}`).toBeTruthy());
        expect(messages.rangeExactExcluded).toContain('{{excluded}}');
    });
});
