// Economic adapters preserve evidence semantics, source precedence and currency boundaries.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EconomicSources = require('../../frontend/js/economic-sources.js');
const CityMoney = require('../../frontend/js/city-money.js');
const UkLandRates = require('../../frontend/js/uk-land-rates.js');
const UkEconomicAreas = require('../../frontend/data/uk-economic-areas.js');

const birmingham = { id: 'birmingham', currency: { code: 'GBP' } };
const cityContext = (city, at = null) => ({ city, ukLandRates: UkLandRates, ukAreas: UkEconomicAreas, at });
// Points, [lng, lat], in named places: their authorities are the land rate's areas.
const PLACES = { islington: [-0.1030, 51.5380], croydon: [-0.0982, 51.3727], barking: [0.0810, 51.5390],
    trafalgarSquare: [-0.1281, 51.5080], salford: [-2.2900, 53.4875], birminghamCentre: [-1.8904, 52.4862],
    guildford: [-0.5700, 51.2362], cardiff: [-3.1791, 51.4816] };
const rateSource = (id, rates, extra = {}) => ({
    version: 1, id, name: `Source ${id}`, adapter: 'rate-table', rates, ...extra
});
const rate = (metric, amount, overrides = {}) => ({
    metric, unit: EconomicSources.METRICS[metric], amount, currency: 'GBP', basis: 'assumption', ...overrides
});

describe('economic source adapters', () => {
    it('returns UK authority land evidence with provenance, units, basis, and valuation date', () => {
        const source = EconomicSources.defaults(birmingham, UkLandRates);
        const rates = EconomicSources.resolve(source, cityContext(birmingham, PLACES.birminghamCentre));
        expect(rates.land).toMatchObject({
            metric: 'land', unit: 'm2-land', amount: 688, currency: 'GBP', basis: 'policy-appraisal',
            asOf: '2023-10-01', sourceId: 'uk-mhclg-land-2023',
            sourceName: 'MHCLG residential policy appraisal 2023',
            sourceUrl: UkLandRates.source, scope: 'E08000025 · Birmingham'
        });
        expect(rates.roadLand).toMatchObject({ metric: 'roadLand', unit: 'm2-land', amount: 688, asOf: '2023-10-01' });
    });

    it('has no UK land evidence for a city outside England', () => {
        const cardiff = { id: 'cardiff', currency: { code: 'GBP' } };
        expect(UkLandRates.cities).not.toHaveProperty('cardiff');
        const rates = EconomicSources.resolve(EconomicSources.defaults(cardiff, UkLandRates), cityContext(cardiff, PLACES.cardiff));
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

describe('slider ranges', () => {
    it('keeps the standard range without an observation or for one of its size', () => {
        expect(EconomicSources.slider('sale', null)).toMatchObject({ perSqm: null, min: 500, max: 15000 });
        expect(EconomicSources.slider('sale', { amount: 4200, sourceId: 'local' })).toMatchObject({ perSqm: 4200, min: 500, max: 15000, step: 'any' });
    });

    it('reaches twice a price in a currency of other magnitude, so it slides above it as well as below', () => {
        expect(EconomicSources.slider('construction', { amount: 297900, sourceId: 'kz' })).toMatchObject({ min: 500, max: 595800 });
    });
});

describe('Kazakh city sources', () => {
    it('price Astana and Alatau in tenge from dated statistics, sale and construction per m² of floor', async () => {
        const { cityMoney } = await import('../scripts/lib/frontend-city-money.mjs');
        for (const id of ['astana', 'alatau']) {
            const rates = cityMoney(id).currentEconomicRates();
            for (const metric of ['sale', 'construction']) {
                expect(rates[metric], `${id} ${metric}`).toMatchObject({ unit: 'm2-floor', currency: 'KZT', asOf: '2026-10-31' });
                expect(rates[metric].sourceUrl).toMatch(/^https:\/\/stat\.gov\.kz\//);
                expect(rates[metric].scope.length).toBeGreaterThan(20);
            }
            expect(rates.sale.basis).toBe('market');
            expect(rates.construction.basis).toBe('construction-cost');
            expect(rates.sale.amount).toBeGreaterThan(rates.construction.amount);
        }
        expect(cityMoney('alatau').currentEconomicRates().sale.scope).toContain('Almaty city');
        for (const id of ['astana', 'alatau']) {
            const { rent, sale } = cityMoney(id).currentEconomicRates();
            expect(rent).toMatchObject({ unit: 'm2-floor-month', currency: 'KZT', basis: 'market', asOf: '2026-10-31', sourceId: sale.sourceId });
            // About a 10 % gross yield on the sale price, as the bureau's own prices give.
            expect(rent.amount * 12 / sale.amount).toBeGreaterThan(0.09);
            expect(rent.amount * 12 / sale.amount).toBeLessThan(0.11);
        }
        // Land per m² of land and the statutory 16 % VAT on new housing.
        const astana = cityMoney('astana').currentEconomicRates(), alatau = cityMoney('alatau').currentEconomicRates();
        expect(astana.land).toMatchObject({ unit: 'm2-land', currency: 'KZT', basis: 'market', asOf: '2026-11-21' });
        expect(alatau.land).toMatchObject({ unit: 'm2-land', currency: 'KZT', basis: 'assumption' });
        expect(alatau.land.scope).toContain('Proxy');
        for (const rates of [astana, alatau]) {
            expect(rates.saleTax).toMatchObject({ unit: 'share-of-sale', amount: 0.16, basis: 'statutory', asOf: '2026-01-01' });
            expect(rates.saleTax.sourceUrl).toMatch(/^https:\/\/adilet\.zan\.kz\//);
            // The bureau's construction cost is what developers paid, the VAT on inputs included.
            expect(rates.construction).toMatchObject({ basis: 'construction-cost', taxIncluded: true });
        }
        expect(cityMoney('astana').currentAssumptions().constructionTaxIncluded).toBe(true);
        expect(cityMoney('astana').currentFloorAreaPrices().construction).toMatchObject({ perSqm: 297900, taxIncluded: true });
    });
});

describe('rent', () => {
    const rent = overrides => rate('rent', 18, { unit: 'm2-floor-month', ...overrides });

    it('is a monthly rate per m² of floor that a table may give with the other four', () => {
        const table = EconomicSources.rateTable(rateSource('all-five', [rate('land', 700), rate('roadLand', 500), rate('sale', 4200),
            rate('construction', 2300), rent({ basis: 'market', asOf: '2026-06-30' })]));
        expect(table.rates.map(row => row.metric)).toEqual(['land', 'roadLand', 'sale', 'construction', 'rent']);
        expect(table.rates[4]).toMatchObject({ unit: 'm2-floor-month', amount: 18, basis: 'market' });
    });

    it('refuses a rent in another unit, on a construction basis, or as evidence without a date', () => {
        expect(() => EconomicSources.rateTable(rateSource('per-floor', [rent({ unit: 'm2-floor' })]))).toThrow(/rate, unit or basis/);
        expect(() => EconomicSources.rateTable(rateSource('cost-basis', [rent({ basis: 'construction-cost', asOf: '2026-06-30' })]))).toThrow(/rate, unit or basis/);
        expect(() => EconomicSources.rateTable(rateSource('undated', [rent({ basis: 'market' })]))).toThrow(/valuation date/);
    });

    it('starts every city with money at an editable 15 a month', () => {
        const rates = EconomicSources.resolve(EconomicSources.defaults(birmingham, UkLandRates), cityContext(birmingham));
        expect(rates.rent).toMatchObject({ amount: 15, unit: 'm2-floor-month', currency: 'GBP', basis: 'assumption', sourceId: 'scenario-assumptions' });
        expect(CityMoney.assumptionsFor(birmingham).rentPerSqmMonth).toBe(15);
    });
});

describe('sale tax', () => {
    const tax = overrides => rate('saleTax', 0.2, { unit: 'share-of-sale', ...overrides });

    it('is a share of the sale price, statutory where a law sets it', () => {
        const table = EconomicSources.rateTable(rateSource('vat', [tax({ basis: 'statutory', asOf: '2026-01-01' })]));
        expect(table.rates[0]).toMatchObject({ metric: 'saleTax', unit: 'share-of-sale', amount: 0.2, basis: 'statutory' });
    });

    it('refuses a share of one or more, another unit or basis, and a statutory basis on anything else', () => {
        expect(() => EconomicSources.rateTable(rateSource('whole', [tax({ amount: 1 })]))).toThrow(/rate, unit or basis/);
        expect(() => EconomicSources.rateTable(rateSource('per-floor', [tax({ unit: 'm2-floor' })]))).toThrow(/rate, unit or basis/);
        expect(() => EconomicSources.rateTable(rateSource('market', [tax({ basis: 'market', asOf: '2026-01-01' })]))).toThrow(/rate, unit or basis/);
        expect(() => EconomicSources.rateTable(rateSource('statutory-sale', [rate('sale', 4000, { basis: 'statutory', asOf: '2026-01-01' })]))).toThrow(/rate, unit or basis/);
    });

    it('may be included in a construction cost, which says so, and nowhere else', () => {
        const cost = rate('construction', 2300, { basis: 'construction-cost', asOf: '2026-06-30', taxIncluded: true });
        expect(EconomicSources.rateTable(rateSource('gross-cost', [cost])).rates[0]).toMatchObject({ taxIncluded: true });
        expect(EconomicSources.rateTable(rateSource('net-cost', [{ ...cost, taxIncluded: false }])).rates[0]).not.toHaveProperty('taxIncluded');
        expect(() => EconomicSources.rateTable(rateSource('sale-incl', [rate('sale', 4000, { taxIncluded: true })]))).toThrow(/rate, unit or basis/);
        expect(() => EconomicSources.rateTable(rateSource('text-flag', [{ ...cost, taxIncluded: 'yes' }]))).toThrow(/rate, unit or basis/);
        expect(CityMoney.assumptionsFor(birmingham).constructionTaxIncluded).toBe(false);
    });

    it('starts as an editable 0 where no source states one, and slides as a share up to 30 % or twice the rate', () => {
        const rates = EconomicSources.resolve(EconomicSources.defaults(birmingham, UkLandRates), cityContext(birmingham));
        expect(rates.saleTax).toMatchObject({ amount: 0, unit: 'share-of-sale', basis: 'assumption', sourceId: 'scenario-assumptions' });
        expect(EconomicSources.slider('saleTax', rates.saleTax)).toMatchObject({ perSqm: 0, min: 0, max: 0.3 });
        expect(EconomicSources.slider('saleTax', { amount: 0.25, sourceId: 'hr' })).toMatchObject({ min: 0, max: 0.5, step: 'any' });
        // Land has a range but no starting price where no source gives one.
        expect(EconomicSources.slider('land', null)).toMatchObject({ perSqm: null, min: 0, max: 2000 });
        // ... sized to the city's money by its sale price over the 4,000 standard.
        expect(EconomicSources.slider('land', null, 566000 / 4000)).toMatchObject({ perSqm: null, min: 0, max: 283000 });
        expect(EconomicSources.slider('land', null, 0.5).max).toBe(2000);
    });
});

describe('UK rates follow the location', () => {
    const london = { id: 'london', currency: { code: 'GBP' }, map: { defaultCenter: [51.5097885891913, -0.126303973484058] },
        economics: { sources: ['uk-mhclg-land-2023', 'gla-lpvs-2026', 'scenario-assumptions'] } };
    const manchester = { id: 'manchester', currency: { code: 'GBP' } };
    const at = (city, point) => CityMoney.ratesFor(city, null, point);

    it('finds the English local authority and the London value band a point lies in', () => {
        const lad = point => EconomicSources.areaAt(UkEconomicAreas, 'lad', point)?.id;
        expect(lad(PLACES.islington)).toBe('E09000019');
        expect(lad(PLACES.croydon)).toBe('E09000008');
        expect(lad(PLACES.barking)).toBe('E09000002');
        expect(lad(PLACES.salford)).toBe('E08000006');
        expect(lad(PLACES.cardiff)).toBeUndefined();
        const band = point => EconomicSources.areaAt(UkEconomicAreas, 'lpvsBand', point)?.id;
        expect(band(PLACES.islington)).toBe('C');
        expect(band(PLACES.croydon)).toBe('F');
        expect(band(PLACES.trafalgarSquare)).toBeUndefined();
    });

    it("prices land at the authority of the plan's place, not the city's", () => {
        // Islington and Croydon are both London; a per-city rate would give them Westminster's 8,799.
        expect(at(london, PLACES.islington).land).toMatchObject({ amount: 5018, scope: 'E09000019 · Islington', basis: 'policy-appraisal' });
        expect(at(london, PLACES.croydon).land).toMatchObject({ amount: 1428, scope: 'E09000008 · Croydon' });
        expect(at(london, PLACES.barking).roadLand).toMatchObject({ amount: 821, scope: 'E09000002 · Barking and Dagenham' });
        // Manchester's parcels across the city boundary are Salford's.
        expect(CityMoney.landPriceOptions(manchester, 'land', null, PLACES.salford).economicSource).toMatchObject({ amount: 775, scope: 'E08000006 · Salford' });
    });

    it("falls back to the city's authority only without a place, and says so", () => {
        expect(at(london, null).land).toMatchObject({ amount: 8799, scope: "E09000033 · Westminster (the city's authority: no location given)" });
        expect(at(manchester, PLACES.cardiff).land).toMatchObject({ amount: 1048,
            scope: "E08000003 · Manchester (the city's authority: the location is outside the mapped areas)" });
    });

    it("prices London's sale and construction at the GLA value band of the place", () => {
        const islington = at(london, PLACES.islington), croydon = at(london, PLACES.croydon);
        expect(islington.sale).toMatchObject({ amount: Math.round(12666 * 0.675), basis: 'market', asOf: '2025-06-30', sourceId: 'gla-lpvs-2026' });
        expect(islington.construction).toMatchObject({ amount: 3560, basis: 'construction-cost', asOf: '2026-06-08', unit: 'm2-floor' });
        expect(croydon.sale.amount).toBe(Math.round(5511 * 0.675));
        expect(croydon.construction.amount).toBe(3200);
        expect(islington.sale.scope).toMatch(/^Value band C: .*Table C\.2/);
        // The map leaves central postcode districts unbanded: the nearest band, said so.
        expect(at(london, PLACES.trafalgarSquare).sale.scope).toMatch(/^Value band A, nearest:/);
        // Outside Greater London, or without a place, the band of the city's centre, said so.
        expect(at(london, PLACES.guildford).sale.scope).toContain("city centre's: outside Greater London");
        expect(at(london, null).construction.scope).toContain("city centre's: no location given");
        // Rent stays the editable assumption.
        expect(islington.rent).toMatchObject({ amount: 15, sourceId: 'scenario-assumptions' });
    });

    it('locates land at the centre of its extent', () => {
        const square = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]] } };
        expect(EconomicSources.locationOf(square)).toEqual([1, 2]);
        expect(EconomicSources.locationOf([square, { type: 'Point', coordinates: [6, 4] }])).toEqual([3, 2]);
        expect(EconomicSources.locationOf(null)).toBeNull();
    });
});

describe('configured UK cities', () => {
    it('price London per borough and value band, as the MCP reads it, and Birmingham from its viability evidence', async () => {
        const { cityMoney } = await import('../scripts/lib/frontend-city-money.mjs');
        const { cityEconomics } = await import('../agents/mcp-read-tools.js');
        const islington = cityMoney('london').currentEconomicRates(PLACES.islington);
        expect(islington).toMatchObject({ land: { amount: 5018 }, sale: { amount: 8550 }, construction: { amount: 3560 } });
        expect(cityEconomics('london', PLACES.croydon).rates).toMatchObject({ land: { amount: 1428 }, sale: { amount: 3720 }, construction: { amount: 3200 } });
        expect(cityMoney('london').currentFloorAreaPrices(PLACES.islington)).toMatchObject({ sale: { perSqm: 8550 }, construction: { perSqm: 3560 } });
        const birmingham = cityMoney('birmingham').currentEconomicRates(PLACES.birminghamCentre);
        expect(birmingham.land).toMatchObject({ amount: 688, scope: 'E08000025 · Birmingham' });
        expect(birmingham.sale).toMatchObject({ amount: 2509, basis: 'market', asOf: '2023-08-31', sourceId: 'bcc-residential-market-paper-2024' });
        expect(birmingham.construction).toMatchObject({ amount: 1638, basis: 'construction-cost', asOf: '2024-04-01', sourceId: 'bcc-whole-plan-viability-2024' });
        expect(birmingham.rent).toMatchObject({ amount: 15, sourceId: 'scenario-assumptions' });
        // Other English cities keep the editable sale and construction assumptions.
        expect(cityMoney('manchester').currentEconomicRates()).toMatchObject({ sale: { amount: 4000, sourceId: 'scenario-assumptions' } });
    });
});
