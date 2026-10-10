// Read-only audit (projections.md §7 and §10 M9): which stored proposals carry a city their site is
// not in. A new publication's city now follows its site (proposals/publication-city.js); before, it
// was whichever city the author's view had loaded, and the binding used that city's parcel source.
// For every record with geometry this places the site's anchor among the cities whose parcels cover
// it, by the same rule, and compares the stored city:
//   same      the stored city is where the site is
//   moved     a city on the same cadastre (a Split site filed under zagreb): only the listing differs
//   refused   only another city's cadastre covers the site, so it was bound against a source with no
//             parcels there — investigate (a correction is a reviewed fork; records are immutable)
//   no-city   no stored city, or one the app does not configure
// Records without geometry (parcel acts) are counted, not placed. Nothing is written anywhere except
// the report files.
//
//   node scripts/audit-publication-cities.mjs --help
//   PGHOST=127.0.0.1 node scripts/audit-publication-cities.mjs --db --out /tmp/cities-local.md
//   node scripts/audit-publication-cities.mjs --input rows.json --label production --out /tmp/cities-prod.md
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { bindingFrame } from '../proposals/binding.js';
import { footprintParts, hasFootprint } from '../proposals/footprint.js';
import { citiesCovering, resolvePublicationCity, SITE_IN_OTHER_CITY } from '../proposals/publication-city.js';
import { normalizeCityCode } from '../routes/proposals.js';

const USAGE = `Usage:
  node scripts/audit-publication-cities.mjs --db [--table public.proposal] [--out report.md] [--json records.json]
  node scripts/audit-publication-cities.mjs --input rows.json [--label name] [--out report.md] [--json records.json]

Rows: { id, proposal_id, city, created_at, site_geojson, proposal_data } (proposal_data as JSON).
--db reads the local database in a read-only transaction (PG* from backend/.env).`;

const log = message => console.error(`[${new Date().toISOString()}] ${message}`);
const parseJson = value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
};

// The anchor a publication of this record would be placed by: its site, else its own footprint.
function anchorOf(row) {
    const record = parseJson(row.proposal_data) || {};
    const site = parseJson(row.site_geojson) || record.site || null;
    if (site) return { anchor: bindingFrame({ site }).anchor, from: 'site' };
    const parts = footprintParts(record);
    if (parts.invalid) return { error: `invalid footprint: ${parts.invalid}` };
    if (!hasFootprint(parts)) return null;
    return { anchor: bindingFrame({ parts }).anchor, from: 'footprint' };
}

export function placeRecord(row) {
    const created = row.created_at ? new Date(row.created_at) : null;
    const out = { id: row.id, proposalId: row.proposal_id, city: row.city ?? null, month: created && Number.isFinite(created.getTime()) ? created.toISOString().slice(0, 7) : '' };
    let located;
    try {
        located = anchorOf(row);
    } catch (error) {
        return { ...out, status: 'unmeasurable', why: String(error.message || error).slice(0, 160) };
    }
    if (!located) return { ...out, status: 'no-geometry' };
    if (located.error) return { ...out, status: 'unmeasurable', why: located.error };
    const [lon, lat] = located.anchor;
    out.at = [Number(lat.toFixed(5)), Number(lon.toFixed(5))];
    out.from = located.from;
    const covering = citiesCovering({ lon, lat }).map(hit => hit.cityId);
    out.covering = covering.slice(0, 3);
    const city = normalizeCityCode(row.city);
    if (!city || city === 'city') return { ...out, status: 'no-city', placed: covering[0] || null };
    try {
        const placed = resolvePublicationCity({ city, lon, lat });
        return { ...out, status: placed === city ? 'same' : 'moved', placed };
    } catch (error) {
        if (error.code !== SITE_IN_OTHER_CITY) throw error;
        return { ...out, status: 'refused', placed: error.siteCity };
    }
}

export function buildReport(records, { label, generatedAt }) {
    const by = status => records.filter(record => record.status === status);
    const lines = [`# Publication cities — ${label}`, '', `Generated ${generatedAt}. ${records.length} records.`, ''];
    lines.push('| status | records |', '|---|---|');
    for (const status of ['same', 'moved', 'refused', 'no-city', 'no-geometry', 'unmeasurable']) lines.push(`| ${status} | ${by(status).length} |`);
    lines.push('');
    const pairs = list => {
        const counts = new Map();
        list.forEach(record => { const key = `${record.city ?? '∅'} → ${record.placed ?? '∅'}`; counts.set(key, (counts.get(key) || 0) + 1); });
        return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([pair, n]) => `- ${pair}: ${n}`);
    };
    lines.push('## Refused: only another city\'s cadastre covers the site', '');
    lines.push(...(by('refused').length ? pairs(by('refused')) : ['None.']), '');
    by('refused').forEach(record => lines.push(`- ${record.id} (${record.proposalId}) ${record.city} at ${record.at.join(',')} → ${record.placed}, ${record.month}`));
    lines.push('', '## Moved: a city on the same cadastre', '');
    lines.push(...(by('moved').length ? pairs(by('moved')) : ['None.']), '');
    lines.push('## No city', '');
    lines.push(...(by('no-city').length ? pairs(by('no-city')) : ['None.']), '');
    if (by('unmeasurable').length) {
        lines.push('## Unmeasurable', '');
        by('unmeasurable').forEach(record => lines.push(`- ${record.id} (${record.proposalId}): ${record.why}`));
        lines.push('');
    }
    return lines.join('\n');
}

function parseArgs(argv) {
    const args = { table: 'public.proposal' };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
            i += 1;
            return next;
        };
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--db') args.db = true;
        else if (arg === '--input') args.input = value();
        else if (arg === '--table') args.table = value();
        else if (arg === '--label') args.label = value();
        else if (arg === '--out') args.out = value();
        else if (arg === '--json') args.json = value();
        else throw new Error(`unknown argument ${arg}`);
    }
    return args;
}

async function readRowsFromDb(table) {
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`--table must be schema.table, got ${table}`);
    dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
    const client = new pg.Client({ options: '-c default_transaction_read_only=on' });
    await client.connect();
    try {
        const { rows } = await client.query(`SELECT id, proposal_id, city, created_at, ST_AsGeoJSON(site) AS site_geojson, proposal_data
            FROM ${table} ORDER BY id`);
        return { rows, source: `${table} on ${client.host}:${client.port}/${client.database}` };
    } finally {
        await client.end();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.db && !args.input)) { console.log(USAGE); return; }
    if (args.db && args.input) throw new Error('use either --db or --input, not both');
    const { rows, source } = args.db
        ? await readRowsFromDb(args.table)
        : { rows: JSON.parse(readFileSync(args.input, 'utf8')), source: `rows exported to ${args.input}` };
    if (!Array.isArray(rows)) throw new Error('the input must be a JSON array of rows');
    log(`read ${rows.length} rows from ${source}`);
    const started = Date.now();
    const records = rows.map((row, index) => {
        const record = placeRecord(row);
        const done = index + 1;
        if (done % 200 === 0 || done === rows.length) {
            const elapsed = (Date.now() - started) / 1000;
            log(`${done}/${rows.length} records · ${Math.round(done / rows.length * 100)} % · ETA ${Math.round(elapsed / done * (rows.length - done))} s`);
        }
        return record;
    });
    const counts = ['same', 'moved', 'refused', 'no-city', 'no-geometry', 'unmeasurable'].map(status => `${status} ${records.filter(r => r.status === status).length}`).join(', ');
    log(counts);
    const report = buildReport(records, { label: args.label || source, generatedAt: new Date().toISOString() });
    if (args.out) { writeFileSync(args.out, report); log(`report written to ${args.out}`); } else { console.log(report); }
    if (args.json) { writeFileSync(args.json, JSON.stringify(records, null, 1)); log(`records written to ${args.json}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
}
