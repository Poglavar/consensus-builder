// Which ingest a spatial dataset should be read from: city → region → country → planet.
//
// The shared tables (`overture_building_footprint`, `osm_decor`, …) label every row with the ingest
// it came from — 'belgrade', 'split', 'sjeverna-dalmacija', 'croatia'. A provider used to name
// exactly one label, so a city whose data had been ingested under a BROADER name than its config
// expected read an empty table and reported, perfectly calmly, that the ground had no buildings on
// it. That is how Šibenik lost its whole building stock: 2.9M Croatian footprints sitting in the
// table under 'croatia' while the config asked for 'sjeverna-dalmacija'.
//
// The label is not what makes the answer correct — the GEOMETRY filter is. Every one of these
// queries is bounded by a bbox or a radius, so a row from a broader ingest that passes the geometry
// test is exactly as valid as one from a narrower ingest. The label is a partition, an optimisation
// and a statement of provenance; it is never the reason a row belongs in the answer. So when the
// narrow ingest does not exist, widening is not a compromise, and dropping the label entirely
// (the 'planet' rung) is not a bug — it is asking the only question that ever mattered.
//
// Narrower still wins when it exists, for two reasons that both matter: a city-specific ingest is
// usually the better-curated data, and two overlapping ingests would otherwise return the same
// building twice.
//
// Pure ladder + a thin runner. No SQL here — the caller owns its query and merely takes the scope
// as a parameter, so each dataset keeps its own indexes, caps and geometry.

// The ladder for one dataset, narrowest first, always ending in the unscoped rung (null).
// Duplicates collapse: Split's region ingest IS called 'split', and asking twice is just a wasted
// round trip.
export function scopeLadder(config) {
    const rungs = [];
    const push = value => {
        const label = (value === undefined || value === null) ? null : String(value).trim();
        if (!label) return;
        if (!rungs.includes(label)) rungs.push(label);
    };
    push(config && config.city);
    push(config && config.region);
    push(config && config.country);
    // The planet: no label at all, just the geometry. Always last, always present — a dataset with
    // no matching ingest is still allowed to answer from whatever covers the ground.
    rungs.push(null);
    return rungs;
}

/**
 * Run a scoped query down the ladder until a rung answers.
 *
 * The real query is the probe: a bbox-bounded read against the wrong label costs an index lookup
 * and returns nothing, so there is no separate "does this ingest exist" round trip to keep in sync.
 *
 * @param {Array<string|null>} ladder  from scopeLadder()
 * @param {(scope: string|null) => Promise<Array>} runForScope  the caller's query, given one scope
 * @param {object} [memo]  optional { get(key), set(key, scope) } remembering which rung answered
 *                         last time, so a settled dataset starts where it succeeded before. A
 *                         remembered rung that comes back empty still falls through: an area the
 *                         city ingest does not cover may well be covered by the country one.
 * @param {string} [memoKey]
 * @returns {Promise<{rows: Array, scope: string|null, tried: Array<string|null>}>}
 */
export async function queryDownScopeLadder(ladder, runForScope, memo, memoKey) {
    const rungs = Array.isArray(ladder) && ladder.length ? ladder : [null];
    const remembered = (memo && memoKey) ? memo.get(memoKey) : undefined;
    const ordered = (remembered !== undefined && rungs.includes(remembered))
        ? [remembered, ...rungs.filter(rung => rung !== remembered)]
        : rungs;

    const tried = [];
    for (const scope of ordered) {
        tried.push(scope);
        const rows = await runForScope(scope);
        if (Array.isArray(rows) && rows.length) {
            if (memo && memoKey) memo.set(memoKey, scope);
            return { rows, scope, tried };
        }
    }
    // Nothing anywhere — a real answer, not a failure. The caller reports an empty area.
    return { rows: [], scope: null, tried };
}

// A process-lifetime memo. Ingests do not appear or vanish while the server is running, so this only
// ever saves round trips; it never decides an answer, because an empty remembered rung still falls
// through the rest of the ladder.
export function createScopeMemo() {
    const winners = new Map();
    return {
        get: key => winners.get(key),
        set: (key, scope) => winners.set(key, scope),
        clear: () => winners.clear(),
        size: () => winners.size
    };
}
