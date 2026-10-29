// The browser's derived demolitions (frontend/js/demolition-index.js): the applied designs' land,
// the buildings the cell loader gives under it, the records every view reads, and a new derivation
// when the plan or the sources change.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const DemolitionDerive = require('../../frontend/js/demolition-derive.js');
const SourceList = require('../../frontend/js/source-list.js');
const BuildingCells = require('../../frontend/js/building-cells.js');
const source = readFileSync(new URL('../../frontend/js/demolition-index.js', import.meta.url), 'utf8');

const box = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
// Buildings along 46°N: one under the road, one under the park, one away from both.
const stock = [
    { id: 'road-hit', geometry: box(16.0001, 46.00002, 16.00015, 46.00007) },
    { id: 'park-hit', geometry: box(16.0011, 46.00002, 16.00115, 46.00007) },
    { id: 'away', geometry: box(16.002, 46.002, 16.0021, 46.0021) }
];

function page({ sources = ['gdi-3d'] } = {}) {
    const listeners = new Map();
    const events = [];
    const proposals = [
        { proposalId: 'road', applied: true, roadProposal: { applied: true, definition: { polygon: box(16, 46, 16.0005, 46.0001) } } },
        { proposalId: 'park', applied: true, structureProposal: { applied: true } }
    ];
    const load = vi.fn(async ({ cells, onCell }) => {
        for (const cell of cells) {
            const [w, s, e, n] = cell.bbox;
            const items = stock.filter(item => {
                const [x, y] = item.geometry.coordinates[0][0];
                return x >= w && x < e && y >= s && y < n;
            });
            onCell(cell, { items, source: sources[0], complete: true });
        }
        return { failed: 0 };
    });
    const window = {
        DemolitionDerive, SourceList, BuildingCells, turf, console,
        BuildingCellLoader: { load },
        CityConfigManager: { getParcelGridSize: () => 0.0025, datasetToLatLng: (easting, northing) => [northing, easting],
            getBuildingSources: () => sources.map(id => ({ id, use: true })), getBuildingSourceKey: () => sources.join('>') },
        wgs84ToDataset: (lat, lng) => [lng, lat],
        isApplied: (proposal, sub) => proposal.applied === true && sub.applied !== false,
        proposalStorage: { getAllProposals: () => proposals },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
        addEventListener: (type, listener) => listeners.set(type, listener),
        dispatchEvent: event => events.push(event)
    };
    vm.runInNewContext(source, { window, console });
    return { window, index: window.DemolitionIndex, proposals, load, events, listeners };
}

describe('demolition index', () => {
    let h;
    beforeEach(() => { h = page(); });

    it('derives every applied design\'s demolitions over the buildings under its land, keyed by source', async () => {
        h.index.registerRegion('park', box(16.001, 46, 16.0015, 46.0001));
        await h.index.refresh();
        expect(h.index.records().map(record => record.id).sort()).toEqual(['gdi-3d:park-hit', 'gdi-3d:road-hit']);
        expect(h.index.recordFor('gdi-3d:road-hit')).toMatchObject({ proposalIds: ['road'] });
        expect(h.events.map(event => event.type)).toEqual(['demolitionsChanged']);
        // Nothing changed: no second derivation and no event.
        await h.index.refresh();
        expect(h.events).toHaveLength(1);
    });

    it('gives the buildings back when a design is unapplied, and reads them without a design being edited', async () => {
        h.index.registerRegion('park', box(16.001, 46, 16.0015, 46.0001));
        await h.index.refresh();
        expect(h.index.records({ excludeProposalId: 'road' }).map(record => record.id)).toEqual(['gdi-3d:park-hit']);
        h.proposals[0].applied = false;
        h.listeners.get('parcelFabricCommitted')();
        await h.index.refresh();
        expect(h.index.records().map(record => record.id)).toEqual(['gdi-3d:park-hit']);
    });

    it('carves a subset of the designs, and measures a mesh the stock does not hold by its own outline', async () => {
        h.index.registerRegion('park', box(16.001, 46, 16.0015, 46.0001));
        await h.index.refresh();
        const roadOnly = h.index.carveRecords([h.proposals[0]]);
        expect([...roadOnly.records.keys()]).toEqual(['gdi-3d:road-hit']);
        expect(roadOnly.carveOf('gdi-3d:road-hit')).toMatchObject({ remainder: null });
        expect(roadOnly.carveOf('gdi-3d:away', () => stock[2].geometry)).toBeNull();
        // A duplicate mesh under the road with no footprint in the stock is still razed.
        expect(roadOnly.carveOf('gdi-3d:twin', () => box(16.0002, 46.00002, 16.00025, 46.00007))).toMatchObject({ remainder: null });
    });

    it('derives again over the new sources after the list changes', async () => {
        await h.index.refresh();
        expect(h.load).toHaveBeenCalled();
        h.window.CityConfigManager.getBuildingSources = () => [{ id: 'osm', use: true }];
        h.window.CityConfigManager.getBuildingSourceKey = () => 'osm';
        h.load.mockClear();
        h.listeners.get('sourceListChanged')();
        await h.index.refresh();
        expect(h.load.mock.calls[0][0].sources).toEqual(['osm']);
    });

    it('refuses to call an incomplete stock empty ground', async () => {
        h.load.mockImplementation(async () => ({ failed: 1 }));
        await expect(h.index.stockUnder([box(16, 46, 16.0005, 46.0001)])).rejects.toThrow(/incomplete/);
    });
});
