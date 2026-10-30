// Reads a WGS84 box from a source, splitting it into quarters while the source says the box holds
// more than it answers in one request. One reader for the building cell endpoint and for the custom
// sources' adapter reads, so no source needs a hand-tuned tile size (docs/source-loading-plan.md).
//
// `query(box)` answers { items, complete } for the box, { areaLimited: true } when the box is over
// the source's limit, or { unavailable: true, retryAfter } when the source failed. A box is answered
// wholly or not at all: one failed quarter makes the whole box unavailable, so a caller with a
// fallback source can answer it whole from there instead of merging two surveys.

export const MAX_SPLIT_DEPTH = 5;
export const MAX_SPLIT_QUERIES = 64;

export function quarters([w, s, e, n]) {
    const x = (w + e) / 2, y = (s + n) / 2;
    return [[w, s, x, y], [x, s, e, y], [w, y, x, n], [x, y, e, n]];
}

export function boxPolygon([w, s, e, n]) {
    return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

// The box's longer side in metres (equirectangular, enough for a limit check).
export function boxSideMeters([w, s, e, n]) {
    const midLat = (s + n) / 2;
    return Math.max((e - w) * 111320 * Math.cos(midLat * Math.PI / 180), (n - s) * 110540);
}

/**
 * @param box [w, s, e, n] in WGS84
 * @param query async box => { items, complete } | { areaLimited: true } | { unavailable: true, retryAfter? }
 * @param options { idOf(item) → string, maxDepth, maxQueries }
 * @returns { items, complete, queries } or { unavailable: true, retryAfter, queries }
 */
export async function splitRead(box, query, { idOf, maxDepth = MAX_SPLIT_DEPTH, maxQueries = MAX_SPLIT_QUERIES } = {}) {
    if (typeof idOf !== 'function') throw new TypeError('splitRead needs idOf(item).');
    const byId = new Map();
    let complete = true, queries = 0;
    // Depth first, nearest quarter first is not needed here: a box is small and answered whole.
    const pending = [{ box, depth: 0 }];
    while (pending.length) {
        const { box: part, depth } = pending.shift();
        if (queries >= maxQueries) { complete = false; break; }
        queries++;
        const answer = await query(part);
        if (answer?.unavailable) return { unavailable: true, retryAfter: answer.retryAfter ?? null, queries };
        if (answer?.areaLimited) {
            if (depth >= maxDepth) { complete = false; continue; }
            pending.unshift(...quarters(part).map(quarter => ({ box: quarter, depth: depth + 1 })));
            continue;
        }
        if (answer?.complete !== true) complete = false;
        for (const item of answer?.items || []) byId.set(String(idOf(item)), item);
    }
    return { items: [...byId.values()], complete, queries };
}
