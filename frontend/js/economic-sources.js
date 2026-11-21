// Economic evidence is expressed in named units with provenance. Adapters produce the same rate
// records; consumers choose sources explicitly and never convert currencies or assessments to prices.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.EconomicSources = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    // Rent is per m² of floor area per month, the way rents are quoted and published. saleTax is the
    // share of a sale price that is tax (VAT on new housing, 0.16 for 16 %), applied to the price as
    // quoted: sale prices include the tax where the place charges it.
    const METRICS = Object.freeze({ land: 'm2-land', roadLand: 'm2-land', sale: 'm2-floor', construction: 'm2-floor', rent: 'm2-floor-month',
        saleTax: 'share-of-sale' });
    const BASES = Object.freeze(['assumption', 'policy-appraisal', 'market', 'construction-cost', 'statutory']);
    // The editable starting assumptions in a city's own currency. Rent 15 a month is a 4.5 % gross
    // yield on the 4,000 sale price.
    const FLOOR_PRICES = Object.freeze({
        sale: Object.freeze({ perSqm: 4000, min: 500, max: 15000, step: 100 }),
        construction: Object.freeze({ perSqm: 2000, min: 500, max: 8000, step: 100 }),
        rent: Object.freeze({ perSqm: 15, min: 1, max: 100, step: 1 })
    });
    const fiat = code => typeof code === 'string' && /^[A-Z]{3}$/.test(code) && !['ETH', 'SOL'].includes(code);
    function sourceUrl(value) {
        if (value == null) return null;
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid economic source URL.');
        return url.href;
    }
    function date(value) {
        if (value == null) return null;
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
            || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
            throw new Error('Invalid economic observation date.');
        }
        return value;
    }
    // Portable local snapshots use explicit rates, not an arbitrary remote provider's field names.
    // An assessed property total is intentionally not a rate: it requires its own subject and adapter.
    function rateTable(source) {
        if (!source || source.adapter !== 'rate-table' || source.version !== 1
            || typeof source.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(source.id)
            || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 160
            || !Array.isArray(source.rates) || !source.rates.length || source.rates.length > Object.keys(METRICS).length) {
            throw new Error('Invalid economic source descriptor.');
        }
        const seen = new Set();
        const rates = source.rates.map(row => {
            if (!row || !Object.hasOwn(METRICS, row.metric) || seen.has(row.metric)
                || row.unit !== METRICS[row.metric] || !fiat(row.currency)
                || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount < 0
                || !BASES.includes(row.basis)
                || row.metric === 'construction' && !['assumption', 'construction-cost'].includes(row.basis)
                || ['sale', 'rent'].includes(row.metric) && !['assumption', 'market'].includes(row.basis)
                || row.metric !== 'construction' && row.basis === 'construction-cost'
                || row.metric === 'saleTax' && (!['assumption', 'statutory'].includes(row.basis) || row.amount >= 1)
                || row.metric !== 'saleTax' && row.basis === 'statutory') {
                throw new Error('Invalid economic rate, unit or basis.');
            }
            seen.add(row.metric);
            const asOf = date(row.asOf);
            if (row.basis !== 'assumption' && !asOf) throw new Error('Economic evidence requires a valuation date.');
            return { metric: row.metric, unit: row.unit, amount: row.amount, currency: row.currency,
                basis: row.basis, asOf, sourceId: source.id, sourceName: source.name.trim(),
                sourceUrl: sourceUrl(source.url), scope: row.scope == null ? null : String(row.scope).slice(0, 160) };
        });
        return { version: 1, id: source.id, name: source.name.trim(), adapter: 'rate-table', url: sourceUrl(source.url),
            rates: rates.map(({ sourceId, sourceName, sourceUrl, ...row }) => row) };
    }
    const adapters = Object.freeze({
        'rate-table': (source) => {
            const table = rateTable(source);
            return table.rates.map(row => ({ ...row, sourceId: table.id, sourceName: table.name, sourceUrl: table.url }));
        },
        'uk-mhclg-2023': (source, context) => {
            const row = context.ukLandRates?.cities?.[context.city?.id];
            // England-median placeholders are not local evidence for other UK jurisdictions.
            if (!row || row.basis !== 'authority') return [];
            return adapters['rate-table']({ version: 1, id: source.id, name: 'MHCLG residential policy appraisal 2023',
                adapter: 'rate-table', url: context.ukLandRates.source,
                rates: ['land', 'roadLand'].map(metric => ({ metric, unit: METRICS[metric], amount: row.perSqm,
                    currency: 'GBP', basis: 'policy-appraisal', asOf: '2023-10-01',
                    scope: row.authority + ' · ' + row.authorityName })) });
        },
        'scenario-assumptions': (source, context) => {
            const currency = context.city?.currency?.code;
            if (!fiat(currency)) return [];
            const rates = ['sale', 'construction', 'rent'].map(metric => ({ metric, unit: METRICS[metric],
                amount: FLOOR_PRICES[metric].perSqm, currency, basis: 'assumption' }));
            // No sale tax until a source states one; the slider and Settings can set it.
            rates.push({ metric: 'saleTax', unit: METRICS.saleTax, amount: 0, currency, basis: 'assumption' });
            if (currency === 'EUR') rates.push(...[['land', 133], ['roadLand', 100]].map(([metric, amount]) =>
                ({ metric, unit: METRICS[metric], amount, currency, basis: 'assumption' })));
            return adapters['rate-table']({ version: 1, id: source.id, name: 'Editable scenario assumptions', adapter: 'rate-table', rates });
        }
    });
    const BUILT_INS = Object.freeze({
        'uk-mhclg-land-2023': Object.freeze({ id: 'uk-mhclg-land-2023', adapter: 'uk-mhclg-2023' }),
        'scenario-assumptions': Object.freeze({ id: 'scenario-assumptions', adapter: 'scenario-assumptions' })
    });
    const runtime = typeof window !== 'undefined' ? window.SourceRuntime : require('./source-runtime.js');
    const registry = runtime.createRegistry({ abstraction: 'economics', runtime: 'shared', required: ['rates'],
        adapters: Object.fromEntries(Object.entries(adapters).map(([id, read]) => [id, {
            custom: id === 'rate-table', create: (config, context) => ({ rates: () => read(config, context) })
        }])), sources: Object.values(BUILT_INS).map(source => runtime.source('economics', source.adapter, source)) });
    // Source ordering belongs to the frontend. A local source may override just one metric.
    function defaults(city, ukLandRates) {
        return [ukLandRates?.cities?.[city?.id]?.basis === 'authority' ? BUILT_INS['uk-mhclg-land-2023'] : null,
            BUILT_INS['scenario-assumptions']].filter(Boolean);
    }
    function resolve(sources, context) {
        const result = {};
        for (const definition of sources) {
            const source = typeof definition === 'string' ? BUILT_INS[definition] : definition;
            if (!source || !Object.hasOwn(adapters, source.adapter)) throw new Error('Unknown economic source adapter.');
            const canonical = source.abstraction ? source : source.adapter === 'rate-table'
                ? runtime.source('economics', source.adapter, source, { kind: 'custom' }) : source.id;
            for (const row of registry.open(canonical, context).rates()) {
                // A source in another currency remains evidence, but is not an implicit conversion.
                if (row.currency === context.city?.currency?.code && !Object.hasOwn(result, row.metric)) result[row.metric] = row;
            }
        }
        return result;
    }
    // Land per m² of land and the sale tax as a share have ranges but no starting amount: a place
    // without a source has no land price, and its sale tax starts as the 0 assumption.
    const SLIDER_RANGES = Object.freeze({ ...FLOOR_PRICES,
        land: Object.freeze({ perSqm: null, min: 0, max: 2000, step: 10 }),
        saleTax: Object.freeze({ perSqm: null, min: 0, max: 0.3, step: 0.01 }) });
    // The standard range is in EUR-sized units; an observation widens it to half and twice its own
    // amount where those fall outside, so a price in a currency of other magnitude (KZT) can still
    // be slid above it as well as below. Without an observation, `scale` (the city's sale price over
    // the 4,000 standard, never below 1) sizes a money range to the currency instead.
    function slider(metric, observation, scale = 1) {
        const base = SLIDER_RANGES[metric];
        const factor = metric === 'saleTax' || !(scale > 1) ? 1 : scale;
        // A scaled range moves freely: its step would be an odd number of the currency's units.
        const standard = { ...base, min: base.min * factor, max: base.max * factor, step: factor > 1 ? 'any' : base.step };
        const amount = observation?.amount ?? null;
        return { ...standard, perSqm: amount,
            step: observation && observation.sourceId !== 'scenario-assumptions' ? 'any' : standard.step,
            min: amount === null ? standard.min : Math.min(standard.min, amount / 2),
            max: amount === null ? standard.max : Math.max(standard.max, amount * 2) };
    }
    return Object.freeze({ METRICS, BASES, FLOOR_PRICES, BUILT_INS, adapters, registry, rateTable, defaults, resolve, slider });
});
