// Locks the explicitly synthetic geometry identity: geometry can be re-found, but never masquerades as a registry key.
import { describe, expect, it } from 'vitest';
import {
    GEOMETRY_IDENTITY_KIND, geometryLookupBounds, geometryParcelFeature, parseGeometryParcelId
} from '../parcels/geometry-identity.js';

const descriptor = {
    id: 'nairobi-outline-test', idPrefix: 'KE-NAI-OUTLINE-',
    identityKind: GEOMETRY_IDENTITY_KIND
};
const ring = (west, south, east, north) => [
    [west, south], [east, south], [east, north], [west, north], [west, south]
];
const feature = geometry => ({ type: 'Feature', geometry, properties: {} });

function rotateAndReverse(closedRing, offset = 1) {
    const open = closedRing.slice(0, -1).reverse();
    const rotated = open.slice(offset).concat(open.slice(0, offset));
    return [...rotated, rotated[0]];
}

function withDuplicateVertex(closedRing) {
    return [closedRing[0], closedRing[1], closedRing[1], ...closedRing.slice(2)];
}

const multiWithHole = {
    type: 'MultiPolygon',
    coordinates: [
        [ring(36.8450, -1.2660, 36.8460, -1.2650), ring(36.8452, -1.2658, 36.8454, -1.2656), ring(36.8456, -1.2654, 36.8458, -1.2652)],
        [ring(36.8470, -1.2660, 36.8480, -1.2650)]
    ]
};

describe('geometry-derived parcel references', () => {
    it('keeps the version-one reference byte encoding fixed across releases', () => {
        const shape = feature({ type: 'Polygon', coordinates: [ring(36.845, -1.266, 36.846, -1.265)] });
        expect(geometryParcelFeature(descriptor, shape).id).toBe(
            'KE-NAI-OUTLINE-g1~368450000~-12660000~60a057b720c3c98a64a9114e1a82ef184d5f87a47c1005ffae6f53ba59ac0fd2'
        );
    });

    it('canonicalizes ring rotation, direction, hole order and multipart order', () => {
        const changedOrder = {
            type: 'MultiPolygon',
            coordinates: [
                [
                    rotateAndReverse(multiWithHole.coordinates[0][0], 2),
                    rotateAndReverse(multiWithHole.coordinates[0][2], 1),
                    rotateAndReverse(multiWithHole.coordinates[0][1], 3)
                ],
                [rotateAndReverse(multiWithHole.coordinates[1][0], 2)]
            ].reverse()
        };

        expect(geometryParcelFeature(descriptor, feature(changedOrder)).id)
            .toBe(geometryParcelFeature(descriptor, feature(multiWithHole)).id);
    });

    it('ignores a redundant consecutive duplicate vertex, while preserving geometry-based distinction', () => {
        const base = { type: 'Polygon', coordinates: [ring(36.845, -1.266, 36.846, -1.265)] };
        const duplicate = { type: 'Polygon', coordinates: [withDuplicateVertex(base.coordinates[0])] };
        const shifted = { type: 'Polygon', coordinates: [ring(36.845, -1.266, 36.8461, -1.265)] };
        const id = geometryParcelFeature(descriptor, feature(base)).id;

        expect(geometryParcelFeature(descriptor, feature(duplicate)).id).toBe(id);
        expect(geometryParcelFeature(descriptor, feature(shifted)).id).not.toBe(id);
    });

    it('namespaces otherwise-identical geometry by source and keeps native parcel labels null', () => {
        const square = { type: 'Polygon', coordinates: [ring(36.845, -1.266, 36.846, -1.265)] };
        const otherSource = { ...descriptor, id: 'other-outline-source' };
        const result = geometryParcelFeature(descriptor, feature(square));

        expect(geometryParcelFeature(otherSource, feature(square)).id).not.toBe(result.id);
        expect(result.properties).toMatchObject({
            sourceId: descriptor.id,
            sourceParcelId: null,
            parcelNumber: null,
            parcelIdentityKind: GEOMETRY_IDENTITY_KIND,
            ownershipType: 'unknown',
            sourceProperties: {}
        });
        expect(result.properties.geometryDisplayId).toMatch(/^G1-[0-9a-f]{12}$/);
    });

    it('rejects holes that collapse at identity precision and malformed polygon geometry', () => {
        const outer = ring(36.845, -1.266, 36.846, -1.265);
        const collapsedHole = [[36.8452, -1.2658], [36.84520001, -1.2658], [36.8452, -1.2658], [36.8452, -1.2658]];
        expect(() => geometryParcelFeature(descriptor, feature({ type: 'Polygon', coordinates: [outer, collapsedHole] })))
            .toThrow(/collapses at the identity precision/i);
        expect(() => geometryParcelFeature(descriptor, feature({
            type: 'Polygon', coordinates: [[[36.845, -1.266], [36.846, -1.266], [36.846, -1.265], [36.845, -1.265]]]
        }))).toThrow(/invalid polygon geometry/i);
        expect(() => geometryParcelFeature(descriptor, feature({ type: 'Point', coordinates: [36.845, -1.266] })))
            .toThrow(/invalid polygon geometry/i);
    });

    it('parses only canonical v1 IDs for this source and computes their cold-lookup cell', () => {
        const outline = { type: 'Polygon', coordinates: [ring(36.8451, -1.2661, 36.8461, -1.2651)] };
        const id = geometryParcelFeature(descriptor, feature(outline)).id;
        const locator = parseGeometryParcelId(descriptor, id);
        expect(locator).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(geometryLookupBounds(locator, 0.0025)).toEqual([36.8449998, -1.2675002, 36.8475002, -1.2649998]);

        for (const invalid of [
            `${descriptor.idPrefix}g2~368451000~-12661000~${locator.hash}`,
            `${descriptor.idPrefix}g1~0368451000~-12661000~${locator.hash}`,
            `${descriptor.idPrefix}g1~368451000~-12661000~${locator.hash.slice(0, -1)}z`,
            `${descriptor.idPrefix}g1~368451000~-12661000~${locator.hash}~extra`,
            `${descriptor.idPrefix}g1~368451000~-12661000.0~${locator.hash}`
        ]) expect(() => parseGeometryParcelId(descriptor, invalid)).toThrow();
        expect(() => parseGeometryParcelId(descriptor, `OTHER-${id}`)).toThrow(/different source/i);
    });
});
