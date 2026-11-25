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
    // devCharge is a charge per m² of new floor area that a place levies on building it (England's
    // Building Safety Levy and CIL, Croatia's komunalni doprinos, US impact fees), statutory where a law
    // or council sets it; `landCategory` names the class of land its rate is for where the rate depends
    // on it (the levy's previously developed land).
    const METRICS = Object.freeze({ land: 'm2-land', roadLand: 'm2-land', sale: 'm2-floor', construction: 'm2-floor', rent: 'm2-floor-month',
        saleTax: 'share-of-sale', devCharge: 'm2-floor' });
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
                || row.metric === 'devCharge' && !['assumption', 'statutory'].includes(row.basis)
                || !['saleTax', 'devCharge'].includes(row.metric) && row.basis === 'statutory'
                || row.landCategory !== undefined && (row.metric !== 'devCharge' || typeof row.landCategory !== 'string'
                    || !/^[a-z][a-z-]{0,59}$/.test(row.landCategory))
                || row.taxIncluded !== undefined && (row.metric !== 'construction' || typeof row.taxIncluded !== 'boolean')) {
                throw new Error('Invalid economic rate, unit or basis.');
            }
            seen.add(row.metric);
            const asOf = date(row.asOf);
            if (row.basis !== 'assumption' && !asOf) throw new Error('Economic evidence requires a valuation date.');
            return { metric: row.metric, unit: row.unit, amount: row.amount, currency: row.currency,
                basis: row.basis, asOf, sourceId: source.id, sourceName: source.name.trim(),
                sourceUrl: sourceUrl(source.url), scope: row.scope == null ? null : String(row.scope).slice(0, 300),
                ...(row.taxIncluded ? { taxIncluded: true } : {}), ...(row.landCategory ? { landCategory: row.landCategory } : {}) };
        });
        return { version: 1, id: source.id, name: source.name.trim(), adapter: 'rate-table', url: sourceUrl(source.url),
            rates: rates.map(({ sourceId, sourceName, sourceUrl, ...row }) => row) };
    }
    // The area of `layer` (data/uk-economic-areas.js: 'lad' districts, 'lpvsBand' London value bands) that
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
    // A whole number with thousands separators for a source's scope text (12666 → "12,666").
    const thousands = value => String(value).replace(/^(\d+)/, digits => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    // The area of an area rate table at `point`: the area containing it, else, for a table whose map
    // leaves gaps inside the region it covers (`nearestWithin`: the areas of another layer, London's
    // boroughs for the GLA value bands), the nearest area when the point lies in that region. `nearest`
    // says which; null elsewhere.
    function tableAreaAt(table, areas, point) {
        const found = areaAt(areas, table.layer, point);
        if (found) return { area: found, nearest: false };
        const region = table.nearestWithin;
        if (!region || !region.areas.includes(areaAt(areas, region.layer, point)?.id)) return null;
        const near = nearestArea(areas, table.layer, point);
        return near ? { area: near, nearest: true } : null;
    }
    // The area of a rate table a city stands for where a location gives none: of its administrative
    // extent's areas (`extent.areas` in data/city-configs.js) those the table rates, the one holding the
    // city's centre (Westminster of London's 33 boroughs), else the first. An extent of the table's own
    // layer that it rates none of (a Welsh city in an English table) has none. Otherwise (a table of
    // other areas than the extent's, such as value bands; a city without an extent) the table's area at
    // the city's centre, `viaCentre`. One source of truth for "the city's district": the extent.
    function cityStandIn(city, table, areas) {
        const centre = cityCentre(city), extent = city?.extent?.areas || [];
        const rated = extent.filter(id => table.areas[id]);
        if (rated.length) {
            const holding = centre && rated.length > 1 ? areaAt(areas, table.layer, centre)?.id : null;
            return { code: rated.includes(holding) ? holding : rated[0] };
        }
        if (extent.some(id => areas?.layers?.[table.layer]?.features.some(feature => feature.id === id))) return null;
        const under = centre && tableAreaAt(table, areas, centre);
        return under && table.areas[under.area.id] ? { code: under.area.id, nearest: under.nearest, viaCentre: true } : null;
    }
    const cityArea = (city, table, areas) => cityStandIn(city, table, areas)?.code ?? null;

    const adapters = Object.freeze({
        'rate-table': (source) => {
            const table = rateTable(source);
            return table.rates.map(row => ({ ...row, sourceId: table.id, sourceName: table.name, sourceUrl: table.url }));
        },
        // An area rate table (scripts/lib/area_rate_table.py, `source.table` in context.areaRates): a
        // dataset's rates per published area, such as an English local authority's land value, private
        // rent or building safety levy, or London's viability value bands; any country's per-area
        // statistics take the same shape. It gives the rates of the area the location lies in (the
        // nearest within a table's `nearestWithin` region, said so); the city's own area (cityStandIn)
        // only where the location is not given, lies outside every area, or in an area the table has no
        // rate for, and the scope says which and why. A source's `scale`,
        // { factor, note }, converts the table's unit to the contract's (a rent per m² of dwelling to one
        // per m² of the building's floor area, by the place's net to gross) and is stated in the scope.
        'area-rates': (source, context) => {
            const table = context.areaRates?.[source.table], at = lngLat(context.at);
            if (!table || table.currency !== context.city?.currency?.code) return [];
            const hit = at && tableAreaAt(table, context.areas, at);
            const located = hit && table.areas[hit.area.id] ? hit : null;
            const standIn = located ? null : cityStandIn(context.city, table, context.areas);
            const code = located ? located.area.id : standIn?.code;
            const row = code && table.areas[code];
            if (!row) return [];
            const named = (table.label || '{code} · {name}').replace(/\{(code|name)\}/g, (match, key) => (key === 'code' ? code : row.name))
                + ((located || standIn).nearest ? ', nearest' : '');
            const why = at === null ? 'no location given' : hit ? `${hit.area.name} has no rate`
                : table.nearestWithin ? `outside ${table.nearestWithin.name}` : 'the location is outside the mapped areas';
            const where = named + (located ? '' : ` (${standIn.viaCentre ? "city centre's" : "the city's area"}: ${why})`);
            const fill = note => note.replace(/\{(\w+)\}/g, (match, key) => (typeof row[key] === 'number' ? thousands(row[key])
                : typeof row[key] === 'string' ? row[key] : match));
            const scale = source.scale && Number.isFinite(source.scale.factor) && source.scale.factor > 0 ? source.scale : null;
            return adapters['rate-table']({ version: 1, id: source.id, name: table.name, adapter: 'rate-table', url: table.url,
                rates: table.rates.map(rate => ({ metric: rate.metric, unit: rate.unit, currency: table.currency, basis: rate.basis,
                    asOf: rate.asOf || table.asOf, amount: scale ? Math.round(row[rate.field] * scale.factor * 100) / 100 : row[rate.field],
                    ...(rate.landCategory ? { landCategory: rate.landCategory } : {}),
                    scope: where + (rate.note ? ': ' + fill(rate.note) : '') + (scale ? (rate.note ? ', ' : ': ') + scale.note : '') })) });
        },
        'scenario-assumptions': (source, context) => {
            const currency = context.city?.currency?.code;
            if (!fiat(currency)) return [];
            const rates = ['sale', 'construction', 'rent'].map(metric => ({ metric, unit: METRICS[metric],
                amount: FLOOR_PRICES[metric].perSqm, currency, basis: 'assumption' }));
            // No sale tax or development charge until a source states one; the sliders and Settings can set them.
            rates.push({ metric: 'saleTax', unit: METRICS.saleTax, amount: 0, currency, basis: 'assumption' },
                { metric: 'devCharge', unit: METRICS.devCharge, amount: 0, currency, basis: 'assumption' });
            if (currency === 'EUR') rates.push(...[['land', 133], ['roadLand', 100]].map(([metric, amount]) =>
                ({ metric, unit: METRICS[metric], amount, currency, basis: 'assumption' })));
            return adapters['rate-table']({ version: 1, id: source.id, name: 'Editable scenario assumptions', adapter: 'rate-table', rates });
        }
    });
    const BUILT_INS = Object.freeze({
        // Area rate tables (js/uk-land-rates.js, js/uk-private-rents.js, js/uk-building-safety-levy.js,
        // js/uk-gla-value-bands.js), each a source of its own id.
        'uk-mhclg-land-2023': Object.freeze({ id: 'uk-mhclg-land-2023', adapter: 'area-rates', table: 'uk-mhclg-land-2023' }),
        'ons-pipr-rent': Object.freeze({ id: 'ons-pipr-rent', adapter: 'area-rates', table: 'ons-pipr-rent' }),
        'uk-building-safety-levy': Object.freeze({ id: 'uk-building-safety-levy', adapter: 'area-rates', table: 'uk-building-safety-levy' }),
        'gla-lpvs-2026': Object.freeze({ id: 'gla-lpvs-2026', adapter: 'area-rates', table: 'gla-lpvs-2026' }),
        'scenario-assumptions': Object.freeze({ id: 'scenario-assumptions', adapter: 'scenario-assumptions' })
    });
    const runtime = typeof window !== 'undefined' ? window.SourceRuntime : require('./source-runtime.js');
    const registry = runtime.createRegistry({ abstraction: 'economics', runtime: 'shared', required: ['rates'],
        adapters: Object.fromEntries(Object.entries(adapters).map(([id, read]) => [id, {
            // A configured area table may add its own `scale`; a rate table is any local snapshot.
            custom: ['rate-table', 'area-rates'].includes(id), create: (config, context) => ({ rates: () => read(config, context) })
        }])), sources: Object.values(BUILT_INS).map(source => runtime.source('economics', source.adapter, source)) });
    // Source ordering belongs to the frontend. A local source may override just one metric. A city
    // takes every built-in area table in its currency that rates its own area (cityArea), then the
    // scenario assumptions. `areaRates` are the loaded tables by id.
    function defaults(city, areaRates, areas) {
        const covers = table => Boolean(table && table.currency === city?.currency?.code && cityArea(city, table, areas));
        return [...Object.values(BUILT_INS).filter(source => source.adapter === 'area-rates' && covers(areaRates?.[source.table])),
            BUILT_INS['scenario-assumptions']];
    }
    function resolve(sources, context) {
        const result = {};
        for (const definition of sources) {
            const source = typeof definition === 'string' ? BUILT_INS[definition] : definition;
            if (!source || !Object.hasOwn(adapters, source.adapter)) throw new Error('Unknown economic source adapter.');
            // A built-in opens by its id; any other descriptor (a rate table, an area table with a scale) is custom.
            const canonical = source.abstraction ? source : BUILT_INS[source.id] === source ? source.id
                : runtime.source('economics', source.adapter, source, { kind: 'custom' });
            for (const row of registry.open(canonical, context).rates()) {
                // A source in another currency remains evidence, but is not an implicit conversion.
                if (row.currency === context.city?.currency?.code && !Object.hasOwn(result, row.metric)) result[row.metric] = row;
            }
        }
        return result;
    }
    // Land per m² of land, the development charge per m² of floor area and the sale tax as a share have
    // ranges but no starting amount: a place without a source has no land price, and its development
    // charge and sale tax start as the 0 assumption.
    const SLIDER_RANGES = Object.freeze({ ...FLOOR_PRICES,
        land: Object.freeze({ perSqm: null, min: 0, max: 2000, step: 10 }),
        devCharge: Object.freeze({ perSqm: null, min: 0, max: 200, step: 1 }),
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
    return Object.freeze({ METRICS, BASES, FLOOR_PRICES, BUILT_INS, adapters, registry, rateTable, areaAt, cityArea, locationOf, defaults, resolve, slider });
});
