// The UPU Borovje cadastral correction: replaying the committed geometry onto an original record must make a
// clean new version of it, and the committed geometry itself must tile the corrected extent and keep the
// street network connected.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as turf from '@turf/turf';
import { revisedRecord, versionedId, REPAIR_VERSION, VERSION_SUFFIX } from '../scripts/lib/borovje-revision.mjs';

const square = (x, y, size) => ({ type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] });

describe('revisedRecord', () => {
    const layout = {
        id: 633, proposalId: 'p-layout', proposal_id: 'p-layout', createdAt: 'x', binding: {}, parcelSet: {},
        cadastreParcelIds: ['HR-1'], acceptedParcelIds: [], title: 'Layout',
        reparcellization: {
            algorithm: 'manual', totalArea: 300,
            poolGeometry: { type: 'Feature', properties: {}, geometry: square(0, 0, 2) },
            polygons: [
                { ownerKey: 'a', area: 100, percent: 33.3, geometry: square(0, 0, 1) },
                { ownerKey: 'b', area: 200, percent: 66.7, geometry: square(1, 0, 1) }
            ]
        }
    };

    it('makes a new version of a parcel layout with the corrected plots', () => {
        const change = { pool: square(0, 0, 1.5), plots: { a: { geometry: square(0, 0, 0.5), m2: 75 }, b: { geometry: square(1, 0, 0.5), m2: 25 } } };
        const record = revisedRecord(layout, change);
        expect(record.proposalId).toBe(`p-layout${VERSION_SUFFIX}`);
        expect(record.revisionOf).toBe('p-layout');
        expect(record.reconstructionRepair).toBe(REPAIR_VERSION);
        for (const field of ['id', 'proposal_id', 'createdAt', 'binding', 'parcelSet', 'cadastreParcelIds']) expect(record).not.toHaveProperty(field);
        expect(record.reparcellization.polygons.map(p => [p.ownerKey, p.area, p.percent])).toEqual([['a', 75, 75], ['b', 25, 25]]);
        expect(record.reparcellization.totalArea).toBe(100);
        expect(record.reparcellization.poolGeometry.type).toBe('Feature');
        expect(record.reparcellization.poolGeometry.geometry).toEqual(square(0, 0, 1.5));
        expect(record.site).toEqual({ type: 'MultiPolygon', coordinates: [square(0, 0, 1.5).coordinates] });
        // the original is untouched
        expect(layout.reparcellization.polygons[0].area).toBe(100);
        expect(layout.proposalId).toBe('p-layout');
    });

    it('names a revision of a revision after its base record, with its own repair tag', () => {
        expect(versionedId('p-layout', 2)).toBe('p-layout-v2');
        expect(versionedId('p-layout-v2', 3)).toBe('p-layout-v3');
        const record = revisedRecord({ ...layout, proposalId: 'p-layout-v2' }, { pool: square(0, 0, 1), plots: {
            a: { geometry: square(0, 0, 0.5), m2: 1 }, b: { geometry: square(1, 0, 0.5), m2: 1 } } }, { version: 3, repair: 'fit' });
        expect(record.proposalId).toBe('p-layout-v3');
        expect(record.revisionOf).toBe('p-layout-v2');
        expect(record.reconstructionRepair).toBe('fit');
    });

    it('refuses a layout whose corrected plots are incomplete', () => {
        expect(() => revisedRecord(layout, { pool: square(0, 0, 1), plots: { a: { geometry: square(0, 0, 1), m2: 1 } } })).toThrow(/no corrected plot b/);
    });

    it('replaces a street\'s land and centre lines, keeping points and segments the same polylines', () => {
        const road = { proposalId: 'street', roadProposal: { definition: { polygon: square(0, 0, 3), segments: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }]],
            points: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }]], segmentIds: ['s'] } } };
        const segments = [[{ lat: 0, lng: 0 }, { lat: 0.5, lng: 0.5 }], [{ lat: 0.5, lng: 0.5 }, { lat: 0, lng: 1 }]];
        const segmentProfiles = { s: { strips: [{ type: 'driving', width: 4 }] }, narrow: { strips: [{ type: 'driving', width: 3 }] } };
        const record = revisedRecord(road, { polygon: square(0, 0, 2), segments, segmentIds: ['s', 'narrow'], segmentProfiles });
        expect(record.roadProposal.definition.segmentIds).toEqual(['s', 'narrow']);
        expect(record.roadProposal.definition.segmentProfiles).toEqual(segmentProfiles);
        // a segment without a profile is refused
        expect(() => revisedRecord(road, { polygon: square(0, 0, 2), segments, segmentIds: ['s', 'narrow'], segmentProfiles: { s: segmentProfiles.s } }))
            .toThrow(/needs an id and a profile/);
        expect(record.roadProposal.definition.polygon).toEqual(square(0, 0, 2));
        expect(record.roadProposal.definition.segments).toEqual(segments);
        expect(record.roadProposal.definition.points).toEqual(segments);
        expect(record.roadProposal.definition.points).not.toBe(record.roadProposal.definition.segments);
        expect(record.site.type).toBe('MultiPolygon');
    });

    it('moves a park onto its corrected plot, keeping the Feature wrapper', () => {
        const park = { proposalId: 'park', structureProposal: { kind: 'park', geometry: { type: 'Feature', properties: { k: 1 }, geometry: square(0, 0, 2) } } };
        const record = revisedRecord(park, { geometry: square(0, 0, 1) });
        expect(record.structureProposal.geometry).toEqual({ type: 'Feature', properties: { k: 1 }, geometry: square(0, 0, 1) });
        expect(record.site.coordinates).toEqual([square(0, 0, 1).coordinates]);
    });
});

describe('the committed correction (data/cadastral-snap.json)', () => {
    const snap = JSON.parse(readFileSync(new URL('../../rekonstrukcije/upu-borovje/data/cadastral-snap.json', import.meta.url), 'utf8'));
    const layouts = ['p-upu-borovje-parcelacija', 'p-upu-borovje-parcelacija-2', 'p-upu-borovje-parcelacija-3'];
    const roads = ['upu-borovje-ulice', 'upu-borovje-ulice-split-1'];

    it('lays plots and street land edge to edge over the whole corrected extent', () => {
        const pieces = [
            ...layouts.flatMap(id => Object.values(snap.members[id].plots).map(plot => plot.geometry)),
            ...roads.map(id => snap.members[id].polygon)
        ];
        for (const piece of pieces) expect(piece.type).toBe('Polygon');
        const sum = pieces.reduce((total, piece) => total + turf.area(piece), 0);
        const extent = turf.area(snap.extent.geometry);
        expect(Math.abs(sum - extent)).toBeLessThan(1);
        // and every layout's pool is the union of its plots
        for (const id of layouts) {
            const plots = Object.values(snap.members[id].plots).reduce((total, plot) => total + turf.area(plot.geometry), 0);
            expect(Math.abs(turf.area(snap.members[id].pool) - plots)).toBeLessThan(0.5);
        }
    });

    const street = snap.members['upu-borovje-ulice'];
    const collectorParts = street.segmentIds.map((id, i) => (id.startsWith('upu-sabirna-ulica') ? i : -1)).filter(i => i >= 0);

    it('keeps the collector one line and every crossing attached to it at a vertex', () => {
        // the collector's parts join end to start, in order
        for (let k = 1; k < collectorParts.length; k++) {
            const previous = street.segments[collectorParts[k - 1]];
            expect(street.segments[collectorParts[k]][0]).toEqual(previous[previous.length - 1]);
        }
        const vertices = new Set(collectorParts.flatMap(i => street.segments[i]).map(point => `${point.lat},${point.lng}`));
        const crossings = street.segments.filter((_, i) => !collectorParts.includes(i));
        const attached = crossings.flatMap(segment => [segment[0], segment[segment.length - 1]])
            .filter(point => vertices.has(`${point.lat},${point.lng}`));
        // pjesacka-sjever meets the east crossing, not the collector; the other three crossings end on it
        expect(attached).toHaveLength(3);
    });

    it('narrows the collector where the plan\'s band is narrower than the street, dropping only the verges', () => {
        const narrow = street.segmentProfiles['upu-sabirna-ulica-suzenje'];
        const full = street.segmentProfiles['upu-sabirna-ulica'];
        expect(narrow.strips).toEqual(full.strips.filter(strip => strip.type !== 'verge'));
        expect(snap.collector.narrowed.widthM).toBe(13.5);
    });

    it('keeps street lanes on street land, except where the collector meets the city streets', () => {
        expect(snap.corridor.joins.map(join => join.parcel)).toEqual(['335550-1823/8']);
    });

    it('keeps the collector inside the plan: its cross-section barely leaves the corrected extent', () => {
        expect(snap.corridor.before.cadastral.outsideM2).toBeGreaterThan(1000);
        expect(snap.corridor.after.outsideM2).toBeLessThan(100);
    });
});

describe('v3: every street takes exactly the ground its lanes cut (data/streets-fit.json)', () => {
    const read = name => JSON.parse(readFileSync(new URL(`../../rekonstrukcije/upu-borovje/data/${name}`, import.meta.url), 'utf8'));
    const fit = read('streets-fit.json');
    const { footprints } = read('street-footprints.json');
    const streets = ['upu-borovje-ulice-v2', 'upu-borovje-ulice-split-1-v2'];

    it('gives each street exactly the footprint the app cuts for its lanes', () => {
        for (const id of streets) expect(fit.members[id].polygon).toEqual(footprints[id]);
    });

    it('keeps every plot off the streets and every layout one connected pool', () => {
        const land = streets.map(id => turf.feature(fit.members[id].polygon));
        for (const [id, member] of Object.entries(fit.members)) {
            if (!member.plots) continue;
            for (const [owner, plot] of Object.entries(member.plots)) {
                expect(plot.geometry.type, `${id}#${owner}`).toBe('Polygon');
                for (const street of land) {
                    const overlap = turf.intersect(turf.feature(plot.geometry), street);
                    expect(overlap ? turf.area(overlap) : 0, `${owner} on a street`).toBeLessThan(0.5);
                }
            }
            expect(member.pool.type, `${id} pool`).toBe('Polygon');
        }
    });

    it('leaves the street land smaller than the band it was given, the rest going to plots or staying with its parcel', () => {
        expect(fit.streetLandM2.after).toBeLessThan(fit.streetLandM2.before);
        expect(fit.plotsGrew.length).toBeGreaterThan(0);
    });
});
