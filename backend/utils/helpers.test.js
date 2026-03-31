import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseBboxParam, geoJsonToEsriRings, computeBoundsFromRings } from './helpers.js';

describe('helpers.js', () => {
    describe('parseBboxParam', () => {
        test('should return null for empty input', () => {
            assert.strictEqual(parseBboxParam(null), null);
            assert.strictEqual(parseBboxParam(''), null);
        });

        test('should return null for invalid number of parts', () => {
            assert.strictEqual(parseBboxParam('1,2,3'), null);
            assert.strictEqual(parseBboxParam('1,2,3,4,5'), null);
        });

        test('should return null for non-finite numbers', () => {
            assert.strictEqual(parseBboxParam('1,2,3,NaN'), null);
            assert.strictEqual(parseBboxParam('1,2,3,Infinity'), null);
        });

        test('should return null for invalid bounds (min >= max)', () => {
            assert.strictEqual(parseBboxParam('10,10,5,20'), null); // minX > maxX
            assert.strictEqual(parseBboxParam('10,20,20,10'), null); // minY > maxY
            assert.strictEqual(parseBboxParam('10,10,10,20'), null); // minX == maxX
        });

        test('should return array of numbers for valid input', () => {
            assert.deepStrictEqual(parseBboxParam('10,20,30,40'), [10, 20, 30, 40]);
            assert.deepStrictEqual(parseBboxParam(' 10.5 , 20.1 , 30.7 , 40.9 '), [10.5, 20.1, 30.7, 40.9]);
        });
    });

    describe('geoJsonToEsriRings', () => {
        test('should return empty array for invalid input', () => {
            assert.deepStrictEqual(geoJsonToEsriRings(null), []);
            assert.deepStrictEqual(geoJsonToEsriRings({}), []);
            assert.deepStrictEqual(geoJsonToEsriRings({ type: 'Point', coordinates: [0, 0] }), []);
        });

        test('should handle Polygon', () => {
            const polygon = {
                type: 'Polygon',
                coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
            };
            assert.deepStrictEqual(geoJsonToEsriRings(polygon), polygon.coordinates);
        });

        test('should handle MultiPolygon', () => {
            const multiPolygon = {
                type: 'MultiPolygon',
                coordinates: [
                    [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                    [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]]
                ]
            };
            const expected = [
                [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
                [[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]
            ];
            assert.deepStrictEqual(geoJsonToEsriRings(multiPolygon), expected);
        });
    });

    describe('computeBoundsFromRings', () => {
        test('should return null for empty rings', () => {
            assert.strictEqual(computeBoundsFromRings([]), null);
        });

        test('should compute bounds correctly', () => {
            const rings = [
                [[10, 20], [30, 40]],
                [[5, 50], [15, 25]]
            ];
            const expected = {
                minX: 5,
                minY: 20,
                maxX: 30,
                maxY: 50
            };
            assert.deepStrictEqual(computeBoundsFromRings(rings), expected);
        });
    });
});
