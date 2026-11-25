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
    // quoted: sale prices include the tax where the place charges it. A construction rate with
    // `taxIncluded: true` includes that tax on the building's inputs (a statistics office's cost as
    // the developers paid it), which a developer selling the floor area reclaims from the tax it owes.
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
                || row.metric !== 'saleTax' && row.basis === 'statutory'
                || row.taxIncluded !== undefined && (row.metric !== 'construction' || typeof row.taxIncluded !== 'boolean')) {
                throw new Error('Invalid economic rate, unit or basis.');
            }
            seen.add(row.metric);
            const asOf = date(row.asOf);
            if (row.basis !== 'assumption' && !asOf) throw new Error('Economic evidence requires a valuation date.');
            return { metric: row.metric, unit: row.unit, amount: row.amount, currency: row.currency,
                basis: row.basis, asOf, sourceId: source.id, sourceName: source.name.trim(),
                sourceUrl: sourceUrl(source.url), scope: row.scope == null ? null : String(row.scope).slice(0, 160),
                ...(row.taxIncluded ? { taxIncluded: true } : {}) };
        });
        return { version: 1, id: source.id, name: source.name.trim(), adapter: 'rate-table', url: sourceUrl(source.url),
            rates: rates.map(({ sourceId, sourceName, sourceUrl, ...row }) => row) };
    }
    // The area of `layer` (data/uk-economic-areas.js: 'lad' districts, 'lpvsBand' value bands) that
    // contains `point`, [lng, lat]; null outside every area or without the data. Arcs are decoded once
    // per data object; a point is inside an area when a ray from it crosses the area's arcs an odd number
    // of times (an area lists its arcs, so rings, holes and parts need no assembly).
    const decodedAreas = new WeakMap();
    function decodedArcs(data) {
        if (!decodedAreas.has(data)) {
            decodedAreas.set(data, data.arcs.map(arc => {
                const out = new Float64Array(arc.length);
                for (let i = 0, x = 0, y = 0; i < arc.length; i += 2) { x += arc[i]; y += arc[i + 1]; out[i] = x; out[i + 1] = y; }
                return out;
            }));
        }
        return decodedAreas.get(data);
    }
    function areaAt(areas, layer, point) {
        const data = areas?.layers?.[layer];
        if (!data || !lngLat(point)) return null;
        const arcs = decodedArcs(data);
        const x = point[0] * areas.scale, y = point[1] * areas.scale;
        return data.features.find(feature => {
            const [minX, minY, maxX, maxY] = feature.bbox;
            if (x < minX || x > maxX || y < minY || y > maxY) return false;
            let inside = false;
            for (const index of feature.arcs) {
                const arc = arcs[index];
                for (let i = 2; i < arc.length; i += 2) {
                    const x1 = arc[i - 2], y1 = arc[i - 1], x2 = arc[i], y2 = arc[i + 1];
                    if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
                }
            }
            return inside;
        }) || null;
    }
    // The area of `layer` whose boundary passes nearest `point` (for a point the layer leaves uncovered).
    function nearestArea(areas, layer, point) {
        const data = areas?.layers?.[layer];
        if (!data || !lngLat(point)) return null;
        const arcs = decodedArcs(data), k = Math.cos(point[1] * Math.PI / 180);
        const x = point[0] * areas.scale * k, y = point[1] * areas.scale;
        let best = null, bestDistance = Infinity;
        for (const feature of data.features) for (const index of feature.arcs) {
            const arc = arcs[index];
            for (let i = 2; i < arc.length; i += 2) {
                const x1 = arc[i - 2] * k, y1 = arc[i - 1], dx = arc[i] * k - x1, dy = arc[i + 1] - y1;
                const t = dx || dy ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy))) : 0;
                const distance = Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
                if (distance < bestDistance) { bestDistance = distance; best = feature; }
            }
        }
        return best;
    }
    const lngLat = point => (Array.isArray(point) && point.length === 2 && point.every(value => typeof value === 'number' && Number.isFinite(value)) ? point : null);
    // The location a piece of land's rates are taken at, [lng, lat]: the centre of its bounding box (a
    // GeoJSON geometry, feature or collection in WGS84). Plan stats, the 3D panel and ugt_compare take
    // the same point of the same land; null without coordinates.
    function locationOf(geojson) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const visit = value => {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value) && typeof value[0] === 'number') {
                if (Number.isFinite(value[0]) && Number.isFinite(value[1])) {
                    minX = Math.min(minX, value[0]); maxX = Math.max(maxX, value[0]);
                    minY = Math.min(minY, value[1]); maxY = Math.max(maxY, value[1]);
                }
                return;
            }
            if (Array.isArray(value)) { value.forEach(visit); return; }
            visit(value.type === 'FeatureCollection' ? value.features : value.type === 'Feature' ? value.geometry
                : value.type === 'GeometryCollection' ? value.geometries : value.coordinates);
        };
        visit(geojson);
        return minX <= maxX ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
    }
    // The city's own point, [lng, lat], where a model gives no location: its map centre.
    const cityCentre = city => {
        const centre = city?.map?.defaultCenter;
        return Array.isArray(centre) ? lngLat([centre[1], centre[0]]) : null;
    };
    // Why a location-dependent rate is the city's rather than the location's.
    const standIn = (at, found, missing) => (at === null ? 'no location given' : found ? missing : 'the location is outside the mapped areas');

    // GLA London Plan Viability Study, Phase 1 (July 2026), per value band A-F: the indicative average
    // blended market sales value at the mid-point (£ per m² of dwelling floor area, new-build sales June
    // 2022 - June 2025, Annex 2) and Mace's build-for-sale cost of 4-6 storey flats (£ per m² GIA at Q2
    // 2026 prices, Appendix 1; it excludes demolition, externals, fees, finance, CIL/S106 and VAT). A sale
    // price per m² of the building's floor area is the dwelling price × 0.675, the midpoint of the 65-70 %
    // net-to-gross the study found for schemes under 6 storeys counting the ground floor (Annex 3 ¶7).
    const GLA_LPVS_2026 = Object.freeze({
        url: 'https://data.london.gov.uk/download/e6j99/7n9/LONDON%20PLAN%20VIABILITY%20STUDY%20-%20PHASE%201%20REPORT%20-%20JULY%202026.pdf',
        netToGross: 0.675,
        bands: Object.freeze({
            A: Object.freeze({ dwellingSale: 27746, construction: 3910, saleTable: 'A.2', costTable: 'A.6' }),
            B: Object.freeze({ dwellingSale: 17546, construction: 3730, saleTable: 'B.2', costTable: 'B.9' }),
            C: Object.freeze({ dwellingSale: 12666, construction: 3560, saleTable: 'C.2', costTable: 'C.9' }),
            D: Object.freeze({ dwellingSale: 9415, construction: 3380, saleTable: 'D.2', costTable: 'D.10' }),
            E: Object.freeze({ dwellingSale: 7428, construction: 3200, saleTable: 'E.2', costTable: 'E.10' }),
            F: Object.freeze({ dwellingSale: 5511, construction: 3200, saleTable: 'F.2', costTable: 'F.10' })
        })
    });

    const adapters = Object.freeze({
        'rate-table': (source) => {
            const table = rateTable(source);
            return table.rates.map(row => ({ ...row, sourceId: table.id, sourceName: table.name, sourceUrl: table.url }));
        },
        // The residential policy-appraisal rate of the English local authority the location lies in; the
        // city's own authority only where the location gives none, and its scope says why.
        'uk-mhclg-2023': (source, context) => {
            const table = context.ukLandRates, at = lngLat(context.at);
            const found = at && areaAt(context.ukAreas, 'lad', at);
            const located = found && table?.authorities?.[found.id] ? found.id : null;
            const code = located || table?.cities?.[context.city?.id];
            const row = code && table.authorities?.[code];
            if (!row) return [];
            const scope = `${code} · ${row.name}` + (located ? '' : ` (the city's authority: ${standIn(at, found, `${found?.name} has no estimate`)})`);
            return adapters['rate-table']({ version: 1, id: source.id, name: 'MHCLG residential policy appraisal 2023',
                adapter: 'rate-table', url: table.source,
                rates: ['land', 'roadLand'].map(metric => ({ metric, unit: METRICS[metric], amount: row.perSqm,
                    currency: 'GBP', basis: 'policy-appraisal', asOf: table.asOf, scope })) });
        },
        // London's sale price and construction cost of the value band the location lies in. The map
        // leaves postcode districts without enough new-build sales unbanded (much of the centre among
        // them): a location in Greater London there takes the nearest band. A location outside Greater
        // London, or none, takes the band of the city's centre. The scope says which.
        'gla-lpvs-2026': (source, context) => {
            if (context.city?.currency?.code !== 'GBP') return [];
            const areas = context.ukAreas;
            const inLondon = point => /^E09/.test(areaAt(areas, 'lad', point)?.id || '');
            const bandOf = point => areaAt(areas, 'lpvsBand', point) || (inLondon(point) ? nearestArea(areas, 'lpvsBand', point) : null);
            const given = lngLat(context.at), at = given && inLondon(given) ? given : null;
            const band = bandOf(at || cityCentre(context.city));
            if (!band) return [];
            const row = GLA_LPVS_2026.bands[band.id];
            const nearest = !areaAt(areas, 'lpvsBand', at || cityCentre(context.city)) ? ', nearest' : '';
            const where = `Value band ${band.id}${nearest}` + (at ? '' : ` (city centre's: ${given ? 'outside Greater London' : 'no location given'})`);
            const thousands = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            return adapters['rate-table']({ version: 1, id: source.id, name: 'GLA London Plan Viability Study 2026',
                adapter: 'rate-table', url: GLA_LPVS_2026.url,
                rates: [{ metric: 'sale', unit: METRICS.sale, amount: Math.round(row.dwellingSale * GLA_LPVS_2026.netToGross),
                    currency: 'GBP', basis: 'market', asOf: '2025-06-30',
                    scope: `${where}: new builds ${thousands(row.dwellingSale)} per m² of dwelling (Table ${row.saleTable}) × ${GLA_LPVS_2026.netToGross} net to gross` },
                { metric: 'construction', unit: METRICS.construction, amount: row.construction,
                    currency: 'GBP', basis: 'construction-cost', asOf: '2026-06-08',
                    scope: `${where}: 4-6 storey flats for sale, per m² GIA, Q2 2026 (Table ${row.costTable}); no externals, fees or VAT` }] });
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
        'gla-lpvs-2026': Object.freeze({ id: 'gla-lpvs-2026', adapter: 'gla-lpvs-2026' }),
        'scenario-assumptions': Object.freeze({ id: 'scenario-assumptions', adapter: 'scenario-assumptions' })
    });
    const runtime = typeof window !== 'undefined' ? window.SourceRuntime : require('./source-runtime.js');
    const registry = runtime.createRegistry({ abstraction: 'economics', runtime: 'shared', required: ['rates'],
        adapters: Object.fromEntries(Object.entries(adapters).map(([id, read]) => [id, {
            custom: id === 'rate-table', create: (config, context) => ({ rates: () => read(config, context) })
        }])), sources: Object.values(BUILT_INS).map(source => runtime.source('economics', source.adapter, source)) });
    // Source ordering belongs to the frontend. A local source may override just one metric.
    function defaults(city, ukLandRates) {
        return [ukLandRates?.cities?.[city?.id] ? BUILT_INS['uk-mhclg-land-2023'] : null,
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
    return Object.freeze({ METRICS, BASES, FLOOR_PRICES, BUILT_INS, GLA_LPVS_2026, adapters, registry, rateTable, areaAt, locationOf, defaults, resolve, slider });
});
