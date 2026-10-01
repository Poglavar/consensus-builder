// A queued-result pg pool stand-in. The proposal create path asks the cadastre for the site's
// binding (proposals/binding.js) before it writes; unless a test overrides `bindingAnswer`, those
// statements are answered here as "every declared parcel exists" (parcel acts) and "the site is
// outside the cadastre the server holds" (geometry: coverage unknown, declaration kept unverified),
// so route tests that are not about the binding keep their queued INSERT/UPDATE results in order.
// Binding statements are recorded in `getBindingCalls()`, not in `getCalls()`.
import {
    BINDING_COUNT_SQL,
    BINDING_SQL,
    FOOTPRINT_OUTSIDE_SITE_SQL,
    PARCEL_ACT_SITE_SQL
} from '../../proposals/binding.js';

const SQUARE = { type: 'MultiPolygon', coordinates: [[[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]]] };

export function defaultBindingAnswer(sql, params) {
    if (sql === BINDING_COUNT_SQL) return { rows: [{ parcels: 0 }] };
    if (sql === FOOTPRINT_OUTSIDE_SITE_SQL) return { rows: [{ outside_m2: 0 }] };
    if (sql === BINDING_SQL) {
        return { rows: [{ parcels: [], site_m2: 1000, in_region: false, unsurveyed_m2: 0, unknown_m2: 1000, site_geojson: JSON.stringify(SQUARE) }] };
    }
    if (sql === PARCEL_ACT_SITE_SQL) {
        const ids = JSON.parse(params[0]).map(entry => entry.id);
        return {
            rows: [{
                parcels: ids.map(id => ({ parcelId: id, overlapM2: 100 })),
                site_geojson: ids.length ? JSON.stringify(SQUARE) : null,
                site_m2: ids.length ? 100 * ids.length : null
            }]
        };
    }
    return null;
}

export function createMockPool() {
    const calls = [];
    const bindingCalls = [];
    let results = [];

    const pool = {
        bindingAnswer: defaultBindingAnswer,

        async query(sql, params) {
            const binding = pool.bindingAnswer ? pool.bindingAnswer(sql, params) : null;
            if (binding) {
                bindingCalls.push({ sql, params });
                return binding;
            }
            calls.push({ sql, params });
            if (results.length > 0) {
                return results.shift();
            }
            return { rows: [], rowCount: 0 };
        },

        setResult(result) {
            results = [result];
        },

        setResults(resultList) {
            results = [...resultList];
        },

        getCalls() {
            return calls;
        },

        getBindingCalls() {
            return bindingCalls;
        },

        reset() {
            calls.length = 0;
            bindingCalls.length = 0;
            results = [];
        },
    };
    return pool;
}
