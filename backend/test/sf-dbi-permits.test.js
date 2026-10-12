// San Francisco DBI permits evidence adapter (evidence/sf-dbi-permits.js) against the byte-exact live
// capture of permit 202603026735 and synthetic variations of that row, with recipes from the real
// market question builder: Pacific dates and deadline edges, numbered and any-new-construction rules,
// the Socrata query, where observedAt comes from, and the check-permit-evidence.mjs dry run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
    BLOCK_ROW_LIMIT,
    PERMIT_FIELDS,
    PERMIT_ROW_LIMIT,
    assessPermitRows,
    buildPermitQuery,
    evaluatePermitRecipe,
    fetchPermitRows,
    pacificCivilToEpochSeconds,
    permitQueryForRecipe,
    permitSourceRef,
    sfBlockLot,
    readPermitRecipe
} from '../evidence/sf-dbi-permits.js';

const require = createRequire(import.meta.url);
const MarketQuestion = require('../../frontend/js/bets/market-question.js');

const FIXTURE = fileURLToPath(new URL('./fixtures/sf-dbi-permit-202603026735.json', import.meta.url));
const CAPTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/sf-dbi-permit-202603026735.capture.json', import.meta.url), 'utf8'));
const SCRIPT = fileURLToPath(new URL('../scripts/check-permit-evidence.mjs', import.meta.url));
const BODY = fs.readFileSync(FIXTURE);
const REAL = JSON.parse(BODY.toString('utf8'))[0];
const OBSERVED = 1791767550; // the capture's Date header: Mon, 12 Oct 2026 01:12:30 GMT
const DEADLINE = 1798790399; // 2026-12-31T23:59:59-08:00
const LATER = 1798848000; // 2027-01-02T00:00:00Z, an observation after the deadline
const PERMIT = '202603026735';
const SOURCE_REF = 'https://data.sf.gov/resource/i98e-djp9.json?permit_number=202603026735';

// The recipe body exactly as frontend/js/bets/market-question.js builds it for the lead market.
function recipe({ milestone = 'permitted', parcelIds = ['5000002'], deadline = '2026-12-31T23:59:59-08:00', ...evidence } = {}) {
    return MarketQuestion.build({
        milestone,
        subject: { jurisdiction: 'US-CA-SF', authority: 'San Francisco', label: 'Candlestick Point', parcelIds },
        deadline,
        evidence: { source: 'sf-dbi-permits-v1', ...evidence }
    }).recipeBody;
}

const issuedRecipe = () => recipe({ permitNumber: PERMIT, event: 'issued' });
const completedRecipe = () => recipe({ milestone: 'built', deadline: '2029-12-31T23:59:59-08:00', permitNumber: PERMIT, event: 'completed' });
// Any-permit recipes carry a not-before bound; the fixtures date from 2026, so the bound sits earlier.
const NOT_BEFORE = '2024-01-01T00:00:00-08:00';
const anyRecipe = (event = 'filed', parcelIds = ['US-CA-SF-4884039A', '5000002']) => recipe({ parcelIds, anyNewConstruction: true, event, notBefore: NOT_BEFORE });
const at = iso => Date.parse(iso) / 1000;

describe('the captured row', () => {
    it('is the byte-exact body of the adapter\'s own query', () => {
        expect(BODY.length).toBe(CAPTURE.bodyBytes);
        expect(createHash('sha256').update(BODY).digest('hex')).toBe(CAPTURE.bodySha256);
        expect(buildPermitQuery({ permitNumber: PERMIT }).url).toBe(CAPTURE.url);
        expect(JSON.parse(CAPTURE.headers['x-soda2-fields'])).toEqual([...PERMIT_FIELDS]);
        expect(REAL).toMatchObject({ permit_number: PERMIT, status: 'filed', block: '5000', lot: '002', filed_date: '2026-07-22T15:53:39.000' });
        expect(REAL.description).toMatch(/^candlestick area south of harney way development block grades/);
        expect(REAL).not.toHaveProperty('issued_date');
    });

    it('filed, not issued: no evidence for the issued market', () => {
        expect(evaluatePermitRecipe(issuedRecipe(), [REAL], { observedAt: OBSERVED })).toBeNull();
        const { rows } = assessPermitRows(issuedRecipe(), [REAL], { observedAt: OBSERVED });
        expect(rows).toEqual([expect.objectContaining({ permitNumber: PERMIT, block: '5000', lot: '002', qualifies: false, reason: 'no issued_date' })]);
    });

    it('is not new construction, so it does not settle an any-new-construction market either', () => {
        expect(evaluatePermitRecipe(anyRecipe('filed'), [REAL], { observedAt: OBSERVED })).toBeNull();
    });
});

describe('dates are San Francisco wall time', () => {
    it('reads floating timestamps as America/Los_Angeles, through both DST changes', () => {
        expect(pacificCivilToEpochSeconds('2026-07-22T15:53:39.000')).toBe(at('2026-07-22T22:53:39Z'));
        expect(pacificCivilToEpochSeconds('2026-12-31T00:00:00.000')).toBe(at('2026-12-31T08:00:00Z'));
        expect(pacificCivilToEpochSeconds('2026-03-08T00:00:00')).toBe(at('2026-03-08T08:00:00Z'));
        expect(pacificCivilToEpochSeconds('2026-03-08T03:00:00')).toBe(at('2026-03-08T10:00:00Z'));
        expect(pacificCivilToEpochSeconds('2026-11-01T03:00:00')).toBe(at('2026-11-01T11:00:00Z'));
    });

    it('refuses anything that is not a real floating timestamp', () => {
        for (const value of ['2026-07-22', '2026-07-22T00:00:00Z', '2026-02-30T00:00:00.000', '22/07/2026', 20260722]) {
            expect(() => pacificCivilToEpochSeconds(value)).toThrow();
        }
    });
});

describe('numbered permit markets', () => {
    const issued = issuedDate => [{ ...REAL, status: 'issued', issued_date: issuedDate }];

    it('an issued date before the deadline is YES with the source\'s own event time', () => {
        expect(evaluatePermitRecipe(issuedRecipe(), issued('2026-11-03T00:00:00.000'), { observedAt: LATER })).toEqual({
            value: 'permit 202603026735 issued on or before 2026-12-31T23:59:59-08:00',
            eventTime: at('2026-11-03T08:00:00Z'),
            sourceObservedAt: LATER,
            sourceRef: SOURCE_REF
        });
    });

    it('the deadline\'s own day counts and the next day does not, which a UTC reading would get wrong', () => {
        expect(evaluatePermitRecipe(issuedRecipe(), issued('2026-12-31T00:00:00.000'), { observedAt: LATER }))
            .toMatchObject({ eventTime: 1798704000 });
        expect(evaluatePermitRecipe(issuedRecipe(), issued('2027-01-01T00:00:00.000'), { observedAt: LATER })).toBeNull();
        // Read as UTC, 1 January 00:00 would be 1798761600, before the deadline: the bug this rule prevents.
        expect(at('2027-01-01T00:00:00Z')).toBeLessThanOrEqual(DEADLINE);
        expect(pacificCivilToEpochSeconds('2027-01-01T00:00:00.000')).toBe(DEADLINE + 1);
    });

    it('a row without the date, or with an empty one, is no evidence; a malformed one fails loudly', () => {
        for (const value of [undefined, null, '']) {
            expect(evaluatePermitRecipe(issuedRecipe(), [{ ...REAL, issued_date: value }], { observedAt: LATER })).toBeNull();
        }
        expect(() => evaluatePermitRecipe(issuedRecipe(), issued('31/12/2026'), { observedAt: LATER })).toThrow(/permit 202603026735: issued_date/);
    });

    it('a record dated after its own observation is not evidence', () => {
        const assessed = assessPermitRows(issuedRecipe(), issued('2026-11-03T00:00:00.000'), { observedAt: OBSERVED });
        expect(assessed.fact).toBeNull();
        expect(assessed.rows[0].reason).toMatch(/later than the observation/);
    });

    it('another permit\'s row is ignored, and the parcels play no part in a numbered rule', () => {
        const other = { ...REAL, permit_number: '202603026736', issued_date: '2026-11-03T00:00:00.000' };
        expect(evaluatePermitRecipe(issuedRecipe(), [other], { observedAt: LATER })).toBeNull();
        const elsewhere = recipe({ parcelIds: ['US-CA-SF-4884024'], permitNumber: PERMIT, event: 'issued' });
        expect(evaluatePermitRecipe(elsewhere, issued('2026-11-03T00:00:00.000'), { observedAt: LATER })).not.toBeNull();
    });

    it('completed reads completed_date', () => {
        const done = [{ ...REAL, status: 'complete', issued_date: '2026-11-03T00:00:00.000', completed_date: '2029-06-01T00:00:00.000' }];
        expect(evaluatePermitRecipe(completedRecipe(), done, { observedAt: at('2029-07-01T00:00:00Z') })).toEqual({
            value: 'permit 202603026735 completed on or before 2029-12-31T23:59:59-08:00',
            eventTime: at('2029-06-01T07:00:00Z'),
            sourceObservedAt: at('2029-07-01T00:00:00Z'),
            sourceRef: SOURCE_REF
        });
        expect(evaluatePermitRecipe(completedRecipe(), [{ ...done[0], completed_date: undefined }], { observedAt: at('2029-07-01T00:00:00Z') })).toBeNull();
    });

    it('sourceObservedAt is the observation passed in, never a row value, and is required', () => {
        const fact = evaluatePermitRecipe(issuedRecipe(), issued('2026-11-03T00:00:00.000'), { observedAt: LATER + 5 });
        expect(fact.sourceObservedAt).toBe(LATER + 5);
        expect(() => evaluatePermitRecipe(issuedRecipe(), [REAL], {})).toThrow(/observedAt/);
        expect(() => evaluatePermitRecipe(issuedRecipe(), [REAL], { observedAt: '2026-10-12' })).toThrow(/observedAt/);
    });
});

describe('any new construction on the parcels', () => {
    const row = (permit, fields) => ({ permit_number: permit, status: 'filed', street_name: 'Example', ...fields });
    const rows = [
        row('202611020001', { permit_type_definition: 'new construction', block: '4884', lot: '039A', filed_date: '2026-11-02T09:00:00.000' }),
        row('202610300002', { permit_type_definition: 'new construction wood frame', block: '5000', lot: '2', filed_date: '2026-10-30T10:15:00.000' }),
        row('202610010003', { permit_type_definition: 'new construction', block: '4884', lot: '040', filed_date: '2026-10-01T00:00:00.000' }),
        row('202610010004', { permit_type_definition: 'additions alterations or repairs', block: '4884', lot: '039A', filed_date: '2026-10-01T00:00:00.000' }),
        row('202612010005', { permit_type_definition: 'NEW CONSTRUCTION', block: '4884', lot: '039a', filed_date: '2026-12-01T00:00:00.000' })
    ];

    it('qualifies only new-construction rows on the subject\'s block and lot, earliest first', () => {
        const assessed = assessPermitRows(anyRecipe('filed'), rows, { observedAt: LATER });
        expect(assessed.rows.map(r => [r.permitNumber, r.qualifies])).toEqual([
            ['202611020001', true], ['202610300002', true], ['202610010003', false], ['202610010004', false], ['202612010005', true]
        ]);
        expect(assessed.rows[2].reason).toMatch(/not one of the market's parcels/);
        expect(assessed.rows[3].reason).toMatch(/not new construction/);
        expect(assessed.fact).toEqual({
            value: 'new-construction building permit filed after 2024-01-01T00:00:00-08:00 and on or before 2026-12-31T23:59:59-08:00',
            eventTime: at('2026-10-30T17:15:00Z'),
            sourceObservedAt: LATER,
            sourceRef: permitSourceRef('202610300002')
        });
        expect(evaluatePermitRecipe(anyRecipe('filed'), [...rows].reverse(), { observedAt: LATER })).toEqual(assessed.fact);
    });

    it('rows elsewhere or of another type are no evidence', () => {
        expect(evaluatePermitRecipe(anyRecipe('filed'), [rows[2], rows[3]], { observedAt: LATER })).toBeNull();
        expect(evaluatePermitRecipe(anyRecipe('filed', ['4884024']), rows, { observedAt: LATER })).toBeNull();
    });

    it('issued and completed read their own dates', () => {
        const issuedRow = { ...rows[0], issued_date: '2026-12-15T00:00:00.000' };
        expect(evaluatePermitRecipe(anyRecipe('issued'), [rows[0]], { observedAt: LATER })).toBeNull();
        expect(evaluatePermitRecipe(anyRecipe('issued'), [issuedRow], { observedAt: LATER })).toMatchObject({ eventTime: at('2026-12-15T08:00:00Z') });
        const built = recipe({ milestone: 'built', deadline: '2029-12-31T23:59:59-08:00', parcelIds: ['4884039A'], anyNewConstruction: true, event: 'completed', notBefore: NOT_BEFORE });
        expect(evaluatePermitRecipe(built, [{ ...issuedRow, completed_date: '2029-03-01T00:00:00.000' }], { observedAt: at('2029-04-01T00:00:00Z') }))
            .toMatchObject({ value: 'new-construction building permit completed after 2024-01-01T00:00:00-08:00 and on or before 2029-12-31T23:59:59-08:00', eventTime: at('2029-03-01T08:00:00Z') });
    });
});

describe('parcel id to block and lot', () => {
    it('splits a mapblklot, with or without the product prefix', () => {
        expect(sfBlockLot('4884039A')).toEqual({ block: '4884', lot: '039A' });
        expect(sfBlockLot('US-CA-SF-4884039A')).toEqual({ block: '4884', lot: '039A' });
        expect(sfBlockLot('5000002')).toEqual({ block: '5000', lot: '002' });
        expect(sfBlockLot('US-CA-SF-5000002')).toEqual({ block: REAL.block, lot: REAL.lot });
        // A letter after the fourth digit can only be a block suffix: lots start with a digit.
        expect(sfBlockLot('3708A012')).toEqual({ block: '3708A', lot: '012' });
    });

    it('refuses ids that are not a San Francisco block and lot', () => {
        for (const id of ['488403', '48840391', 'HR-335550-1/1', 'US-CA-SF-', '', null]) expect(() => sfBlockLot(id)).toThrow(/block and lot/);
        expect(() => evaluatePermitRecipe(anyRecipe('filed', ['not-a-lot']), [], { observedAt: LATER })).toThrow(/not-a-lot/);
    });
});

describe('recipe checks', () => {
    it('answers only sf-dbi-permits-v1 recipes for US-CA-SF whose event type matches', () => {
        const body = issuedRecipe();
        expect(() => evaluatePermitRecipe({ ...body, verification: { ...body.verification, kind: 'sf-legislation-v1' } }, [], { observedAt: LATER })).toThrow(/sf-dbi-permits-v1/);
        expect(() => evaluatePermitRecipe({ ...body, subject: { ...body.subject, jurisdiction: 'US-NY-NYC' } }, [], { observedAt: LATER })).toThrow(/US-CA-SF/);
        expect(() => evaluatePermitRecipe({ ...body, eventType: 'permit_filed' }, [], { observedAt: LATER })).toThrow(/eventType/);
        expect(() => evaluatePermitRecipe({ ...body, subject: { ...body.subject, anyNewConstruction: true } }, [], { observedAt: LATER })).toThrow(/exactly one/);
        expect(() => evaluatePermitRecipe({ ...body, verification: { ...body.verification, closesAt: '2026-12-31' } }, [], { observedAt: LATER })).toThrow(/closesAt/);
    });

    it('turns a recipe into the dataset query it needs', () => {
        expect(permitQueryForRecipe(issuedRecipe())).toEqual({ permitNumber: PERMIT });
        expect(permitQueryForRecipe(anyRecipe('filed', ['US-CA-SF-5000003', '4884039A', '5000002']))).toEqual({ blocks: ['4884', '5000'] });
    });
});

describe('buildPermitQuery', () => {
    it('queries one permit with a bounded limit on data.sf.gov', () => {
        const { url, maxRows } = buildPermitQuery({ permitNumber: PERMIT });
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe('https://data.sf.gov/resource/i98e-djp9.json');
        expect(parsed.searchParams.get('$where')).toBe("permit_number='202603026735'");
        expect(parsed.searchParams.get('$select')).toBe(PERMIT_FIELDS.join(','));
        expect(parsed.searchParams.get('$limit')).toBe(String(PERMIT_ROW_LIMIT + 1));
        expect(maxRows).toBe(PERMIT_ROW_LIMIT);
    });

    it('queries a set of blocks, sorted and deduplicated', () => {
        const parsed = new URL(buildPermitQuery({ blocks: ['5000', '4884', '5000', '3708a'] }).url);
        expect(parsed.searchParams.get('$where')).toBe("block IN ('3708A','4884','5000')");
        expect(parsed.searchParams.get('$limit')).toBe(String(BLOCK_ROW_LIMIT + 1));
    });

    it('refuses ambiguous or unsafe queries', () => {
        expect(() => buildPermitQuery({})).toThrow(/exactly one/);
        expect(() => buildPermitQuery({ permitNumber: PERMIT, blocks: ['5000'] })).toThrow(/exactly one/);
        expect(() => buildPermitQuery({ permitNumber: "1' OR '1'='1" })).toThrow(/permitNumber/);
        expect(() => buildPermitQuery({ blocks: [] })).toThrow(/non-empty/);
        expect(() => buildPermitQuery({ blocks: ['500'] })).toThrow(/four digits/);
        expect(() => buildPermitQuery({ blocks: Array.from({ length: 101 }, (_, i) => String(1000 + i)) })).toThrow(/at most 100/);
    });
});

describe('fetchPermitRows', () => {
    const replay = (headers = { date: CAPTURE.headers.date, 'last-modified': CAPTURE.headers['last-modified'], 'content-type': CAPTURE.headers['content-type'] }, body = BODY, status = 200) => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, init });
            return new Response(body, { status, headers });
        };
        return { calls, fetchImpl };
    };

    it('replays the capture: same URL, same rows, observedAt from the Date header', async () => {
        const { calls, fetchImpl } = replay();
        const result = await fetchPermitRows({ permitNumber: PERMIT }, { fetchImpl, now: () => 0 });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(CAPTURE.url);
        expect(calls[0].init).toMatchObject({ redirect: 'error', headers: { Accept: 'application/json' } });
        expect(result).toEqual({
            url: CAPTURE.url,
            rows: [REAL],
            observedAt: OBSERVED,
            observedAtSource: 'date-header',
            lastModified: 'Sun, 11 Oct 2026 12:45:03 GMT'
        });
        expect(evaluatePermitRecipe(issuedRecipe(), result.rows, { observedAt: result.observedAt })).toBeNull();
    });

    it('falls back to the time the response arrived when there is no usable Date header', async () => {
        for (const headers of [{ 'content-type': 'application/json' }, { date: 'not a date' }]) {
            const result = await fetchPermitRows({ permitNumber: PERMIT }, { fetchImpl: replay(headers).fetchImpl, now: () => 1791767999123 });
            expect(result).toMatchObject({ observedAt: 1791767999, observedAtSource: 'fetch-time', lastModified: null });
        }
    });

    it('fails loudly on HTTP errors, non-row bodies, cut lists and timeouts', async () => {
        await expect(fetchPermitRows({ permitNumber: PERMIT }, { fetchImpl: replay({}, '{"message":"No such column: issued_date"}', 400).fetchImpl }))
            .rejects.toThrow(/HTTP 400: .*No such column/);
        await expect(fetchPermitRows({ permitNumber: PERMIT }, { fetchImpl: replay({}, '{"rows":[]}').fetchImpl })).rejects.toThrow(/array of rows/);
        const full = JSON.stringify(Array.from({ length: PERMIT_ROW_LIMIT + 1 }, () => REAL));
        await expect(fetchPermitRows({ permitNumber: PERMIT }, { fetchImpl: replay({}, full).fetchImpl })).rejects.toThrow(/more than 50 rows/);
        const timeout = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
        await expect(fetchPermitRows({ permitNumber: PERMIT }, { fetchImpl: timeout, timeoutMs: 5 })).rejects.toThrow(/timed out after 5 ms/);
    });
});

describe('check-permit-evidence.mjs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-evidence-'));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file, JSON.stringify(value));
        return file;
    };
    const run = args => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    const served = body => ({ ...body, trustedAttesters: [{ kind: 'lens-member', address: 'x' }], hash: `sha256:${'0'.repeat(64)}` });

    it('prints usage and does nothing without parameters', () => {
        const out = run([]);
        expect(out.status).toBe(0);
        expect(out.stdout).toMatch(/^Usage:/);
        expect(out.stdout).not.toMatch(/^\[\d{4}-/m); // no timestamped line: nothing ran
    });

    it('dry-runs the captured row: no qualifying record yet', () => {
        const out = run(['--recipe', write('issued.json', issuedRecipe()), '--fixture', FIXTURE, '--observed-at', String(OBSERVED)]);
        expect(out.status).toBe(0);
        expect(out.stdout).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] recipe sf-dbi-permits-permitted-v1: permit 202603026735 issued by 2026-12-31 23:59:59 Pacific/m);
        expect(out.stdout).toContain('block 5000 lot 002 (grade or quarry or fill or excavate, filed): does not qualify; no issued_date');
        expect(out.stdout).toContain('conclusion: no qualifying record yet');
    });

    it('prints the attestation body for a served recipe with evidence, and never takes the time from a row', () => {
        const rows = write('issued-rows.json', [{ ...REAL, status: 'issued', issued_date: '2026-12-31T00:00:00.000' }]);
        const out = run(['--recipe', write('served.json', served(issuedRecipe())), '--fixture', rows, '--observed-at', '2027-01-02T00:00:00Z']);
        expect(out.status).toBe(0);
        expect(out.stdout).toContain('conclusion: evidence for YES');
        expect(JSON.parse(out.stdout.slice(out.stdout.indexOf('{')))).toEqual({
            recipeHash: `sha256:${'0'.repeat(64)}`,
            subject: `US-CA-SF|${MarketQuestion.parcelSetHash('US-CA-SF', ['5000002'])}`,
            value: 'permit 202603026735 issued on or before 2026-12-31T23:59:59-08:00',
            eventTime: 1798704000,
            sourceObservedAt: LATER,
            sourceRef: SOURCE_REF
        });
        const missing = run(['--recipe', write('served2.json', served(issuedRecipe())), '--fixture', rows]);
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain('--fixture needs --observed-at');
    });

    it('attests a 116-parcel site, because the subject is the parcel-set hash, not the ids', () => {
        const parcelIds = Array.from({ length: 116 }, (_, i) => `4884${String(i + 1).padStart(3, '0')}`);
        const rows = write('nc-rows.json', [{ permit_number: '202611020001', permit_type_definition: 'new construction', block: '4884', lot: '001', filed_date: '2026-11-02T00:00:00.000' }]);
        const body = anyRecipe('filed', parcelIds);
        const out = run(['--recipe', write('site.json', served(body)), '--fixture', rows, '--observed-at', String(LATER)]);
        expect(out.status).toBe(0);
        expect(out.stdout).not.toMatch(/WARNING/);
        const subject = MarketQuestion.subjectTextOf(body);
        expect(subject.length).toBeLessThan(90);
        expect(out.stdout).toContain(subject);
    });

    it('does not count a permit dated on or before the recipe\'s not-before bound', () => {
        const body = anyRecipe('filed');
        const bound = body.subject.notBeforeAt;
        const rows = [
            { permit_number: '1', permit_type_definition: 'new construction', block: '5000', lot: '002', filed_date: '2023-12-31T12:00:00.000' },
            { permit_number: '2', permit_type_definition: 'new construction', block: '5000', lot: '002', filed_date: '2024-01-02T12:00:00.000' }
        ];
        const verdicts = assessPermitRows(body, rows, { observedAt: bound + 10 * 86400 }).rows;
        expect(verdicts.find(v => v.permitNumber === '1').qualifies).toBe(false);
        expect(verdicts.find(v => v.permitNumber === '1').reason).toMatch(/not-before/);
        expect(verdicts.find(v => v.permitNumber === '2').qualifies).toBe(true);
        expect(() => readPermitRecipe({ ...body, subject: { ...body.subject, notBeforeAt: undefined } })).toThrow(/notBeforeAt/);
    });
});

