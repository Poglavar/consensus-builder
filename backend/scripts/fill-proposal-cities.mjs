// Fills in the city of every proposal that has none the app knows (null, the old placeholder 'city',
// an unconfigured id), from its own site, by the rule a new publication follows
// (proposals/publication-city.js): the nearest city whose parcels cover the site's anchor, else
// 'explore' (no app cadastre there). A record with no geometry is placed by its parcels when they
// are Croatian (the parcel table gives their location); one that cannot be placed is listed, never
// guessed. Without a known city a record opened in any city's store (projections.md §10 M8).
//
// Dry run by default (read-only transaction); --apply writes `city` and proposal_data.city in one
// transaction. Idempotent: a second run finds nothing to fill.
//
//   PGHOST=127.0.0.1 node scripts/fill-proposal-cities.mjs                 # dry run, local
//   PGHOST=127.0.0.1 node scripts/fill-proposal-cities.mjs --apply
//   node scripts/fill-proposal-cities.mjs --table consensus.proposal       # production layout
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { bindingFrame } from '../proposals/binding.js';
import { footprintParts, hasFootprint } from '../proposals/footprint.js';
import { citiesCovering } from '../proposals/publication-city.js';

const requireCjs = createRequire(import.meta.url);
const coverage = requireCjs('../../frontend/data/world-coverage.json');
export const KNOWN_CITIES = new Set([...coverage.liveCities.map(city => city.id), 'explore']);

const USAGE = `Usage: node scripts/fill-proposal-cities.mjs [--apply] [--table public.proposal]
Fills a known city into every proposal that has none, from its site. Dry run unless --apply.`;
const log = message => console.error(`[${new Date().toISOString()}] ${message}`);
const parseJson = value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return null; }
};

export const hasKnownCity = city => typeof city === 'string' && KNOWN_CITIES.has(city);

// The city a record's own geometry places it in: { city, from } or { why } when it cannot be placed.
// `parcelLocation(ids)` answers [lon, lat] for Croatian parcel ids (the parcel table), or null.
export async function placeByGeometry(row, parcelLocation) {
    const record = parseJson(row.proposal_data) || {};
    const site = parseJson(row.site_geojson) || record.site || null;
    let anchor = null;
    let from = null;
    try {
        if (site) { anchor = bindingFrame({ site }).anchor; from = 'site'; }
        else {
            const parts = footprintParts(record);
            if (!parts.invalid && hasFootprint(parts)) { anchor = bindingFrame({ parts }).anchor; from = 'footprint'; }
        }
    } catch (error) {
        return { why: `unmeasurable: ${String(error.message || error).slice(0, 120)}` };
    }
    if (!anchor) {
        const ids = (Array.isArray(record.cadastreParcelIds) ? record.cadastreParcelIds : []).map(String);
        if (!ids.length) return { why: 'no geometry and no parcels' };
        anchor = await parcelLocation(ids);
        from = 'parcels';
        if (!anchor) return { why: `no geometry, and parcels ${ids.slice(0, 3).join(', ')} cannot be located` };
    }
    const [lon, lat] = anchor;
    const covering = citiesCovering({ lon, lat });
    return { city: covering[0]?.cityId || 'explore', from, at: [lat, lon] };
}

function parseArgs(argv) {
    const args = { table: 'public.proposal', apply: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg === '--table') { args.table = argv[i + 1]; i += 1; }
        else throw new Error(`unknown argument ${arg}`);
    }
    if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(args.table || '')) throw new Error(`--table must be schema.table, got ${args.table}`);
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(USAGE); return; }
    dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
    const client = new pg.Client();
    await client.connect();
    try {
        await client.query(args.apply ? 'BEGIN' : 'BEGIN READ ONLY');
        const { rows } = await client.query(`SELECT id, proposal_id, city, ST_AsGeoJSON(site) AS site_geojson, proposal_data FROM ${args.table} ORDER BY id`);
        const missing = rows.filter(row => !hasKnownCity(row.city));
        log(`${rows.length} proposals in ${args.table} on ${client.host}:${client.port}/${client.database}; ${missing.length} without a known city`);
        // Croatian parcels are located by the countrywide parcel table (dataset I/O in its own CRS).
        const parcelLocation = async ids => {
            const hr = ids.map(id => /^HR-(\d+)-(.+)$/.exec(id)).find(Boolean);
            if (!hr) return null;
            const { rows: found } = await client.query(`SELECT ST_X(c) AS lon, ST_Y(c) AS lat FROM (
                SELECT ST_Transform(ST_PointOnSurface(geom), 4326) AS c FROM parcel
                WHERE current AND maticni_broj_ko = $1 AND broj_cestice = $2 LIMIT 1) x`, [Number(hr[1]), hr[2]]);
            return found[0] ? [Number(found[0].lon), Number(found[0].lat)] : null;
        };
        let filled = 0;
        const unplaced = [];
        for (const [index, row] of missing.entries()) {
            const placed = await placeByGeometry(row, parcelLocation);
            if (!placed.city) { unplaced.push(`${row.id} (${row.proposal_id}): ${placed.why}`); continue; }
            log(`${index + 1}/${missing.length} ${row.id} (${row.proposal_id}) ${row.city ?? '∅'} → ${placed.city} (by ${placed.from}${placed.at ? ` at ${placed.at.map(v => v.toFixed(5)).join(',')}` : ''})`);
            if (args.apply) {
                await client.query(`UPDATE ${args.table}
                    SET city = $2::text, proposal_data = jsonb_set(coalesce(proposal_data, '{}'::jsonb), '{city}', to_jsonb($2::text)), updated_at = now()
                    WHERE id = $1 AND city IS NOT DISTINCT FROM $3::text`, [row.id, placed.city, row.city]);
            }
            filled += 1;
        }
        unplaced.forEach(line => log(`not placed: ${line}`));
        await client.query(args.apply ? 'COMMIT' : 'ROLLBACK');
        log(`${args.apply ? 'filled' : 'would fill'} ${filled}; not placed ${unplaced.length}${args.apply ? '' : ' (dry run: nothing written)'}`);
        if (unplaced.length) process.exitCode = 2;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        await client.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exit(1); });
}
