// Economic adapters preserve evidence semantics, source precedence and currency boundaries.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EconomicSources = require('../../frontend/js/economic-sources.js');
const CityMoney = require('../../frontend/js/city-money.js');
const UkLandRates = require('../../frontend/js/uk-land-rates.js');

const birmingham = { id: 'birmingham', currency: { code: 'GBP' } };
const cityContext = city => ({ city, ukLandRates: UkLandRates });
const rateSource = (id, rates, extra = {}) => ({
    version: 1, id, name: `Source ${id}`, adapter: 'rate-table', rates, ...extra
});
const rate = (metric, amount, overrides = {}) => ({
    metric, unit: EconomicSources.METRICS[metric], amount, currency: 'GBP', basis: 'assumption', ...overrides
});

describe('economic source adapters', () => {
    it('returns UK authority land evidence with provenance, units, basis, and valuation date', () => {
        const source = EconomicSources.defaults(birmingham, UkLandRates);
        const rates = EconomicSources.resolve(source, cityContext(birmingham));
        expect(rates.land).toMatchObject({
            metric: 'land', unit: 'm2-land', amount: 688, currency: 'GBP', basis: 'policy-appraisal',
            asOf: '2023-10-01', sourceId: 'uk-mhclg-land-2023',
            sourceName: 'MHCLG residential policy appraisal 2023',
            sourceUrl: UkLandRates.source, scope: 'E08000025 · Birmingham'
        });
        expect(rates.roadLand).toMatchObject({ metric: 'roadLand', unit: 'm2-land', amount: 688, asOf: '2023-10-01' });
    });

    it('does not treat an England-median fallback as local evidence outside authority coverage', () => {
        const cardiff = { id: 'cardiff', currency: { code: 'GBP' } };
        expect(UkLandRates.cities.cardiff.basis).toBe('england-median');
        const rates = EconomicSources.resolve(EconomicSources.defaults(cardiff, UkLandRates), cityContext(cardiff));
        expect(rates).not.toHaveProperty('land');
        expect(rates).not.toHaveProperty('roadLand');
    });

    it('filters evidence to the city currency without converting it', () => {
        const euroCity = { id: 'euro-city', currency: { code: 'EUR' } };
        const source = rateSource('sterling', [rate('land', 900)]);
        expect(EconomicSources.resolve([source], cityContext(euroCity))).toEqual({});
    });

    it('keeps source ordering and lets an earlier source override only its supplied metric', () => {
        const first = rateSource('first', [rate('sale', 5100, { basis: 'market', asOf: '2025-01-01' })]);
        const second = rateSource('second', [rate('sale', 6200, { basis: 'market', asOf: '2025-02-01' }),
            rate('construction', 2700, { basis: 'construction-cost', asOf: '2025-02-01' })]);
        const resolved = EconomicSources.resolve([first, second], cityContext(birmingham));
        expect(resolved.sale).toMatchObject({ amount: 5100, sourceId: 'first' });
        expect(resolved.construction).toMatchObject({ amount: 2700, sourceId: 'second', unit: 'm2-floor' });
        expect(resolved).not.toHaveProperty('land');
    });

    it('accepts zero and a null date for assumptions, and rejects null or non-finite amounts', () => {
        expect(EconomicSources.rateTable(rateSource('zero', [rate('land', 0)])).rates[0])
            .toMatchObject({ amount: 0, asOf: null });
        for (const amount of [null, '12', -1, NaN, Infinity]) {
            expect(() => EconomicSources.rateTable(rateSource('bad-amount', [rate('land', amount)]))).toThrow();
        }
    });

    it('validates units, permitted bases, evidence dates, and duplicate metrics', () => {
        const badRows = [
            [rate('land', 5, { unit: 'm2-floor' })],
            [rate('land', 5, { basis: 'construction-cost' })],
            [rate('sale', 5, { basis: 'policy-appraisal', asOf: '2025-01-01' })],
            [rate('construction', 5, { basis: 'market', asOf: '2025-01-01' })],
            [rate('land', 5, { basis: 'market' })],
            [rate('land', 5, { asOf: '2025-02-30' })],
            [rate('land', 5), rate('land', 6)]
        ];
        for (const rates of badRows) expect(() => EconomicSources.rateTable(rateSource('invalid', rates))).toThrow();
        expect(() => EconomicSources.rateTable(rateSource('ok', [rate('sale', 5000, { basis: 'market', asOf: '2025-01-01' })])))
            .not.toThrow();
    });

    it('uses explicit city.economics.sources through CityMoney and retains the chosen source metadata', () => {
        const configured = {
            ...birmingham,
            economics: { sources: [rateSource('city-plan', [rate('land', 77, { basis: 'market', asOf: '2024-06-01' })])] }
        };
        const options = CityMoney.landPriceOptions(configured);
        expect(options).toMatchObject({ areaPricePerSqm: 77, currency: 'GBP', economicSource: {
            amount: 77, basis: 'market', asOf: '2024-06-01', sourceId: 'city-plan'
        } });
    });

    it('distinguishes slider source identity even when currency and amounts match', () => {
        const cityOne = { ...birmingham, economics: { sources: [rateSource('plan-one', [rate('sale', 4000),
            rate('construction', 2000, { basis: 'construction-cost', asOf: '2024-01-01' })])] } };
        const cityTwo = { ...birmingham, economics: { sources: [rateSource('plan-two', [rate('sale', 4000),
            rate('construction', 2000, { basis: 'construction-cost', asOf: '2024-01-01' })])] } };
        const first = CityMoney.forCity(() => cityOne).currentFloorAreaPrices();
        const second = CityMoney.forCity(() => cityTwo).currentFloorAreaPrices();
        expect(first.currency).toBe(second.currency);
        expect(first.sale.perSqm).toBe(second.sale.perSqm);
        expect(first.sourceKey).not.toBe(second.sourceKey);
    });
});
