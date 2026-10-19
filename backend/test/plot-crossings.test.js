// The road tool's "Build through" prompt for subdivision/readjustment plots (PARCEL-OPTIONAL.md
// phase 7b): which plots an edge would cut (count and area per proposal), which standing proposal
// buildings it would run through — on a plot or on cadastral parcels, refused at apply either way, so
// warned up front with no Build through — and the browser glue in corridor-structures.js (approvals
// per drawing session, refusal never approvable).
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const plots = require('../../frontend/js/proposals/plot-crossings.js');

const LON = 139.7;
const LAT = 35.68;
const U = 0.0001; // ≈ 9 m east–west, 11 m north–south here
const rect = (x0, y0, x1, y1) => ({
    type: 'Polygon',
    coordinates: [[[LON + x0 * U, LAT + y0 * U], [LON + x1 * U, LAT + y0 * U], [LON + x1 * U, LAT + y1 * U], [LON + x0 * U, LAT + y1 * U], [LON + x0 * U, LAT + y0 * U]]]
});
const piece = (id, producer, geometry) => ({ type: 'Feature', properties: { parcelId: id, producedByProposalId: producer }, geometry });
const multi = polygon => ({ type: 'MultiPolygon', coordinates: [polygon.coordinates] });

// A subdivision of a 12 × 6 site into four plots, a readjustment beside it, a park.
const SUB = { proposalId: 'sub', title: 'Subdivide Tokyo', site: multi(rect(0, 0, 12, 6)), reparcellization: { poolSource: 'site', polygons: [] } };
const READJ = { proposalId: 'readj', title: 'Readjust 12/3', reparcellization: { polygons: [{ type: 'Feature', properties: {}, geometry: rect(12, 0, 18, 6) }] } };
const PARK = { proposalId: 'park', title: 'Park', structureProposal: {} };
const HOUSE = { proposalId: 'house', title: 'House', buildingProposal: {} };
const RECORDS = { sub: SUB, readj: READJ, park: PARK, house: HOUSE };
const lookup = id => RECORDS[id] || null;
const PIECES = [
    piece('sub-1', 'sub', rect(0, 0, 6, 3)), piece('sub-2', 'sub', rect(6, 0, 12, 3)),
    piece('sub-3', 'sub', rect(0, 3, 6, 6)), piece('sub-4', 'sub', rect(6, 3, 12, 6)),
    piece('readj-1', 'readj', rect(12, 0, 18, 6)),
    piece('park-1', 'park', rect(0, 6, 12, 9)),
    piece('HR-1-1', null, rect(0, -3, 18, 0))
];
const houseOn = geometry => ({ type: 'Feature', properties: { proposalId: 'house' }, geometry });

describe('detectPlotCrossings (pure)', () => {
    it('counts the plots an edge cuts per proposal, with the area it takes', () => {
        // North–south across sub-2/sub-4 and the park, not the readjustment.
        const road = rect(8, -3, 9, 9);
        const result = plots.detectPlotCrossings(road, { pieces: PIECES, buildings: [], lookupProposal: lookup, plotRecords: [SUB, READJ], turf });
        expect(result.blocked).toEqual([]);
        expect(result.plots).toHaveLength(1);
        const [hit] = result.plots;
        expect(hit).toMatchObject({ proposalId: 'sub', title: 'Subdivide Tokyo', kind: 'subdivision', count: 2 });
        const expected = turf.area(turf.intersect(turf.feature(road), turf.feature(rect(6, 0, 12, 6))));
        expect(hit.areaM2).toBeCloseTo(expected, -1);
    });

    it('lists every plot proposal crossed, readjustments as such, and skips parks and cadastral parcels', () => {
        const road = rect(-1, 1, 19, 2); // east–west through sub-1, sub-2 and the readjustment
        const result = plots.detectPlotCrossings(road, { pieces: PIECES, buildings: [], lookupProposal: lookup, plotRecords: [SUB, READJ], turf });
        expect(result.plots.map(entry => [entry.proposalId, entry.kind, entry.count])).toEqual([
            ['sub', 'subdivision', 2],
            ['readj', 'readjustment', 1]
        ]);
    });

    it('ignores kerf along an edge and plots already agreed to', () => {
        const grazing = rect(12, 0, 12.0005, 6); // a sliver along the shared edge, well under 1 m²
        expect(plots.detectPlotCrossings(grazing, { pieces: PIECES, lookupProposal: lookup, turf }).plots).toEqual([]);
        const road = rect(8, -3, 9, 9);
        expect(plots.detectPlotCrossings(road, { pieces: PIECES, lookupProposal: lookup, approvedIds: ['sub'], turf }).plots).toEqual([]);
    });

    it('says a house on a plot is in the way, and a building off every plot too', () => {
        const road = rect(8, -3, 9, 9);
        const onPlot = houseOn(rect(7.5, 4, 10, 5.5));
        const result = plots.detectPlotCrossings(road, { pieces: PIECES, buildings: [onPlot], lookupProposal: lookup, plotRecords: [SUB, READJ], turf });
        expect(result.blocked).toEqual([expect.objectContaining({ proposalId: 'house', title: 'House', plotProposalId: 'sub', plotTitle: 'Subdivide Tokyo' })]);
        expect(result.blocked[0].areaM2).toBeGreaterThan(1);
        // Beside the house: the plot is cut, nothing is blocked.
        const beside = plots.detectPlotCrossings(rect(10.5, -3, 11.5, 9), { pieces: PIECES, buildings: [onPlot], lookupProposal: lookup, plotRecords: [SUB], turf });
        expect(beside.blocked).toEqual([]);
        expect(beside.plots[0].count).toBe(2);
        // A building outside every plot record refuses the road just the same: named, no plot.
        const offPlot = houseOn(rect(30, 0, 32, 2));
        expect(plots.detectPlotCrossings(rect(30.5, -3, 31, 9), { pieces: PIECES, buildings: [offPlot], lookupProposal: lookup, plotRecords: [SUB, READJ], turf }).blocked)
            .toEqual([expect.objectContaining({ proposalId: 'house', title: 'House', plotProposalId: null, plotTitle: null })]);
        expect(plots.detectPlotCrossings(rect(33, -3, 34, 9), { pieces: PIECES, buildings: [offPlot], lookupProposal: lookup, plotRecords: [SUB, READJ], turf }).blocked).toEqual([]);
    });

    // Observed on HR-339318-5848/3: a road drawn along the parcel through the building of a Block
    // proposed on it. The block is on cadastral parcels, not a plot, so the edge used to pass here to
    // the tunnel prompt, which offered surface and tunnel — both refused when the road was finished.
    it('blocks the observed road through a block on a cadastral parcel', () => {
        const fixture = require('./fixtures/road-through-block-5848-3.json');
        const BLOCK = { proposalId: 'block', title: 'Block 0110-2207', goal: 'buildings', buildingProposal: {} };
        const building = { type: 'Feature', properties: { proposalId: 'block' }, geometry: fixture.blockBuilding };
        const parcelPiece = piece(fixture.parcelId, null, fixture.parcel);
        const result = plots.detectPlotCrossings(fixture.roadPolygon, {
            pieces: [parcelPiece], buildings: [building], lookupProposal: id => (id === 'block' ? BLOCK : null), plotRecords: [], turf
        });
        expect(result.plots).toEqual([]);
        expect(result.blocked).toEqual([expect.objectContaining({ proposalId: 'block', title: 'Block 0110-2207', plotTitle: null })]);
        expect(result.blocked[0].areaM2).toBeGreaterThan(10);
        const prompt = plots.plotCrossingPrompt(result, { corridorKind: 'road' });
        expect(prompt.message).toContain('It would run through a proposed building:\n• “Block 0110-2207”');
        expect(prompt.message).toContain('at surface or in a tunnel, so it would be refused');
        expect(prompt.choices).toEqual([{ value: 'cancel', label: 'Choose another route', primary: true }]);
        expect(prompt.blocked).toBe(true);
    });
});

describe('plotCrossingPrompt (pure)', () => {
    const result = { plots: [{ proposalId: 'sub', title: 'Subdivide Tokyo', kind: 'subdivision', count: 3, areaM2: 1234 }], blocked: [] };

    it('names each proposal with its plots and area and offers Build through / reroute', () => {
        const prompt = plots.plotCrossingPrompt(result, { corridorKind: 'road' });
        expect(prompt.message).toContain('This road would cut through plots of:');
        expect(prompt.message).toContain('“Subdivide Tokyo”: 3 plots, 1,234 m²');
        expect(prompt.message).toMatch(/Build through\?$/);
        expect(prompt.choices.map(choice => choice.value)).toEqual(['build', 'cancel']);
        expect(prompt.choices[0].primary).toBe(true);
        expect(prompt.blocked).toBe(false);
        expect(plots.plotCrossingPrompt({ ...result, plots: [{ ...result.plots[0], count: 1 }] }, { corridorKind: 'track' }).message)
            .toContain('This track would cut through plots of:\n• “Subdivide Tokyo”: 1 plot');
    });

    it('with a house in the way, warns up front and offers only another route', () => {
        const prompt = plots.plotCrossingPrompt({ ...result, blocked: [{ proposalId: 'house', title: 'House', plotTitle: 'Subdivide Tokyo', areaM2: 12 }] });
        expect(prompt.message).toContain('“House” on “Subdivide Tokyo”');
        expect(prompt.message).toContain('it would be refused');
        expect(prompt.message).not.toMatch(/Build through\?/);
        expect(prompt.choices).toEqual([{ value: 'cancel', label: 'Choose another route', primary: true }]);
        expect(prompt.blocked).toBe(true);
    });

    it('asks nothing when nothing is crossed, and translates through the given t', () => {
        expect(plots.plotCrossingPrompt({ plots: [], blocked: [] })).toBeNull();
        const t = vi.fn((key, fallback) => `[${key}]`);
        const prompt = plots.plotCrossingPrompt(result, { t });
        expect(prompt.message).toContain('[modal.corridorPlots.offer]');
        expect(t).toHaveBeenCalledWith('modal.corridorPlots.plotMany', '{{count}} plots', { count: 3 });
    });
});

describe('road tool glue (corridor-structures.js)', () => {
    const saved = {};
    const GLOBALS = ['turf', '__plotCrossings', 'LiveParcelFabric', 'proposalStorage', 'getProposalByIdOrHash',
        'isProposalApplied', 'corridorFeatureFromLatLngRing', 'showStyledChoice', 'i18n',
        'detectPlotCrossings', 'resolvePlotCrossings', 'resetApprovedStructureCrossings', 'detectStructureCrossings', 'resolveStructureCrossings'];
    let choice;

    beforeEach(() => {
        GLOBALS.forEach(name => { saved[name] = globalThis[name]; });
        Object.assign(globalThis, {
            turf,
            __plotCrossings: plots,
            LiveParcelFabric: { queryBounds: () => PIECES },
            proposalStorage: { getAllProposals: () => [SUB, READJ, PARK, HOUSE] },
            getProposalByIdOrHash: lookup,
            isProposalApplied: () => true,
            // The road tool hands a lat/lng ring; the fake returns the feature it stands for.
            corridorFeatureFromLatLngRing: ring => turf.feature(ring),
            showStyledChoice: vi.fn(async () => choice)
        });
        delete require.cache[require.resolve('../../frontend/js/corridor-structures.js')];
        require('../../frontend/js/corridor-structures.js');
    });
    afterEach(() => {
        GLOBALS.forEach(name => { if (saved[name] === undefined) delete globalThis[name]; else globalThis[name] = saved[name]; });
    });

    it('builds through once agreed, and does not ask again in the same drawing session', async () => {
        choice = 'build';
        const road = rect(8, -3, 9, 9);
        const first = globalThis.detectPlotCrossings(road, []);
        await expect(globalThis.resolvePlotCrossings(first, 'road')).resolves.toBe(true);
        expect(globalThis.showStyledChoice).toHaveBeenCalledTimes(1);
        expect(globalThis.showStyledChoice.mock.calls[0][0]).toContain('“Subdivide Tokyo”: 2 plots');
        const again = globalThis.detectPlotCrossings(road, []);
        expect(again.plots).toEqual([]);
        await expect(globalThis.resolvePlotCrossings(again, 'road')).resolves.toBe(true);
        expect(globalThis.showStyledChoice).toHaveBeenCalledTimes(1);
        globalThis.resetApprovedStructureCrossings();
        expect(globalThis.detectPlotCrossings(road, []).plots).toHaveLength(1);
    });

    it('reroutes on cancel, and never builds through a house on a plot', async () => {
        const road = rect(8, -3, 9, 9);
        choice = 'cancel';
        await expect(globalThis.resolvePlotCrossings(globalThis.detectPlotCrossings(road, []), 'road')).resolves.toBe(false);
        choice = 'build'; // even a stray "build" answer cannot pass a refusal
        const house = { id: 'proposal:house:0', feature: houseOn(rect(7.5, 4, 10, 5.5)) };
        const blocked = globalThis.detectPlotCrossings(road, [house]);
        expect(blocked.blocked).toHaveLength(1);
        await expect(globalThis.resolvePlotCrossings(blocked, 'road')).resolves.toBe(false);
        const [, choices] = globalThis.showStyledChoice.mock.calls.at(-1);
        expect(choices.map(entry => entry.value)).toEqual(['cancel']);
        // Nothing was approved by the refused prompt.
        expect(globalThis.detectPlotCrossings(road, []).plots).toHaveLength(1);
    });
});

describe('i18n', () => {
    it('has the plot prompt and the drift notice in en/hr/es/sr', () => {
        ['en', 'hr', 'es', 'sr'].forEach(lang => {
            const dict = require(`../../frontend/i18n/${lang}.json`);
            ['offer', 'line', 'plotOne', 'plotMany', 'note', 'blocked', 'blockedLine', 'blockedNote',
                'blockedBuilding', 'blockedBuildingLine', 'blockedBuildingNote']
                .forEach(key => expect(dict.modal.corridorPlots[key], `${lang} ${key}`).toBeTruthy());
            ['title', 'addedOne', 'addedMany', 'removed', 'addedList', 'removedList', 'coverage', 'note', 'rebind',
                'reboundAs', 'confirm', 'cancel', 'unavailable', 'failed', 'done']
                .forEach(key => expect(dict.panel.proposal.bindingDrift[key], `${lang} ${key}`).toBeTruthy());
            ['complete', 'partial', 'none', 'unknown']
                .forEach(key => expect(dict.panel.proposal.bindingDrift.coverageKinds[key], `${lang} ${key}`).toBeTruthy());
            expect(dict.panel.proposal.bindingDrift.title).toContain('{{summary}}');
            expect(dict.modal.corridorPlots.line).toContain('{{area}}');
        });
    });
});
