// Ledger amounts and source prices keep known currency independent of missing values.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { currencyCode, formatAmount } = require('../../frontend/js/canton/canton-read-price.js');

describe('Canton read price labels', () => {
    it('includes only an explicit currency code', () => {
        expect(formatAmount('1234.5', ' usd ')).toBe('1,234.5 USD');
        expect(formatAmount(100, 'USDT')).toBe('100 USDT');
        expect(formatAmount(100, null)).toBe('100 (currency unknown)');
    });

    it('keeps missing values unknown while preserving an explicit currency', () => {
        expect(currencyCode('$')).toBeNull();
        expect(currencyCode('')).toBeNull();
        expect(formatAmount('not-a-number', 'USD')).toBe('— USD');
        expect(formatAmount(null, 'USD')).toBe('— USD');
        expect(formatAmount(true, 'USD')).toBe('— USD');
    });
});
