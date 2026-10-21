// A queued-result pg pool stand-in. Code that binds a site asks the cadastre for its binding
// (proposals/binding.js); unless a test overrides `bindingAnswer`, those statements are answered
// here as "every declared parcel exists" (parcel acts) and "the site is outside the cadastre the
// server holds" (geometry: coverage unknown, declaration kept unverified), so route tests that are
// not about the binding keep their queued INSERT/UPDATE results in order. Binding statements are
// recorded in `getBindingCalls()`, not in `getCalls()`. `answer(match, reply)` answers every
// statement that matches by its SQL (a RegExp, or a function of sql and params) before the queue,
// for routes that read the same row several times; those calls are recorded in `getCalls()` too.
import {
    BINDING_COUNT_SQL,
    BINDING_SQL,
    FOOTPRINT_OUTSIDE_SITE_SQL,
    PARCEL_ACT_SITE_SQL
} from '../../proposals/binding.js';

const SQUARE = { type: 'MultiPolygon', coordinates: [[[[15.97, 45.8], [15.971, 45.8], [15.971, 45.801], [15.97, 45.801], [15.97, 45.8]]]] };

function defaultBindingAnswer(sql, params) {
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
    const answers = [];
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
            const answered = answers.find(({ match }) => (typeof match === 'function' ? match(sql, params) : match.test(sql)));
            if (answered) {
                return typeof answered.reply === 'function' ? answered.reply(sql, params) : answered.reply;
            }
            if (results.length > 0) {
                return results.shift();
            }
            return { rows: [], rowCount: 0 };
        },

        // Answers statements matching `match` with `reply` (a result, or (sql, params) => result,
        // which may throw like a failing statement), first registration first, ahead of the queue.
        answer(match, reply) {
            answers.push({ match, reply });
            return pool;
        },

        // A transaction client that shares this pool's queue and call log.
        async connect() {
            return { query: (sql, params) => pool.query(sql, params), release() {} };
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
            answers.length = 0;
            results = [];
        },
    };
    return pool;
}
