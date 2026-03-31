import { test } from 'node:test';
import assert from 'node:assert';
import { parseNumericValue } from '../routes/city-stats.js';

test('parseNumericValue correctly extracts numbers from various formats', async (t) => {
    await t.test('handles null and undefined', () => {
        assert.strictEqual(parseNumericValue(null), null);
        assert.strictEqual(parseNumericValue(undefined), null);
    });

    await t.test('handles basic numeric strings', () => {
        assert.strictEqual(parseNumericValue('123'), 123);
        assert.strictEqual(parseNumericValue('123.45'), 123.45);
        assert.strictEqual(parseNumericValue('-123.45'), -123.45);
    });

    await t.test('handles numbers with commas (thousands separators)', () => {
        assert.strictEqual(parseNumericValue('1,234.56'), 1234.56);
        assert.strictEqual(parseNumericValue('1,000,000'), 1000000);
    });

    await t.test('handles numbers with non-breaking spaces', () => {
        assert.strictEqual(parseNumericValue('1\u00a0234.56'), 1234.56);
    });

    await t.test('handles currency symbols and text around numbers', () => {
        assert.strictEqual(parseNumericValue('€1,234.56'), 1234.56);
        assert.strictEqual(parseNumericValue('1,234.56 €'), 1234.56);
        assert.strictEqual(parseNumericValue('Price: 1234.56 USD'), 1234.56);
        assert.strictEqual(parseNumericValue('Approximately 500'), 500);
    });

    await t.test('handles strings with no numbers', () => {
        assert.strictEqual(parseNumericValue('no number here'), null);
        assert.strictEqual(parseNumericValue(''), null);
        assert.strictEqual(parseNumericValue('   '), null);
    });

    await t.test('handles numbers at different positions in the string', () => {
        assert.strictEqual(parseNumericValue('100 units'), 100);
        assert.strictEqual(parseNumericValue('Item 42'), 42);
        assert.strictEqual(parseNumericValue('Between 10 and 20'), 10); // It should pick the first one
    });

    await t.test('handles numeric inputs directly', () => {
        assert.strictEqual(parseNumericValue(123.45), 123.45);
        assert.strictEqual(parseNumericValue(0), 0);
    });

    await t.test('handles edge cases', () => {
        assert.strictEqual(parseNumericValue('0.00'), 0);
        assert.strictEqual(parseNumericValue('.45'), 0.45);
    });

    await t.test('handles negative numbers with non-breaking spaces', () => {
        assert.strictEqual(parseNumericValue('-1\u00a0234.56'), -1234.56);
    });

    await t.test('handles boolean and special values', () => {
        assert.strictEqual(parseNumericValue(true), null);
        assert.strictEqual(parseNumericValue(false), null);
        assert.strictEqual(parseNumericValue(Infinity), null);
        assert.strictEqual(parseNumericValue(NaN), null);
    });
});
