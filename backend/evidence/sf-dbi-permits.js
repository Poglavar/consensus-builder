// Evidence adapter for the San Francisco Department of Building Inspection building permits dataset
// (DataSF Socrata resource i98e-djp9): decides whether permit rows answer a milestone market recipe
// (frontend/js/bets/market-question.js, source sf-dbi-permits-v1) and yields the MarketEvidence-v1
// fact a lens member attests (lmsr-market.md, "Evidence for kind 1"). The evaluator is pure; the
// fetch helper is the only I/O and the only place an observation time comes from.

export const SF_DBI_SOURCE_ID = 'sf-dbi-permits-v1';
export const SF_JURISDICTION = 'US-CA-SF';
export const SF_DBI_RESOURCE_URL = 'https://data.sf.gov/resource/i98e-djp9.json';
// Prefix of San Francisco parcel ids in this product (parcel source us-ca-sf-datasf-active-parcels).
export const SF_PARCEL_ID_PREFIX = 'US-CA-SF-';
export const SF_TIME_ZONE = 'America/Los_Angeles';

// The recipe's subject.event and the row field holding the source's own date of that event.
export const PERMIT_EVENT_FIELDS = Object.freeze({ filed: 'filed_date', issued: 'issued_date', completed: 'completed_date' });
// DBI permit types 1 and 2 (permit_type_definition), compared case-insensitively.
export const NEW_CONSTRUCTION_TYPES = Object.freeze(['new construction', 'new construction wood frame']);
// Selected explicitly so a renamed or removed column fails the query loudly instead of reading as a
// row without the date (which would quietly mean "no evidence").
export const PERMIT_FIELDS = Object.freeze([
    'permit_number', 'permit_type_definition', 'block', 'lot', 'street_number', 'street_name',
    'filed_date', 'issued_date', 'completed_date', 'status', 'description', 'estimated_cost', 'location'
]);
// Most rows one query may return; one more is requested so a full page is told apart from a cut one.
export const PERMIT_ROW_LIMIT = 50;
export const BLOCK_ROW_LIMIT = 1000;
export const MAX_QUERY_BLOCKS = 100;
const DEFAULT_TIMEOUT_MS = 15000;

// ---- parcels --------------------------------------------------------------------------------------
// A San Francisco parcel id in this product is DataSF's mapblklot, stored with the source prefix
// ('US-CA-SF-4884039A', as in the Candlestick proposals' cadastre_parcel_ids) and written bare in
// market recipes ('4884039A'). mapblklot is the Assessor's block, four digits, then the lot, three
// digits, each possibly followed by a letter: '4884039A' is block 4884 lot 039A and '5000002' is
// block 5000 lot 002, the block and lot of DBI's row for permit 202603026735. A lot starts with a
// digit, so a letter right after the fourth digit can only be a block suffix (the Assessor's
// convention; no lettered block is among the ids checked so far).
// mapblklot is the lowest APN of condominium lots sharing one ground footprint, so a permit filed
// against a sibling unit's APN does not match its ground parcel by block and lot.
const MAPBLKLOT = /^(\d{4}[A-Za-z]?)(\d{3}[A-Za-z]?)$/;

export function sfBlockLot(parcelId) {
    const native = typeof parcelId === 'string' && parcelId.startsWith(SF_PARCEL_ID_PREFIX)
        ? parcelId.slice(SF_PARCEL_ID_PREFIX.length) : parcelId;
    const match = typeof native === 'string' ? MAPBLKLOT.exec(native) : null;
    if (!match) {
        throw new Error(`parcel id ${JSON.stringify(parcelId)} is not a San Francisco block and lot (e.g. 4884039A or US-CA-SF-4884039A)`);
    }
    return { block: match[1].toUpperCase(), lot: match[2].toUpperCase() };
}

// DBI rows carry block and lot as text ('5000', '002'). They are compared in the parcel form: upper
// case, digits zero-padded to four (block) and three (lot) places. null when either is malformed.
function rowBlockLot(row) {
    const block = /^(\d{1,4})([A-Za-z]?)$/.exec(String(row?.block ?? '').trim());
    const lot = /^(\d{1,3})([A-Za-z]?)$/.exec(String(row?.lot ?? '').trim());
    if (!block || !lot) return null;
    return { block: block[1].padStart(4, '0') + block[2].toUpperCase(), lot: lot[1].padStart(3, '0') + lot[2].toUpperCase() };
}

// ---- dates ----------------------------------------------------------------------------------------
// DBI's dates are Socrata floating timestamps with no zone: permit 202603026735's filed_date is
// '2026-07-22T15:53:39.000', San Francisco wall-clock time. They are read as America/Los_Angeles wall
// time, so that one is 2026-07-22T22:53:39Z (PDT, UTC-7); winter dates take the 8-hour offset. Read
// as UTC every event would land 7 or 8 hours early: a permit issued at 00:00 on 1 January would fall
// on 31 December at 16:00 Pacific, inside a market whose deadline is 2026-12-31T23:59:59-08:00. A
// midnight value (a date without a time) is the start of its Pacific day, the earliest instant the
// record allows, so a record dated on the deadline's day counts and one dated the day after does
// not. Deadlines should therefore end a Pacific day, as the market question builder writes them.
const FLOATING_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?$/;
const PACIFIC_WALL_CLOCK = new Intl.DateTimeFormat('en-US', {
    timeZone: SF_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
});

// Pacific wall time of an instant, read as if it were UTC, minus the instant: -7 h (PDT) or -8 h (PST).
function pacificOffsetMs(epochMs) {
    const parts = {};
    for (const { type, value } of PACIFIC_WALL_CLOCK.formatToParts(new Date(epochMs))) parts[type] = Number(value);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - epochMs;
}

export function pacificCivilToEpochSeconds(value) {
    const match = typeof value === 'string' ? FLOATING_TIMESTAMP.exec(value) : null;
    if (!match) throw new Error(`${JSON.stringify(value)} is not a Socrata floating timestamp (YYYY-MM-DDThh:mm:ss[.sss])`);
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(wall);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
        || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
        throw new Error(`${value} is not a real date and time`);
    }
    // The offset at the wall time read as UTC is right except within hours of a DST change; one
    // more look at the candidate instant settles those.
    const firstOffset = pacificOffsetMs(wall);
    const candidate = wall - firstOffset;
    const secondOffset = pacificOffsetMs(candidate);
    return (secondOffset === firstOffset ? candidate : wall - secondOffset) / 1000;
}

// ---- the recipe -----------------------------------------------------------------------------------

// The rule an sf-dbi-permits-v1 recipe body (or the served recipe, which adds trustedAttesters and
// hash) states, validated: { event, dateField, permitNumber | null, parcels | null, closesAt, yes }.
export function readPermitRecipe(recipeBody) {
    if (!recipeBody || typeof recipeBody !== 'object') throw new Error('recipe body must be an object');
    const { subject, verification, outcomes } = recipeBody;
    if (verification?.kind !== SF_DBI_SOURCE_ID) {
        throw new Error(`recipe verification.kind is ${JSON.stringify(verification?.kind)}; this adapter answers ${SF_DBI_SOURCE_ID} recipes only`);
    }
    if (subject?.jurisdiction !== SF_JURISDICTION) {
        throw new Error(`recipe subject.jurisdiction is ${JSON.stringify(subject?.jurisdiction)}; the DBI dataset covers ${SF_JURISDICTION} only`);
    }
    const event = subject.event;
    if (!Object.hasOwn(PERMIT_EVENT_FIELDS, event)) throw new Error(`recipe subject.event must be one of ${Object.keys(PERMIT_EVENT_FIELDS).join(', ')}`);
    if (recipeBody.eventType !== `permit_${event}`) {
        throw new Error(`recipe eventType ${JSON.stringify(recipeBody.eventType)} does not match subject.event ${event}`);
    }
    const numbered = subject.permitNumber !== undefined;
    if (numbered === (subject.anyNewConstruction !== undefined)) {
        throw new Error('recipe subject needs exactly one of permitNumber or anyNewConstruction: true');
    }
    if (numbered && !(typeof subject.permitNumber === 'string' && /^\d+$/.test(subject.permitNumber))) {
        throw new Error('recipe subject.permitNumber must be a string of digits');
    }
    if (!numbered && subject.anyNewConstruction !== true) throw new Error('recipe subject.anyNewConstruction must be true');
    if (!Array.isArray(subject.parcelIds) || !subject.parcelIds.length) throw new Error('recipe subject.parcelIds must be a non-empty array');
    const closesAt = verification.closesAt;
    if (!Number.isSafeInteger(closesAt) || closesAt <= 0) throw new Error('recipe verification.closesAt must be positive Unix seconds');
    // "Any permit" means a new one: the builder stamps the bound, and a record dated on or before
    // it is not evidence, however well it matches.
    const notBeforeAt = numbered ? null : subject.notBeforeAt;
    if (!numbered && (!Number.isSafeInteger(notBeforeAt) || notBeforeAt <= 0 || notBeforeAt >= closesAt)) {
        throw new Error('recipe subject.notBeforeAt must be positive Unix seconds before verification.closesAt');
    }
    if (typeof outcomes?.yes !== 'string' || !outcomes.yes.trim()) throw new Error('recipe outcomes.yes must be the yes text');
    return {
        event,
        dateField: PERMIT_EVENT_FIELDS[event],
        permitNumber: numbered ? subject.permitNumber : null,
        // A numbered permit is identified by its number alone, as the settlement sentence says; only
        // "any new construction" reads the parcels, so only it requires them to be block and lot ids.
        parcels: numbered ? null : subject.parcelIds.map(sfBlockLot),
        closesAt,
        notBeforeAt,
        yes: outcomes.yes
    };
}

// What to ask the dataset for this recipe: the permit by number, or every permit on the subject's blocks.
export function permitQueryForRecipe(recipeBody) {
    const recipe = readPermitRecipe(recipeBody);
    return recipe.permitNumber
        ? { permitNumber: recipe.permitNumber }
        : { blocks: [...new Set(recipe.parcels.map(parcel => parcel.block))].sort() };
}

// Where to look: the dataset resource filtered to the permit, a URL that answers with its row(s).
export function permitSourceRef(permitNumber) {
    return `${SF_DBI_RESOURCE_URL}?permit_number=${encodeURIComponent(permitNumber)}`;
}

function isNewConstruction(type) {
    return typeof type === 'string' && NEW_CONSTRUCTION_TYPES.includes(type.trim().toLowerCase());
}

function assessRow(row, recipe, lots, observedAt) {
    const permitNumber = typeof row?.permit_number === 'string' && row.permit_number ? row.permit_number : null;
    const place = rowBlockLot(row);
    const base = {
        permitNumber,
        block: place?.block ?? null,
        lot: place?.lot ?? null,
        type: row?.permit_type_definition ?? null,
        status: row?.status ?? null,
        eventTime: null,
        qualifies: false
    };
    if (!permitNumber) return { ...base, reason: 'row has no permit_number' };
    if (recipe.permitNumber) {
        if (permitNumber !== recipe.permitNumber) return { ...base, reason: `not permit ${recipe.permitNumber}` };
    } else {
        if (!isNewConstruction(row.permit_type_definition)) {
            return { ...base, reason: `permit type ${JSON.stringify(row.permit_type_definition ?? null)} is not new construction` };
        }
        if (!place || !lots.has(`${place.block}/${place.lot}`)) {
            return { ...base, reason: `block ${row.block ?? '?'} lot ${row.lot ?? '?'} is not one of the market's parcels` };
        }
    }
    const recorded = row[recipe.dateField];
    // The event time is the source's own date or nothing: a row without it is not evidence yet.
    if (recorded === undefined || recorded === null || recorded === '') return { ...base, reason: `no ${recipe.dateField}` };
    let eventTime;
    try {
        eventTime = pacificCivilToEpochSeconds(recorded);
    } catch (error) {
        throw new Error(`permit ${permitNumber}: ${recipe.dateField} ${error.message}`);
    }
    if (eventTime > recipe.closesAt) return { ...base, eventTime, reason: `${recipe.dateField} ${recorded} is after the deadline` };
    if (recipe.notBeforeAt !== null && eventTime <= recipe.notBeforeAt) {
        return { ...base, eventTime, reason: `${recipe.dateField} ${recorded} is not after the market's not-before bound` };
    }
    if (eventTime > observedAt) return { ...base, eventTime, reason: `${recipe.dateField} ${recorded} is later than the observation` };
    return { ...base, eventTime, qualifies: true, reason: `${recipe.dateField} ${recorded} is on or before the deadline` };
}

/**
 * Every row's verdict and the fact they support. `observedAt` is when the rows were read, as
 * fetchPermitRows reports it (Unix seconds); it becomes sourceObservedAt and never comes from a row.
 * The earliest qualifying event wins, ties broken by permit number, so the answer does not depend
 * on row order.
 * @returns {{ fact: null | { value: string, eventTime: number, sourceObservedAt: number, sourceRef: string },
 *             rows: object[], closesAt: number, observedAt: number }}
 */
export function assessPermitRows(recipeBody, rows, { observedAt } = {}) {
    const recipe = readPermitRecipe(recipeBody);
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) {
        throw new Error('observedAt must be the Unix seconds when the rows were read (fetchPermitRows), never a row date');
    }
    if (!Array.isArray(rows)) throw new Error('rows must be an array of DBI permit rows');
    const lots = recipe.parcels ? new Set(recipe.parcels.map(parcel => `${parcel.block}/${parcel.lot}`)) : null;
    const assessed = rows.map(row => assessRow(row, recipe, lots, observedAt));
    const [first] = assessed.filter(row => row.qualifies)
        .sort((a, b) => a.eventTime - b.eventTime || (a.permitNumber < b.permitNumber ? -1 : a.permitNumber > b.permitNumber ? 1 : 0));
    return {
        fact: first
            ? { value: recipe.yes, eventTime: first.eventTime, sourceObservedAt: observedAt, sourceRef: permitSourceRef(first.permitNumber) }
            : null,
        rows: assessed,
        closesAt: recipe.closesAt,
        observedAt
    };
}

// The fact, or null while no qualifying record exists (absence at closesAt + grace settles NO on chain).
export function evaluatePermitRecipe(recipeBody, rows, { observedAt } = {}) {
    return assessPermitRows(recipeBody, rows, { observedAt }).fact;
}

// ---- fetching -------------------------------------------------------------------------------------

function soqlText(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

// The Socrata URL for one permit number or a set of blocks, with a bounded $limit.
export function buildPermitQuery(query = {}) {
    const { permitNumber, blocks } = query;
    if ((permitNumber === undefined) === (blocks === undefined)) throw new Error('query needs exactly one of permitNumber or blocks');
    let where;
    let maxRows;
    if (permitNumber !== undefined) {
        if (typeof permitNumber !== 'string' || !/^[0-9A-Za-z]{1,20}$/.test(permitNumber)) throw new Error('permitNumber must be 1-20 letters or digits');
        where = `permit_number=${soqlText(permitNumber)}`;
        maxRows = PERMIT_ROW_LIMIT;
    } else {
        if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks must be a non-empty array');
        const unique = [...new Set(blocks.map(block => {
            if (typeof block !== 'string' || !/^\d{4}[A-Za-z]?$/.test(block)) throw new Error(`block ${JSON.stringify(block)} must be four digits and an optional letter`);
            return block.toUpperCase();
        }))].sort();
        if (unique.length > MAX_QUERY_BLOCKS) throw new Error(`at most ${MAX_QUERY_BLOCKS} blocks per query`);
        where = `block IN (${unique.map(soqlText).join(',')})`;
        maxRows = BLOCK_ROW_LIMIT;
    }
    const params = new URLSearchParams({
        $select: PERMIT_FIELDS.join(','),
        $where: where,
        $order: 'permit_number,block,lot',
        $limit: String(maxRows + 1)
    });
    return { url: `${SF_DBI_RESOURCE_URL}?${params}`, maxRows };
}

/**
 * Reads permit rows. observedAt is the response's Date header (the server's clock when it answered)
 * or, when the header is missing or unreadable, the local time the response arrived; Unix seconds
 * either way, never a row value. observedAtSource says which. lastModified is the dataset's own
 * Last-Modified header (when DBI's data was last refreshed), as sent, or null.
 * @returns {Promise<{ url: string, rows: object[], observedAt: number, observedAtSource: 'date-header'|'fetch-time',
 *                     lastModified: string|null }>}
 */
export async function fetchPermitRows(query, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
    const { url, maxRows } = buildPermitQuery(query);
    let response;
    try {
        response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    } catch (error) {
        if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new Error(`DBI permits query timed out after ${timeoutMs} ms: ${url}`);
        throw error;
    }
    const arrivedAtMs = now();
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`DBI permits query failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error('DBI permits query did not return an array of rows');
    }
    if (rows.length > maxRows) {
        throw new Error(`DBI permits query returned more than ${maxRows} rows; refusing to conclude from a cut list (narrow the query)`);
    }
    const header = response.headers?.get?.('date');
    const headerMs = header ? Date.parse(header) : Number.NaN;
    const fromHeader = Number.isFinite(headerMs);
    return {
        url,
        rows,
        observedAt: Math.floor((fromHeader ? headerMs : arrivedAtMs) / 1000),
        observedAtSource: fromHeader ? 'date-header' : 'fetch-time',
        lastModified: response.headers?.get?.('last-modified') ?? null
    };
}
