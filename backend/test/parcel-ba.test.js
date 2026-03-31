import { test } from 'node:test';
import assert from 'node:assert';
import { parseBbox } from '../routes/parcel-ba.js';

test('parseBbox with valid input', () => {
    const result = parseBbox('-58.4,-34.6,-58.3,-34.5');
    assert.deepStrictEqual(result, {
        minLon: -58.4,
        minLat: -34.6,
        maxLon: -58.3,
        maxLat: -34.5
    });
});

test('parseBbox with valid float input', () => {
    const result = parseBbox('-58.4123,-34.6123,-58.3123,-34.5123');
    assert.deepStrictEqual(result, {
        minLon: -58.4123,
        minLat: -34.6123,
        maxLon: -58.3123,
        maxLat: -34.5123
    });
});

test('parseBbox with invalid type', () => {
    assert.strictEqual(parseBbox(null), null);
    assert.strictEqual(parseBbox(undefined), null);
    assert.strictEqual(parseBbox(123), null);
    assert.strictEqual(parseBbox({}), null);
});

test('parseBbox with empty string', () => {
    assert.strictEqual(parseBbox(''), null);
});

test('parseBbox with invalid format (too few parts)', () => {
    assert.strictEqual(parseBbox('-58.4,-34.6,-58.3'), null);
});

test('parseBbox with invalid format (too many parts)', () => {
    assert.strictEqual(parseBbox('-58.4,-34.6,-58.3,-34.5,-58.2'), null);
});

test('parseBbox with non-numeric parts', () => {
    assert.strictEqual(parseBbox('-58.4,abc,-58.3,-34.5'), null);
});

test('parseBbox with invalid ranges (minLon >= maxLon)', () => {
    assert.strictEqual(parseBbox('-58.3,-34.6,-58.4,-34.5'), null);
    assert.strictEqual(parseBbox('-58.4,-34.6,-58.4,-34.5'), null);
});

test('parseBbox with invalid ranges (minLat >= maxLat)', () => {
    assert.strictEqual(parseBbox('-58.4,-34.5,-58.3,-34.6'), null);
    assert.strictEqual(parseBbox('-58.4,-34.6,-58.3,-34.6'), null);
});
